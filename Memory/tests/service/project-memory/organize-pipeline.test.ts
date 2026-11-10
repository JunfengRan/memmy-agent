import { afterEach, describe, expect, it } from "vitest";
import { SqliteProjectMemoryStore } from "../../../src/service/project-memory/store/sqlite/sqlite-store.js";
import { call, combinedStages, createProjectMemoryHarness, drain, emptyReply, setupSpace, stubStages, type OrganizePayload } from "./helpers.js";

const harness = createProjectMemoryHarness();
afterEach(() => harness.cleanup());

function newTopicReply(payload: OrganizePayload, content: string): Record<string, unknown> {
  return {
    ...emptyReply(),
    drafts: [{
      kind: "decision",
      content,
      message_idx: 0,
      user_ids: [payload.messages[0]!.user_id],
      topic: { new_topic: "n1" },
      same_question_as: null
    }],
    new_topics: [{ ref: "n1", topic_name: "推送服务重试", topic_summary: "推送失败后的重试策略", topic_description: "" }]
  };
}

function existingTopicReply(payload: OrganizePayload, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const topic = payload.candidate_topics[0];
  if (!topic) {
    const created = newTopicReply(payload, content);
    const drafts = created.drafts as Array<Record<string, unknown>>;
    return { ...created, drafts: [{ ...drafts[0], ...extra }] };
  }
  return {
    ...emptyReply(),
    drafts: [{
      kind: "decision",
      content,
      message_idx: 0,
      user_ids: [payload.messages[0]!.user_id],
      topic: { topic_id: topic.topic_id },
      same_question_as: topic.decisions[0]?.id ?? null,
      ...extra
    }]
  };
}

function topicIds(payload: Record<string, unknown> | undefined): string[] {
  const candidates = payload?.candidates;
  return Array.isArray(candidates) ? candidates.map((topic) => String((topic as { topic_id?: string }).topic_id ?? "")) : [];
}

function message(user: string, time: string, content: string) {
  return { role: "user", role_id: user, role_name: user, chat_time: time, content };
}

async function add(service: Parameters<typeof call>[0], body: Record<string, unknown>) {
  const accepted = await call(service, "add/message", { agent_id: "codex", allow_memory_view: ["project"], ...body });
  expect(accepted.code, JSON.stringify(accepted)).toBe(0);
  return accepted.data.task_id as string;
}

describe("project memory organize pipeline", () => {
  it("processes one space serially so a later batch sees the topic an earlier batch created", async () => {
    const stub = stubStages(combinedStages((payload, batch) => batch === 1
      ? newTopicReply(payload, "推送失败后指数退避重试三次。")
      : existingTopicReply(payload, "推送失败后改为重试五次。")));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");

    const first = await add(service, { user_id: "user_a", conversation_id: "c1", space_ids: ["space_a"], messages: [message("user_a", "2026-10-29 10:00:00", "推送失败就指数退避重试三次。")] });
    const second = await add(service, { user_id: "user_b", conversation_id: "c2", space_ids: ["space_a"], messages: [message("user_b", "2026-10-29 11:00:00", "推送失败改成重试五次吧。")] });

    const jobs = db.db.prepare(
      `SELECT scope_key, scope_seq FROM evolution_jobs WHERE job_type = 'project_memory_organize' ORDER BY scope_seq`
    ).all();
    expect(jobs).toEqual([
      { scope_key: "project_memory:space_a", scope_seq: 1 },
      { scope_key: "project_memory:space_a", scope_seq: 2 }
    ]);

    await drain(service);
    expect(stub.extract).toHaveLength(2);
    expect(stub.assign).toHaveLength(2);
    expect(stub.judge).toHaveLength(1);
    expect(stub.assign[0]!.candidates).toEqual([]);
    expect((stub.assign[1]!.candidates as Array<{ topic_summary: string }>).map((topic) => topic.topic_summary)).toEqual(["推送失败后的重试策略"]);

    for (const taskId of [first, second]) {
      expect((await call(service, "get/status", { task_id: taskId })).data.status).toBe("completed");
    }
    const listed = await call(service, "get/memory", { space_id: "space_a" });
    expect(listed.data.total).toBe(1);
    expect(listed.data.topic_detail_list[0].decisions[0]).toMatchObject({
      content: "推送失败后指数退避重试三次。",
      conflicts: [{ content: "推送失败后改为重试五次。", user_ids: ["user_b"] }]
    });
  });

  it("fans one request out to each space and reports progress per space", async () => {
    stubStages(combinedStages((payload) => newTopicReply(payload, "推送失败后指数退避重试三次。")));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    await setupSpace(service, "space_b");
    const taskId = await add(service, { user_id: "user_a", conversation_id: "c1", space_ids: ["space_a", "space_b"], messages: [message("user_a", "2026-10-29 10:00:00", "推送失败就指数退避重试三次。")] });

    const pending = await call(service, "get/status", { task_id: taskId });
    expect(pending.data.status).toMatch(/^(pending|running)$/);
    await drain(service);
    const done = await call(service, "get/status", { task_id: taskId });
    expect(done.data).toMatchObject({ status: "completed", memory_views: { added: 2, updated: 0, deleted: 0 } });
    expect(done.data.memory_views.project.memory_ids).toHaveLength(2);
  });

  it("re-merges against fresh data after a concurrent write instead of replaying", async () => {
    let concurrentStore: SqliteProjectMemoryStore | null = null;
    let conflicted = false;
    const stub = stubStages(combinedStages((payload, batch) => {
      if (batch === 1) return newTopicReply(payload, "推送失败后指数退避重试三次。");
      const topic = payload.candidate_topics[0];
      const decisions = topic?.decisions ?? [];
      // Fire only on the first judge of batch 2: after recall and the full read,
      // before our commit. Extract would make recall see the new revision;
      // the retry judge would conflict again.
      if (topic && decisions.length > 0 && !conflicted) {
        conflicted = true;
        const decisionId = topic.decisions[0]!.id;
        void concurrentStore!.getTopicsFull("space_a", [topic.topic_id]).then(([snapshot]) => concurrentStore!.commitChangeSet({
        spaceId: "space_a",
        taskId: "other",
        sourceBatchId: "other",
        idempotencyKey: "other",
        topics: [{
          op: "update",
          topicId: topic.topic_id,
          domain: topic.domain,
          expectedRevision: snapshot!.revision,
          decisions: [{ op: "conflict_append", decisionId, content: "推送失败后直接丢弃。", time: "2026-10-29T10:30:00+08:00", userIds: ["user_x"] }],
          experiences: [],
          timelineAppend: [],
          sourcesAppend: []
        }]
      }, { acceptedAt: new Date().toISOString() }));
      }
      return existingTopicReply(payload, "推送失败后改为重试五次。");
    }));
    const { service, db } = harness.createService();
    concurrentStore = new SqliteProjectMemoryStore({ db: db.db });
    await setupSpace(service, "space_a");

    await add(service, { user_id: "user_a", conversation_id: "c1", space_ids: ["space_a"], messages: [message("user_a", "2026-10-29 10:00:00", "推送失败就指数退避重试三次。")] });
    await drain(service);
    expect(stub.extract).toHaveLength(1);
    expect(stub.assign).toHaveLength(1);
    expect(stub.judge).toHaveLength(0);
    const taskId = await add(service, { user_id: "user_b", conversation_id: "c2", space_ids: ["space_a"], messages: [message("user_b", "2026-10-29 11:00:00", "推送失败改成重试五次吧。")] });
    await drain(service);

    expect((await call(service, "get/status", { task_id: taskId })).data.status).toBe("completed");
    expect(stub.extract).toHaveLength(2);
    expect(stub.assign).toHaveLength(2);
    expect(stub.judge).toHaveLength(2);
    const listed = await call(service, "get/memory", { space_id: "space_a" });
    const decision = listed.data.topic_detail_list[0].decisions[0];
    expect(decision.conflicts.map((item: { user_ids: string[] }) => item.user_ids)).toEqual([["user_x"], ["user_b"]]);  });

  it("defers drafts it cannot place instead of creating a conservative new topic", async () => {
    stubStages(combinedStages(() => ({
      ...emptyReply(),
      drafts: [{ kind: "decision", content: "推送失败后指数退避重试三次。", message_idx: 0, user_ids: ["user_a"], topic: { topic_id: "topic_does_not_exist" } }]
    })));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    const taskId = await add(service, { user_id: "user_a", conversation_id: "c1", space_ids: ["space_a"], messages: [message("user_a", "2026-10-29 10:00:00", "推送失败就指数退避重试三次。")] });
    await drain(service);

    const status = await call(service, "get/status", { task_id: taskId });
    expect(status.data).toMatchObject({ status: "completed", memory_views: { added: 0, project: { memory_ids: [], deferred_count: 1 } } });
    expect((await call(service, "get/memory", { space_id: "space_a" })).data.total).toBe(0);
  });

  it("fails the task without writing anything when the model call fails", async () => {
    stubStages(combinedStages(() => { throw new Error("model down"); }));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    const taskId = await add(service, { user_id: "user_a", conversation_id: "c1", space_ids: ["space_a"], messages: [message("user_a", "2026-10-29 10:00:00", "推送失败就指数退避重试三次。")] });
    await drain(service);

    const status = await call(service, "get/status", { task_id: taskId });
    expect(status.data.status).toBe("failed");
    expect(status.data.error).toMatchObject({ reason: "MODEL_CALL_FAILED" });
    expect((await call(service, "get/memory", { space_id: "space_a" })).data.total).toBe(0);
  });

  it("organizes messages again for another space after they were stored for the first", async () => {
    stubStages(combinedStages((payload) => newTopicReply(payload, "推送失败后指数退避重试三次。")));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    await setupSpace(service, "space_b");
    const turn = message("user_a", "2026-10-29 10:00:00", "推送失败就指数退避重试三次。");
    await add(service, { user_id: "user_a", conversation_id: "c1", space_ids: ["space_a"], messages: [turn] });
    await drain(service);
    const second = await add(service, { user_id: "user_a", conversation_id: "c1", space_ids: ["space_b"], messages: [turn] });
    await drain(service);

    const status = await call(service, "get/status", { task_id: second });
    expect(status.data).toMatchObject({ status: "completed", memory_views: { added: 1 } });
    expect((await call(service, "get/memory", { space_id: "space_b" })).data.total).toBe(1);
  });

  it("shows topics another writer created to the model on the retry after TOPIC_SET_CHANGED", async () => {
    let concurrentStore: SqliteProjectMemoryStore | null = null;
    let concurrentTopicId: string | null = null;
    let concurrentCreated = false;
    // Eleven topics that match the batch lexically, so a topic created concurrently with
    // unrelated wording would rank outside topic_k=10 on recall alone.
    const seedTexts = Array.from({ length: 11 }, (_, index) => `推送通道 ${index} 失败后重试。`);
    const stub = stubStages(combinedStages((payload, batch) => {
      if (batch <= seedTexts.length) return newTopicReply(payload, seedTexts[batch - 1]!);
      const topic = payload.candidate_topics[0];
      const assigning = payload.candidate_topics.length > 0 && (topic?.decisions.length ?? 0) === 0;
      if (assigning && !concurrentCreated) {
        concurrentCreated = true;
        void concurrentStore!.commitChangeSet({
          spaceId: "space_a",
          taskId: "other",
          sourceBatchId: "other",
          idempotencyKey: "other",
          topics: [{
            op: "create",
            topicId: "topic_concurrent",
            domain: "代码开发",
            expectedTopicSeq: seedTexts.length,
            topicName: "账单导出",
            topicSummary: "为账单导出约定文件格式",
            topicDescription: "",
            decisions: [{ op: "add", decisionId: "dec_concurrent", content: "账单导出为 CSV。", time: "2026-10-29T10:30:00+08:00", userIds: ["user_x"] }],
            experiences: [],
            timelineAppend: [],
            sourcesAppend: []
          }]
        }, { acceptedAt: new Date().toISOString() }).then(() => { concurrentTopicId = "topic_concurrent"; });
      }
      return newTopicReply(payload, "推送失败后改为重试五次。");
    }));
    const { service, db } = harness.createService();
    concurrentStore = new SqliteProjectMemoryStore({ db: db.db });
    await setupSpace(service, "space_a");
    for (const [index, text] of seedTexts.entries()) {
      await add(service, { user_id: "user_a", conversation_id: `seed${index}`, space_ids: ["space_a"], messages: [message("user_a", `2026-10-28 0${Math.floor(index / 6)}:${String(index % 6)}0:00`, text)] });
      await drain(service);
    }
    const taskId = await add(service, { user_id: "user_b", conversation_id: "c2", space_ids: ["space_a"], messages: [message("user_b", "2026-10-29 11:00:00", "推送失败改成重试五次吧。")] });
    await drain(service);

    expect(concurrentTopicId).toBe("topic_concurrent");
    expect((await call(service, "get/status", { task_id: taskId })).data.status).toBe("completed");
    expect(stub.extract).toHaveLength(seedTexts.length + 1);
    expect(stub.assign).toHaveLength(seedTexts.length + 2);
    expect(stub.judge).toHaveLength(0);
    expect(topicIds(stub.assign.at(-1))).toContain("topic_concurrent");
  });

  it("keeps a non-author's different conclusion in conflicts even when the model names the author", async () => {
    stubStages(combinedStages((payload, batch) => batch === 1
      ? newTopicReply(payload, "推送失败后指数退避重试三次。")
      // The model wrongly credits user_b's message to user_a, the content author.
      : existingTopicReply(payload, "推送失败后改为重试五次。", { user_ids: ["user_a"] })));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    await add(service, { user_id: "user_a", conversation_id: "c1", space_ids: ["space_a"], messages: [message("user_a", "2026-10-29 10:00:00", "推送失败就指数退避重试三次。")] });
    await drain(service);
    // Same conversation, so user_a is a participant and the old participant filter kept the claim.
    await add(service, { user_id: "user_b", conversation_id: "c1", space_ids: ["space_a"], messages: [message("user_b", "2026-10-29 11:00:00", "推送失败改成重试五次吧。")] });
    await drain(service);

    const decision = (await call(service, "get/memory", { space_id: "space_a" })).data.topic_detail_list[0].decisions[0];
    expect(decision.content).toBe("推送失败后指数退避重试三次。");
    expect(decision.user_ids).toEqual(["user_a"]);
    expect(decision.conflicts).toEqual([expect.objectContaining({ content: "推送失败后改为重试五次。", user_ids: ["user_b"] })]);
  });
});


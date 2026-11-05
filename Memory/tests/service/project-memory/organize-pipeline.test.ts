import { afterEach, describe, expect, it } from "vitest";
import { SqliteProjectMemoryStore } from "../../../src/service/project-memory/store/sqlite/sqlite-store.js";
import { call, createProjectMemoryHarness, drain, emptyReply, setupSpace, stubModel, type OrganizePayload } from "./helpers.js";

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
  const topic = payload.candidate_topics[0]!;
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
    const stub = stubModel((payload, index) => index === 1
      ? newTopicReply(payload, "推送失败后指数退避重试三次。")
      : existingTopicReply(payload, "推送失败后改为重试五次。"));
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
    expect(stub.organizeCalls).toHaveLength(2);
    expect(stub.organizeCalls[0]!.candidate_topics).toEqual([]);
    expect(stub.organizeCalls[1]!.candidate_topics.map((topic) => topic.topic_summary)).toEqual(["推送失败后的重试策略"]);

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
    stubModel((payload) => newTopicReply(payload, "推送失败后指数退避重试三次。"));
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
    const stub = stubModel((payload, index) => {
      if (index === 1) return newTopicReply(payload, "推送失败后指数退避重试三次。");
      // Another writer lands between this batch's recall and its commit.
      const topic = payload.candidate_topics[0]!;
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
          decisions: [{ op: "conflict_append", decisionId: topic.decisions[0]!.id, content: "推送失败后直接丢弃。", time: "2026-10-29T10:30:00+08:00", userIds: ["user_x"] }],
          experiences: [],
          timelineAppend: [],
          sourcesAppend: []
        }]
      }, { acceptedAt: new Date().toISOString() }));
      return existingTopicReply(payload, "推送失败后改为重试五次。");
    });
    const { service, db } = harness.createService();
    concurrentStore = new SqliteProjectMemoryStore({ db: db.db });
    await setupSpace(service, "space_a");

    await add(service, { user_id: "user_a", conversation_id: "c1", space_ids: ["space_a"], messages: [message("user_a", "2026-10-29 10:00:00", "推送失败就指数退避重试三次。")] });
    await drain(service);
    const taskId = await add(service, { user_id: "user_b", conversation_id: "c2", space_ids: ["space_a"], messages: [message("user_b", "2026-10-29 11:00:00", "推送失败改成重试五次吧。")] });
    await drain(service);

    expect((await call(service, "get/status", { task_id: taskId })).data.status).toBe("completed");
    expect(stub.organizeCalls).toHaveLength(2);
    const listed = await call(service, "get/memory", { space_id: "space_a" });
    const decision = listed.data.topic_detail_list[0].decisions[0];
    expect(decision.conflicts.map((item: { user_ids: string[] }) => item.user_ids)).toEqual([["user_x"], ["user_b"]]);  });

  it("defers drafts it cannot place instead of creating a conservative new topic", async () => {
    stubModel(() => ({
      ...emptyReply(),
      drafts: [{ kind: "decision", content: "推送失败后指数退避重试三次。", message_idx: 0, user_ids: ["user_a"], topic: { topic_id: "topic_does_not_exist" } }]
    }));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    const taskId = await add(service, { user_id: "user_a", conversation_id: "c1", space_ids: ["space_a"], messages: [message("user_a", "2026-10-29 10:00:00", "推送失败就指数退避重试三次。")] });
    await drain(service);

    const status = await call(service, "get/status", { task_id: taskId });
    expect(status.data).toMatchObject({ status: "completed", memory_views: { added: 0, project: { memory_ids: [], deferred_count: 1 } } });
    expect((await call(service, "get/memory", { space_id: "space_a" })).data.total).toBe(0);
  });

  it("fails the task without writing anything when the model call fails", async () => {
    stubModel(() => { throw new Error("model down"); });
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    const taskId = await add(service, { user_id: "user_a", conversation_id: "c1", space_ids: ["space_a"], messages: [message("user_a", "2026-10-29 10:00:00", "推送失败就指数退避重试三次。")] });
    await drain(service);

    const status = await call(service, "get/status", { task_id: taskId });
    expect(status.data.status).toBe("failed");
    expect(status.data.error).toMatchObject({ reason: "MODEL_CALL_FAILED" });
    expect((await call(service, "get/memory", { space_id: "space_a" })).data.total).toBe(0);
  });
});

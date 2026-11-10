import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteProjectMemoryStore } from "../../../src/service/project-memory/store/sqlite/sqlite-store.js";
import {
  call,
  combinedStages,
  createProjectMemoryHarness,
  drain,
  emptyReply,
  setupSpace,
  stubStages,
  type OrganizePayload
} from "./helpers.js";

const harness = createProjectMemoryHarness();
afterEach(() => harness.cleanup());

const TRIPLE = "推送失败后指数退避重试三次。";
const FIVE = "推送失败后改为重试五次。";
const STOP = "推送失败后直接停掉。";
const ALARM = "推送失败后的告警要单独计数。";
const HELD = "推送的上限同样设为 20。";
const CLUE = "说的是推送失败的重试上限。";
const KEPT = "推送失败的重试上限同样设为 20。";

type Service = Parameters<typeof call>[0];

function user(id: string, name: string, time: string, content: string) {
  return { role: "user", role_id: id, role_name: name, chat_time: time, content };
}

function assistant(time: string, content: string) {
  return { role: "assistant", chat_time: time, content };
}

function topicShell(name: string, summary: string) {
  return [{ ref: "n1", topic_name: name, topic_summary: summary, topic_description: "" }];
}

/** Draft content follows the message. Placement is filled in once candidates exist. */
function decisionReply(payload: OrganizePayload, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const topic = payload.candidate_topics[0];
  const speaker = payload.messages[0]?.user_id ?? "user_a";
  const draft = {
    kind: "decision",
    content,
    message_idx: 0,
    user_ids: [speaker],
    ...extra
  };
  if (!topic?.topic_id) {
    return {
      ...emptyReply(),
      drafts: [{ ...draft, topic: { new_topic: "n1" } }],
      new_topics: topicShell("推送服务重试", "推送失败后的重试策略")
    };
  }
  return {
    ...emptyReply(),
    drafts: [{
      ...draft,
      topic: { topic_id: topic.topic_id },
      same_question_as: topic.decisions[0]?.id ?? extra.same_question_as ?? null
    }]
  };
}

async function add(service: Service, body: Record<string, unknown>) {
  const accepted = await call(service, "add/message", {
    agent_id: "codex",
    allow_memory_view: ["project"],
    ...body
  });
  expect(accepted.code, JSON.stringify(accepted)).toBe(0);
  return accepted.data.task_id as string;
}

async function decisions(service: Service, spaceId = "space_a") {
  const listed = await call(service, "get/memory", { space_id: spaceId });
  return listed.data.topic_detail_list.flatMap((topic: { decisions: unknown[] }) => topic.decisions) as Array<{
    content: string;
    user_ids: string[];
    conflicts?: Array<{ content: string; user_ids: string[] }>;
    history?: Array<{ content: string; reason: string | null; user_ids: string[] }>;
  }>;
}

function droppedOf(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, taskId: string, spaceId = "space_a") {
  const row = db.prepare(`SELECT progress_json FROM pm_tasks WHERE task_id = ?`).get(taskId) as { progress_json: string };
  const progress = JSON.parse(row.progress_json) as Record<string, { details?: { dropped: Array<{ reason: string; text: string | null }> } }>;
  return progress[spaceId]?.details?.dropped ?? [];
}

function batchHash(turns: Array<{ role: string; chat_time: string; content: string }>): string {
  const hash = createHash("sha256");
  for (const turn of turns) hash.update(`${turn.role}\u0000${turn.chat_time}\u0000${turn.content}\u0001`);
  return hash.digest("hex").slice(0, 24);
}

describe("restatement filter in the organize job", () => {
  it("drops an assistant restatement of another member's conflict and does not move members", async () => {
    const stub = stubStages(combinedStages((payload) => {
      const assistantIdx = payload.messages.findIndex((message) => message.role === "assistant");
      if (assistantIdx >= 0) {
        const topic = payload.candidate_topics[0];
        return {
          ...emptyReply(),
          drafts: [{
            kind: "decision",
            content: FIVE,
            message_idx: assistantIdx,
            user_ids: ["user_a"],
            ...(topic?.topic_id
              ? { topic: { topic_id: topic.topic_id }, same_question_as: topic.decisions[0]?.id ?? null }
              : { topic: { new_topic: "n1" } })
          }],
          ...(topic?.topic_id ? {} : { new_topics: topicShell("推送服务重试", "推送失败后的重试策略") })
        };
      }
      return decisionReply(payload, payload.messages[0]?.content === FIVE ? FIVE : TRIPLE);
    }));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c-seed",
      space_ids: ["space_a"],
      messages: [user("user_a", "用户A", "2026-10-29 10:00:00", TRIPLE)]
    });
    await drain(service);
    await add(service, {
      user_id: "user_b",
      conversation_id: "c-seed",
      space_ids: ["space_a"],
      messages: [user("user_b", "用户B", "2026-10-29 11:00:00", FIVE)]
    });
    await drain(service);

    const searched = await call(service, "search/memory", {
      user_id: "user_a",
      query: "推送失败以后怎么重试",
      conversation_id: "conv-push",
      space_ids: ["space_a"],
      include_memory_view: ["project"]
    });
    expect(searched.code).toBe(0);
    expect(searched.data.topic_detail_list[0].decisions[0].conflicts).toHaveLength(1);
    const before = stub.extract.length;
    const assigns = stub.assign.length;

    const taskId = await add(service, {
      user_id: "user_a",
      conversation_id: "conv-push",
      space_ids: ["space_a"],
      messages: [
        user("user_a", "用户A", "2026-10-29 12:00:00", "把推送的结论核对一下。"),
        assistant("2026-10-29 12:01:00", FIVE)
      ]
    });
    await drain(service);

    expect(stub.extract.length - before).toBe(1);
    const recalled = stub.extract.at(-1)!.recalled as Array<{ ref: string; text: string }>;
    expect(recalled.some((entry) => entry.ref.startsWith("conflict:") && entry.text === FIVE)).toBe(true);
    expect(stub.assign.length).toBe(assigns);
    expect(droppedOf(db.db, taskId)).toEqual(expect.arrayContaining([{ reason: "restatement", text: FIVE }]));
    const [decision] = await decisions(service);
    expect(decision!.content).toBe(TRIPLE);
    expect(decision!.user_ids).toEqual(["user_a"]);
    expect(decision!.conflicts).toEqual([expect.objectContaining({ content: FIVE, user_ids: ["user_b"] })]);
  });

  it("merges the same assistant draft when this conversation has not searched", async () => {
    stubStages(combinedStages((payload) => {
      const assistantIdx = payload.messages.findIndex((message) => message.role === "assistant");
      if (assistantIdx >= 0) {
        const topic = payload.candidate_topics[0];
        return {
          ...emptyReply(),
          drafts: [{
            kind: "decision",
            content: FIVE,
            message_idx: assistantIdx,
            user_ids: ["user_a"],
            ...(topic?.topic_id
              ? { topic: { topic_id: topic.topic_id }, same_question_as: topic.decisions[0]?.id ?? null }
              : { topic: { new_topic: "n1" } })
          }],
          ...(topic?.topic_id ? {} : { new_topics: topicShell("推送服务重试", "推送失败后的重试策略") })
        };
      }
      return decisionReply(payload, payload.messages[0]?.content === FIVE ? FIVE : TRIPLE);
    }));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c-seed",
      space_ids: ["space_a"],
      messages: [user("user_a", "用户A", "2026-10-29 10:00:00", TRIPLE)]
    });
    await drain(service);
    await add(service, {
      user_id: "user_b",
      conversation_id: "c-seed",
      space_ids: ["space_a"],
      messages: [user("user_b", "用户B", "2026-10-29 11:00:00", FIVE)]
    });
    await drain(service);
    await add(service, {
      user_id: "user_a",
      conversation_id: "conv-push",
      space_ids: ["space_a"],
      messages: [
        user("user_a", "用户A", "2026-10-29 12:00:00", "把推送的结论核对一下。"),
        assistant("2026-10-29 12:01:00", FIVE)
      ]
    });
    await drain(service);

    const [decision] = await decisions(service);
    expect(decision!.content).toBe(TRIPLE);
    expect(decision!.user_ids).toEqual([]);
    expect(decision!.conflicts).toEqual([expect.objectContaining({ content: FIVE, user_ids: ["user_b", "user_a"] })]);
  });

  it("does not resurrect a dropped restatement when the topic set changes", async () => {
    let store: SqliteProjectMemoryStore | null = null;
    let created = false;
    const seqOf = { current: () => 0 };
    const calls = new Map<number, number>();
    const stub = stubStages(combinedStages((payload, batch) => {
      const seen = (calls.get(batch) ?? 0) + 1;
      calls.set(batch, seen);
      const assistantIdx = payload.messages.findIndex((message) => message.role === "assistant");
      if (assistantIdx >= 0 && payload.messages.some((message) => message.content === ALARM)) {
        if (seen === 2 && !created) {
          created = true;
          void store!.commitChangeSet({
            spaceId: "space_a",
            taskId: "other",
            sourceBatchId: "other",
            idempotencyKey: "other-alarm",
            topics: [{
              op: "create",
              topicId: "topic_side",
              domain: "代码开发",
              expectedTopicSeq: seqOf.current(),
              topicName: "推送旁路",
              topicSummary: "推送旁路的计数方式",
              topicDescription: "",
              decisions: [{ op: "add", decisionId: "dec_side", content: "推送旁路单独计数。", time: "2026-10-29T12:30:00+08:00", userIds: ["user_b"] }],
              experiences: [],
              timelineAppend: [],
              sourcesAppend: []
            }]
          }, { acceptedAt: new Date().toISOString() });
        }
        const topic = payload.candidate_topics[0];
        return {
          ...emptyReply(),
          drafts: [
            { kind: "decision", content: ALARM, message_idx: 0, user_ids: ["user_a"], topic: { new_topic: "n1" } },
            {
              kind: "decision",
              content: FIVE,
              message_idx: assistantIdx,
              user_ids: ["user_a"],
              ...(topic?.topic_id ? { topic: { topic_id: topic.topic_id } } : { topic: { new_topic: "n2" } })
            }
          ],
          new_topics: topicShell("推送告警", "推送失败后的告警计数")
        };
      }
      return decisionReply(payload, payload.messages[0]?.content === FIVE ? FIVE : TRIPLE);
    }));
    const { service, db } = harness.createService();
    store = new SqliteProjectMemoryStore({ db: db.db });
    seqOf.current = () => Number(db.db.prepare(
      `SELECT topic_seq FROM pm_domain_topic_seq WHERE space_id = ? AND domain = ?`
    ).pluck().get("space_a", "代码开发") ?? 0);
    await setupSpace(service, "space_a");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c-seed",
      space_ids: ["space_a"],
      messages: [user("user_a", "用户A", "2026-10-29 10:00:00", TRIPLE)]
    });
    await drain(service);
    await add(service, {
      user_id: "user_b",
      conversation_id: "c-seed",
      space_ids: ["space_a"],
      messages: [user("user_b", "用户B", "2026-10-29 11:00:00", FIVE)]
    });
    await drain(service);
    await call(service, "search/memory", {
      user_id: "user_a",
      query: "推送失败以后怎么重试",
      conversation_id: "conv-push",
      space_ids: ["space_a"],
      include_memory_view: ["project"]
    });
    const extracts = stub.extract.length;
    const assigns = stub.assign.length;

    const taskId = await add(service, {
      user_id: "user_a",
      conversation_id: "conv-push",
      space_ids: ["space_a"],
      messages: [
        user("user_a", "用户A", "2026-10-29 12:00:00", ALARM),
        assistant("2026-10-29 12:01:00", FIVE)
      ]
    });
    await drain(service);

    expect(created).toBe(true);
    expect(stub.extract.length - extracts).toBe(1);
    expect(stub.assign.length - assigns).toBe(2);
    for (const payload of stub.assign.slice(assigns)) {
      const drafts = payload.drafts as Array<{ content: string }>;
      expect(drafts.map((draft) => draft.content)).not.toContain(FIVE);
    }
    expect(droppedOf(db.db, taskId)).toEqual(expect.arrayContaining([{ reason: "restatement", text: FIVE }]));
    const rows = await decisions(service);
    const original = rows.find((decision) => decision.content === TRIPLE || decision.conflicts?.some((item) => item.content === FIVE));
    expect(original!.user_ids).toEqual(["user_a"]);
    expect(original!.conflicts).toEqual([expect.objectContaining({ content: FIVE, user_ids: ["user_b"] })]);
    expect(rows.some((decision) => decision.content === ALARM)).toBe(true);
  });
});

describe("history versions in the merge", () => {
  function historyReply(payload: OrganizePayload): Record<string, unknown> {
    const message = payload.messages[0];
    const content = message?.content ?? TRIPLE;
    const lateAuthor = message?.user_id === "user_a" && message.time.startsWith("2026-10-29T14:");
    const reason = content === FIVE ? "通道超时太久" : lateAuthor ? "改回三次更稳" : null;
    return decisionReply(payload, content, { reason });
  }

  it("does not append a late draft that only repeats a history version", async () => {
    stubStages(combinedStages(historyReply));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [user("user_a", "用户A", "2026-10-29 10:00:00", TRIPLE)]
    });
    await drain(service);
    await add(service, {
      user_id: "user_a",
      conversation_id: "c2",
      space_ids: ["space_a"],
      messages: [user("user_a", "用户A", "2026-10-29 12:00:00", FIVE)]
    });
    await drain(service);
    let [decision] = await decisions(service);
    expect(decision!.content).toBe(FIVE);
    expect(decision!.history).toEqual([expect.objectContaining({ content: TRIPLE, reason: "通道超时太久" })]);

    await add(service, {
      user_id: "user_b",
      conversation_id: "c3",
      space_ids: ["space_a"],
      messages: [user("user_b", "用户B", "2026-10-29 09:00:00", TRIPLE)]
    });
    await drain(service);

    [decision] = await decisions(service);
    expect(decision).toMatchObject({
      content: FIVE,
      user_ids: ["user_a"]
    });
    expect(decision!.conflicts ?? []).toEqual([]);
    expect(decision!.history).toEqual([expect.objectContaining({ content: TRIPLE })]);
  });

  it("drops a not-late history repeat without a reason, and rewrites when a reason is present", async () => {
    stubStages(combinedStages(historyReply));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [user("user_a", "用户A", "2026-10-29 10:00:00", TRIPLE)]
    });
    await drain(service);
    await add(service, {
      user_id: "user_a",
      conversation_id: "c2",
      space_ids: ["space_a"],
      messages: [user("user_a", "用户A", "2026-10-29 12:00:00", FIVE)]
    });
    await drain(service);

    const quiet = await add(service, {
      user_id: "user_a",
      conversation_id: "c3",
      space_ids: ["space_a"],
      messages: [user("user_a", "用户A", "2026-10-29 13:00:00", TRIPLE)]
    });
    await drain(service);
    let [decision] = await decisions(service);
    expect(decision!.content).toBe(FIVE);
    expect(decision!.user_ids).toEqual(["user_a"]);
    expect(droppedOf(db.db, quiet)).toEqual(expect.arrayContaining([{ reason: "restatement", text: TRIPLE }]));

    await add(service, {
      user_id: "user_a",
      conversation_id: "c4",
      space_ids: ["space_a"],
      messages: [user("user_a", "用户A", "2026-10-29 14:00:00", TRIPLE)]
    });
    await drain(service);
    [decision] = await decisions(service);
    expect(decision!.content).toBe(TRIPLE);
    expect(decision!.history).toEqual([
      expect.objectContaining({ content: TRIPLE, reason: "通道超时太久" }),
      expect.objectContaining({ content: FIVE, reason: "改回三次更稳" })
    ]);
  });

  it("still appends a late different conclusion from a non-author", async () => {
    stubStages(combinedStages((payload) => decisionReply(payload, payload.messages[0]?.content ?? TRIPLE)));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [user("user_a", "用户A", "2026-10-29 12:00:00", TRIPLE)]
    });
    await drain(service);
    await add(service, {
      user_id: "user_b",
      conversation_id: "c2",
      space_ids: ["space_a"],
      messages: [user("user_b", "用户B", "2026-10-29 09:00:00", STOP)]
    });
    await drain(service);
    const [decision] = await decisions(service);
    expect(decision!.content).toBe(TRIPLE);
    expect(decision!.conflicts).toEqual([expect.objectContaining({ content: STOP, user_ids: ["user_b"] })]);
  });

  it("still writes nothing when a late draft comes from the content author", async () => {
    stubStages(combinedStages((payload) => decisionReply(payload, payload.messages[0]?.content ?? TRIPLE)));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [user("user_a", "用户A", "2026-10-29 12:00:00", TRIPLE)]
    });
    await drain(service);
    await add(service, {
      user_id: "user_a",
      conversation_id: "c2",
      space_ids: ["space_a"],
      messages: [user("user_a", "用户A", "2026-10-29 09:00:00", STOP)]
    });
    await drain(service);
    const [decision] = await decisions(service);
    expect(decision).toMatchObject({ content: TRIPLE, user_ids: ["user_a"] });
    expect(decision!.conflicts ?? []).toEqual([]);
    expect(decision!.history).toBeUndefined();
  });

  it("does not resolve when the informed member's draft is late", async () => {
    const stub = stubStages(combinedStages((payload) => {
      const message = payload.messages[0];
      const topic = payload.candidate_topics[0];
      const decisionId = topic?.decisions[0]?.id;
      if (message?.content.includes("为准")) {
        return {
          ...emptyReply(),
          drafts: [{
            kind: "decision",
            content: message.content,
            message_idx: 0,
            user_ids: [message.user_id],
            ...(topic?.topic_id
              ? { topic: { topic_id: topic.topic_id }, same_question_as: decisionId ?? null }
              : { topic: { new_topic: "n1" } }),
            resolve: { pick: "conflict:1" }
          }],
          informed_decision_ids: decisionId ? [decisionId] : [],
          ...(topic?.topic_id ? {} : { new_topics: topicShell("推送服务重试", "推送失败后的重试策略") })
        };
      }
      return decisionReply(payload, message?.content ?? TRIPLE);
    }));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [user("user_a", "用户A", "2026-10-29 12:00:00", TRIPLE)]
    });
    await drain(service);
    await add(service, {
      user_id: "user_b",
      conversation_id: "c2",
      space_ids: ["space_a"],
      messages: [user("user_b", "用户B", "2026-10-29 13:00:00", FIVE)]
    });
    await drain(service);
    const searched = await call(service, "search/memory", {
      user_id: "user_b",
      query: "推送失败以后怎么重试",
      conversation_id: "conv-informed",
      space_ids: ["space_a"],
      include_memory_view: ["project"]
    });
    expect(searched.data.topic_detail_list[0].decisions[0].conflicts).toHaveLength(1);

    await add(service, {
      user_id: "user_b",
      conversation_id: "conv-informed",
      space_ids: ["space_a"],
      messages: [user("user_b", "用户B", "2026-10-29 09:00:00", "以用户B 的这条为准。")]
    });
    await drain(service);

    expect(stub.judge.at(-1)!.conflicts_shown).toEqual([expect.any(String)]);
    const [decision] = await decisions(service);
    expect(decision!.content).toBe(TRIPLE);
    expect(decision!.conflicts).toEqual([expect.objectContaining({ content: FIVE, user_ids: ["user_b"] })]);
    expect(decision!.history).toBeUndefined();
  });
});

describe("conversation dedup", () => {
  it("skips messages a completed task already organized for the same space and domains", async () => {
    let failTask = false;
    const stub = stubStages(combinedStages((payload) => {
      if (failTask && payload.messages.some((message) => message.content.includes("先失败"))) {
        throw new Error("model down");
      }
      return decisionReply(payload, payload.messages[0]!.content);
    }));
    const { service } = harness.createService();
    await setupSpace(service, "space_a", ["代码开发", "推送通道"]);
    await setupSpace(service, "space_b", ["代码开发"]);
    const turn = user("user_a", "用户A", "2026-10-29 10:00:00", TRIPLE);

    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      domains: ["代码开发"],
      messages: [turn]
    });
    await drain(service);
    const afterFirst = stub.extract.length;

    const repeated = await add(service, {
      user_id: "user_b",
      conversation_id: "c1",
      space_ids: ["space_a"],
      domains: ["代码开发"],
      messages: [turn]
    });
    await drain(service);
    expect(stub.extract.length).toBe(afterFirst);
    expect((await call(service, "get/status", { task_id: repeated })).data.status).toBe("completed");
    expect((await call(service, "get/memory", { space_id: "space_a" })).data.total).toBe(1);

    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      domains: ["推送通道"],
      messages: [turn]
    });
    await drain(service);
    expect(stub.extract.length).toBe(afterFirst + 1);
    expect(stub.extract.at(-1)!.messages).toEqual([expect.objectContaining({ content: TRIPLE })]);

    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_b"],
      domains: ["代码开发"],
      messages: [turn]
    });
    await drain(service);
    expect(stub.extract.length).toBe(afterFirst + 2);
    expect((await call(service, "get/memory", { space_id: "space_b" })).data.total).toBe(1);

    failTask = true;
    const failedBody = {
      user_id: "user_a",
      conversation_id: "c-fail",
      space_ids: ["space_a"],
      domains: ["代码开发"],
      messages: [user("user_a", "用户A", "2026-10-29 15:00:00", "推送这次先失败，稍后再记。")]
    };
    const failed = await add(service, failedBody);
    await drain(service);
    expect((await call(service, "get/status", { task_id: failed })).data.status).toBe("failed");
    failTask = false;
    const beforeRetry = stub.extract.length;
    const retried = await add(service, failedBody);
    expect(retried).not.toBe(failed);
    await drain(service);
    expect(stub.extract.length).toBe(beforeRetry + 1);
    expect(stub.extract.at(-1)!.messages).toEqual([expect.objectContaining({ content: "推送这次先失败，稍后再记。" })]);
    expect((await call(service, "get/status", { task_id: retried })).data.status).toBe("completed");
  });

  it("still loads a deferred segment's original turns after those turns are only context", async () => {
    const stub = stubStages(combinedStages((payload, batch) => {
      if (batch === 1) return { ...emptyReply(), deferred: [{ text: HELD, reason: "work_unresolved" }] };
      const segment = payload.deferred_segments[0];
      const turn = payload.deferred_turns.find((item) => item.content === HELD);
      if (!segment || !turn) return emptyReply();
      return {
        ...emptyReply(),
        drafts: [{
          kind: "decision",
          category: "对外约定",
          content: KEPT,
          deferred_ref: segment.ref,
          deferred_idx: turn.didx,
          user_ids: ["user_a"],
          topic: { new_topic: "n1" }
        }],
        new_topics: topicShell("推送重试上限", "推送失败的重试上限")
      };
    }));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    const held = user("user_a", "用户A", "2026-10-29 10:00:00", HELD);
    await add(service, { user_id: "user_a", conversation_id: "c-fill", space_ids: ["space_a"], messages: [held] });
    await drain(service);

    const taskId = await add(service, {
      user_id: "user_a",
      conversation_id: "c-fill",
      space_ids: ["space_a"],
      messages: [held, user("user_a", "用户A", "2026-10-29 10:05:00", CLUE)]
    });
    await drain(service);

    const extracted = stub.extract[1] as {
      messages: Array<{ content: string }>;
      context_turns: Array<{ content: string }>;
      deferred_turns: Array<{ content: string }>;
    };
    expect(extracted.messages.map((message) => message.content)).toEqual([CLUE]);
    expect(extracted.context_turns.map((message) => message.content)).toContain(HELD);
    expect(extracted.deferred_turns.map((message) => message.content)).toContain(HELD);
    expect((await decisions(service)).map((decision) => decision.content)).toEqual([KEPT]);

    const stored = db.db.prepare(
      `SELECT t.role, t.chat_time, t.content
       FROM pm_raw_turns t
       JOIN pm_task_turns l ON l.turn_id = t.turn_id
       WHERE l.task_id = ? AND t.role IN ('user', 'assistant')
       ORDER BY t.chat_time, t.rowid`
    ).all(taskId) as Array<{ role: string; chat_time: string; content: string }>;
    const key = db.db.prepare(`SELECT idempotency_key FROM pm_changesets WHERE task_id = ?`).pluck().get(taskId);
    expect(key).toBe(`space_a:c-fill:${batchHash(stored)}`);
    expect(stored.map((turn) => turn.content)).toEqual([HELD, CLUE]);
  });
});

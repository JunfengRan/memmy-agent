import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PROJECT_MEMORY_LIMITS } from "../../../src/service/project-memory/contract/limits.js";
import type { RawTurnRecord } from "../../../src/service/project-memory/contract/types.js";
import { parseExtractOutput, type ExtractInput } from "../../../src/service/project-memory/organize/extract.js";
import type { ProjectLocalState } from "../../../src/service/project-memory/store/sqlite/local-state.js";
import { SqliteProjectMemoryStore } from "../../../src/service/project-memory/store/sqlite/sqlite-store.js";
import {
  call,
  combinedStages,
  createProjectMemoryHarness,
  drain,
  emptyReply,
  setupSpace,
  stubStages,
  type DeferredSegmentView,
  type DeferredTurnView,
  type OrganizePayload
} from "./helpers.js";

const harness = createProjectMemoryHarness();
afterEach(() => harness.cleanup());

const LIMIT_5 = "推送失败的重试上限为 5。";
const SENTENCE = "该上限同样设为 20.";
const LIMIT_20 = "推送失败的重试上限同样设为 20。";
const AT_1000 = "2026-10-29 10:00:00";
const AT_1001 = "2026-10-29 10:01:00";
const AT_1005 = "2026-10-29 10:05:00";
const ISO_1001 = "2026-10-29T10:01:00+08:00";

function message(user: string, time: string, content: string) {
  return { role: "user", role_id: user, role_name: user, chat_time: time, content };
}

function localOf(service: object): ProjectLocalState {
  return (service as unknown as { projectMemory: { local: ProjectLocalState } }).projectMemory.local;
}

function storeOf(service: object): SqliteProjectMemoryStore {
  return (service as unknown as { projectMemory: { store: SqliteProjectMemoryStore } }).projectMemory.store;
}

function rows(db: { prepare(sql: string): { all(...args: unknown[]): unknown } }, conversationId: string, spaceId: string) {
  return db.prepare(
    `SELECT id, task_id, segment, reason FROM pm_deferred_segments
     WHERE conversation_id = ? AND space_id = ? ORDER BY id`
  ).all(conversationId, spaceId) as Array<{ id: number; task_id: string; segment: string; reason: string }>;
}

async function add(service: Parameters<typeof call>[0], body: Record<string, unknown>) {
  const accepted = await call(service, "add/message", { agent_id: "codex", allow_memory_view: ["project"], ...body });
  expect(accepted.code, JSON.stringify(accepted)).toBe(0);
  return accepted.data.task_id as string;
}

function newLimitTopic(content: string): Record<string, unknown> {
  return {
    ...emptyReply(),
    drafts: [{
      kind: "decision",
      category: "对外约定",
      content,
      message_idx: 0,
      user_ids: ["user_a"],
      topic: { new_topic: "n1" }
    }],
    new_topics: [{ ref: "n1", topic_name: "推送服务重试", topic_summary: "推送失败后的重试上限", topic_description: "" }]
  };
}

function claim(payload: OrganizePayload, options: { forceNew?: boolean } = {}): Record<string, unknown> {
  const segment = payload.deferred_segments[0];
  const turn = payload.deferred_turns.find((item) => item.content.includes("20"));
  if (!segment || !turn) return emptyReply();
  const topic = options.forceNew ? undefined : payload.candidate_topics[0];
  return {
    ...emptyReply(),
    drafts: [{
      kind: "decision",
      category: "对外约定",
      content: LIMIT_20,
      deferred_ref: segment.ref,
      deferred_idx: turn.didx,
      user_ids: ["user_a"],
      topic: topic?.topic_id ? { topic_id: topic.topic_id } : { new_topic: "n1" },
      same_question_as: topic?.decisions[0]?.id ?? null
    }],
    new_topics: topic?.topic_id ? [] : [{ ref: "n1", topic_name: "推送服务重试", topic_summary: "推送失败后的重试上限", topic_description: "" }]
  };
}

function batchHash(turns: Array<{ role: string; chat_time: string; content: string }>): string {
  const hash = createHash("sha256");
  for (const turn of turns) hash.update(`${turn.role}\u0000${turn.chat_time}\u0000${turn.content}\u0001`);
  return hash.digest("hex").slice(0, 24);
}

function turnRecord(content: string, time: string): RawTurnRecord {
  return {
    turnId: content,
    taskId: "task",
    conversationId: "c1",
    role: "user",
    roleId: "user_a",
    roleName: "user_a",
    chatTime: time,
    chatTimeInferred: false,
    content,
    toolCalls: []
  };
}

function extractInput(deferredIdx: number[]): ExtractInput {
  const current = turnRecord("说的是推送失败的重试上限。", "2026-10-29T10:05:00+08:00");
  const original = turnRecord(SENTENCE, ISO_1001);
  return {
    instructions: null,
    domains: [],
    requestDomains: ["代码开发"],
    messages: [current],
    context: [],
    deferredTurns: [original],
    deferredSegments: [{ id: 7, ref: "df7", text: SENTENCE, reason: "work_unresolved", didx: deferredIdx }]
  };
}

describe("deferred segment local state", () => {
  it("loads the newest pending rows in id order and skips topic_unavailable and pre-clear tasks", async () => {
    expect(PROJECT_MEMORY_LIMITS.deferredBackfill).toBe(10);
    const { service, db } = harness.createService();
    const local = localOf(service);
    const turn = {
      conversationId: "c1",
      role: "user" as const,
      roleId: "user_a",
      roleName: "user_a",
      chatTime: "2026-10-01T10:00:00+08:00",
      chatTimeInferred: false,
      content: "旧轮次",
      toolCalls: []
    };
    local.createTask({
      taskId: "task_old",
      spaceIds: ["space_a"],
      conversationId: "c1",
      batchKey: "old",
      sourceBatchId: "task_old",
      acceptedAt: "2026-10-01T00:00:00.000Z"
    }, [turn]);
    local.createTask({
      taskId: "task_new",
      spaceIds: ["space_a"],
      conversationId: "c1",
      batchKey: "new",
      sourceBatchId: "task_new",
      acceptedAt: "2026-10-20T00:00:00.000Z"
    }, [{ ...turn, chatTime: "2026-10-20T10:00:00+08:00", content: "新轮次" }]);
    local.appendDeferred({ conversationId: "c1", spaceId: "space_a", taskId: "task_old", segments: [{ text: "too-old", reason: "work_unresolved" }] });
    local.appendDeferred({
      conversationId: "c1",
      spaceId: "space_a",
      taskId: "task_new",
      segments: ["n0", "n1", "n2", "n3", "n4", "n5"].map((text) => ({ text, reason: "ambiguous_topic" }))
    });
    local.appendDeferred({
      conversationId: "c1",
      spaceId: "space_a",
      taskId: "task_new",
      segments: [{ text: "blocked", reason: "topic_unavailable" }]
    });
    local.appendDeferred({
      conversationId: "c1",
      spaceId: "space_a",
      taskId: "task_new",
      segments: ["n6", "n7", "n8", "n9", "n10", "n11"].map((text) => ({ text, reason: "work_unresolved" }))
    });

    const pending = local.pendingDeferred("c1", "space_a", { clearedAt: "2026-10-15T00:00:00.000Z", limit: PROJECT_MEMORY_LIMITS.deferredBackfill });
    expect(pending).toHaveLength(10);
    expect(pending.map((row) => row.id)).toEqual([...pending.map((row) => row.id)].sort((left, right) => left - right));
    expect(pending.some((row) => row.text === "too-old" || row.text === "blocked" || row.reason === "topic_unavailable")).toBe(false);
    expect(pending.at(-1)?.text).toBe("n11");
    expect(pending[0]?.text).toBe("n2");

    const withoutFence = local.pendingDeferred("c1", "space_a", { clearedAt: null, limit: 50 });
    expect(withoutFence.some((row) => row.text === "too-old")).toBe(true);
    expect(withoutFence.some((row) => row.reason === "topic_unavailable")).toBe(false);
    expect(rows(db.db, "c1", "space_a").some((row) => row.reason === "topic_unavailable")).toBe(true);
  });

  it("settles deletes, inserts, and a topic_unavailable replacement in one transaction", async () => {
    const { service, db } = harness.createService();
    const local = localOf(service);
    local.createTask({
      taskId: "task_a",
      spaceIds: ["space_a"],
      conversationId: "c1",
      batchKey: "a",
      sourceBatchId: "task_a",
      acceptedAt: "2026-10-20T00:00:00.000Z"
    }, [{
      conversationId: "c1",
      role: "user",
      roleId: "user_a",
      roleName: "user_a",
      chatTime: ISO_1001,
      chatTimeInferred: false,
      content: SENTENCE,
      toolCalls: []
    }]);
    local.createTask({
      taskId: "task_b",
      spaceIds: ["space_b"],
      conversationId: "c1",
      batchKey: "b",
      sourceBatchId: "task_b",
      acceptedAt: "2026-10-20T00:00:00.000Z"
    }, [{
      conversationId: "c1",
      role: "user",
      roleId: "user_a",
      roleName: "user_a",
      chatTime: ISO_1001,
      chatTimeInferred: false,
      content: "另一个空间",
      toolCalls: []
    }]);
    local.appendDeferred({
      conversationId: "c1",
      spaceId: "space_a",
      taskId: "task_a",
      segments: [
        { text: "drop-me", reason: "work_unresolved" },
        { text: "keep-me", reason: "ambiguous_topic" },
        { text: "replace-me", reason: "ambiguous_topic" }
      ]
    });
    local.appendDeferred({
      conversationId: "c1",
      spaceId: "space_b",
      taskId: "task_b",
      segments: [{ text: "other-space", reason: "work_unresolved" }]
    });
    const before = rows(db.db, "c1", "space_a");
    const other = rows(db.db, "c1", "space_b")[0]!;
    const drop = before[0]!;
    const keep = before[1]!;
    const replace = before[2]!;

    local.settleDeferred({
      conversationId: "c1",
      spaceId: "space_a",
      taskId: "task_settle",
      consumed: [drop.id, replace.id, other.id],
      kept: [keep.id],
      appended: [
        { text: "fresh", reason: "work_unresolved" },
        { text: replace.segment, reason: "topic_unavailable" }
      ]
    });

    const after = rows(db.db, "c1", "space_a");
    expect(after.map((row) => row.id)).not.toContain(drop.id);
    expect(after.map((row) => row.id)).not.toContain(replace.id);
    expect(after.find((row) => row.id === keep.id)).toMatchObject({ segment: "keep-me", reason: "ambiguous_topic" });
    expect(after.filter((row) => row.segment === "keep-me")).toHaveLength(1);
    expect(after.find((row) => row.segment === "fresh")).toMatchObject({ reason: "work_unresolved", task_id: "task_settle" });
    expect(after.find((row) => row.reason === "topic_unavailable")).toMatchObject({ segment: "replace-me", task_id: "task_settle" });
    expect(rows(db.db, "c1", "space_b")).toEqual([other]);
  });

  it("forgets deferred rows for one space only", async () => {
    const { service, db } = harness.createService();
    const local = localOf(service);
    local.createTask({
      taskId: "task_a",
      spaceIds: ["space_a", "space_b"],
      conversationId: "c1",
      batchKey: "a",
      sourceBatchId: "task_a",
      acceptedAt: "2026-10-20T00:00:00.000Z"
    }, [{
      conversationId: "c1",
      role: "user",
      roleId: "user_a",
      roleName: "user_a",
      chatTime: ISO_1001,
      chatTimeInferred: false,
      content: SENTENCE,
      toolCalls: []
    }]);
    local.appendDeferred({ conversationId: "c1", spaceId: "space_a", taskId: "task_a", segments: [{ text: "a", reason: "work_unresolved" }] });
    local.appendDeferred({ conversationId: "c1", spaceId: "space_b", taskId: "task_a", segments: [{ text: "b", reason: "work_unresolved" }] });
    local.forgetDeferred("space_a");
    expect(rows(db.db, "c1", "space_a")).toEqual([]);
    expect(rows(db.db, "c1", "space_b")).toHaveLength(1);
    local.forgetSpace("space_b");
    expect(rows(db.db, "c1", "space_b")).toEqual([]);
  });
});

describe("deferred backfill", () => {
  it("fills a deferred sentence on the next turn of the same conversation", async () => {
    const stub = stubStages(combinedStages((payload, batch) => batch === 1
      ? {
          ...newLimitTopic(LIMIT_5),
          deferred: [{ text: SENTENCE, reason: "work_unresolved" }]
        }
      : claim(payload)));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    const first = await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1000, "推送失败的重试上限改为 5。"), message("user_a", AT_1001, SENTENCE)]
    });
    await drain(service);
    const stored = rows(db.db, "c1", "space_a");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ segment: SENTENCE, reason: "work_unresolved" });
    expect((await call(service, "get/status", { task_id: first })).data.memory_views.project.deferred_count).toBe(1);

    const second = await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1005, "说的是推送失败的重试上限。")]
    });
    await drain(service);

    const payload = stub.extract[1] as {
      deferred_segments?: DeferredSegmentView[];
      deferred_turns?: DeferredTurnView[];
    };
    const segment = payload.deferred_segments?.[0];
    const turn = payload.deferred_turns?.find((item) => item.content === SENTENCE);
    expect(segment).toMatchObject({ ref: `df${stored[0]!.id}`, text: SENTENCE, reason: "work_unresolved" });
    expect(turn).toMatchObject({ role: "user", user_id: "user_a", name: "user_a", time: ISO_1001, content: SENTENCE });
    expect(segment?.didx).toContain(turn?.didx);
    expect((await call(service, "get/status", { task_id: second })).data.memory_views.project.deferred_count).toBe(0);
    expect(rows(db.db, "c1", "space_a")).toEqual([]);

    const listed = await call(service, "get/memory", { space_id: "space_a" });
    const decisions = listed.data.topic_detail_list.flatMap((topic: { decisions: Array<{ content: string; time: string; user_ids: string[] }> }) => topic.decisions);
    const hit = decisions.find((item: { content: string }) => item.content === LIMIT_20);
    expect(hit).toMatchObject({ time: ISO_1001, user_ids: ["user_a"] });
  });

  it("keeps the same row while the model echoes the ref, then consumes it later", async () => {
    let phase: "defer" | "echo" | "take" = "defer";
    stubStages(combinedStages((payload) => {
      if (phase === "defer") return { ...emptyReply(), deferred: [{ text: SENTENCE, reason: "work_unresolved" }] };
      const segment = payload.deferred_segments[0];
      if (phase === "echo" && segment) {
        return { ...emptyReply(), deferred: [{ ref: segment.ref, text: segment.text, reason: "work_unresolved" }] };
      }
      return claim(payload);
    }));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1001, SENTENCE)]
    });
    await drain(service);
    const original = rows(db.db, "c1", "space_a")[0]!;

    phase = "echo";
    const echoed = await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1005, "今天先不改推送配置。")]
    });
    await drain(service);
    expect((await call(service, "get/status", { task_id: echoed })).data.memory_views.project.deferred_count).toBe(0);
    expect(rows(db.db, "c1", "space_a")).toEqual([original]);

    phase = "take";
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", "2026-10-29 10:06:00", "说的是推送失败的重试上限。")]
    });
    await drain(service);
    expect(rows(db.db, "c1", "space_a")).toEqual([]);
    const listed = await call(service, "get/memory", { space_id: "space_a" });
    const decisions = listed.data.topic_detail_list.flatMap((topic: { decisions: Array<{ content: string }> }) => topic.decisions);
    expect(decisions.some((item: { content: string }) => item.content === LIMIT_20)).toBe(true);
  });

  it("does not backfill a segment whose target topic was deleted during the call", async () => {
    let topicId = "";
    let callsInBatch = 0;
    let batchSeen = 0;
    const stub = stubStages(combinedStages((payload, batch) => {
      if (batch !== batchSeen) {
        batchSeen = batch;
        callsInBatch = 0;
      }
      callsInBatch += 1;
      if (batch === 1) return newLimitTopic(LIMIT_5);
      if (batch === 2 && callsInBatch === 2 && topicId) void storeOf(service).deleteTopics([topicId]);
      if (batch === 2) {
        return {
          ...emptyReply(),
          drafts: [{
            kind: "decision",
            content: LIMIT_20,
            message_idx: 0,
            user_ids: ["user_a"],
            topic: { topic_id: topicId || payload.candidate_topics[0]?.topic_id }
          }]
        };
      }
      return emptyReply();
    }));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1000, "推送失败的重试上限改为 5。")]
    });
    await drain(service);
    topicId = (await call(service, "get/memory", { space_id: "space_a" })).data.topic_detail_list[0].id;

    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1001, SENTENCE)]
    });
    await drain(service);
    expect(rows(db.db, "c1", "space_a")).toEqual([expect.objectContaining({ reason: "topic_unavailable", segment: LIMIT_20 })]);
    expect((await call(service, "get/memory", { space_id: "space_a" })).data.total).toBe(0);

    const before = stub.extract.length;
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1005, "再补一句推送说明。")]
    });
    await drain(service);
    expect(stub.extract[before]).not.toHaveProperty("deferred_segments");
    const listed = await call(service, "get/memory", { space_id: "space_a" });
    expect(listed.data.total).toBe(0);
    expect(JSON.stringify(listed.data)).not.toContain(LIMIT_20);
    expect(JSON.stringify(listed.data)).not.toContain(SENTENCE);
  });

  it("replaces an ambiguous row with topic_unavailable when the re-judge target is gone", async () => {
    let callsInBatch = 0;
    let batchSeen = 0;
    stubStages(combinedStages((payload, batch) => {
      if (batch !== batchSeen) {
        batchSeen = batch;
        callsInBatch = 0;
      }
      callsInBatch += 1;
      if (batch === 1) {
        return { ...emptyReply(), drafts: [{ kind: "decision", content: LIMIT_20, message_idx: 0, user_ids: ["user_a"] }] };
      }
      if (payload.deferred_segments.length > 0 && callsInBatch === 2) void storeOf(service).deleteTopics(["topic_push"]);
      if (payload.deferred_segments.length > 0) return claim(payload);
      return emptyReply();
    }));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    const seeded = await storeOf(service).commitChangeSet({
      spaceId: "space_a",
      taskId: "seed",
      sourceBatchId: "seed",
      idempotencyKey: "seed-push",
      topics: [{
        op: "create",
        topicId: "topic_push",
        domain: "代码开发",
        expectedTopicSeq: 0,
        topicName: "推送服务重试",
        topicSummary: "推送失败的重试上限同样设为 20",
        topicDescription: "",
        decisions: [{ op: "add", decisionId: "dec_push", content: LIMIT_5, time: "2026-10-29T09:00:00+08:00", userIds: ["user_a"] }],
        experiences: [],
        timelineAppend: [],
        sourcesAppend: []
      }]
    }, { acceptedAt: new Date().toISOString() });
    expect(seeded.ok).toBe(true);

    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1001, SENTENCE)]
    });
    await drain(service);
    const ambiguous = rows(db.db, "c1", "space_a");
    expect(ambiguous).toEqual([expect.objectContaining({ reason: "ambiguous_topic", segment: LIMIT_20 })]);

    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1005, "说的是推送失败的重试上限。")]
    });
    await drain(service);
    const replaced = rows(db.db, "c1", "space_a");
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ reason: "topic_unavailable", segment: LIMIT_20 });
    expect(replaced[0]!.id).not.toBe(ambiguous[0]!.id);

    const stub = stubStages(combinedStages(() => emptyReply()));
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", "2026-10-29 10:06:00", "今天先不改推送配置。")]
    });
    await drain(service);
    expect(stub.extract[0]).not.toHaveProperty("deferred_segments");
  });

  it("drops deferred rows on clear and does not backfill them", async () => {
    const stub = stubStages(combinedStages((payload, batch) => batch === 1
      ? { ...emptyReply(), deferred: [{ text: SENTENCE, reason: "work_unresolved" }] }
      : emptyReply()));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1001, SENTENCE)]
    });
    await drain(service);
    expect(rows(db.db, "c1", "space_a")).toHaveLength(1);

    expect((await call(service, "delete/memory", { space_id: "space_a" })).code).toBe(0);
    expect(rows(db.db, "c1", "space_a")).toEqual([]);

    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1005, "清空之后的新消息。")]
    });
    await drain(service);
    expect(stub.extract[1]).not.toHaveProperty("deferred_segments");
    expect(rows(db.db, "c1", "space_a")).toEqual([]);
  });

  it("does not give another conversation, an anonymous batch, or another space c1's rows", async () => {
    const stub = stubStages(combinedStages((payload, batch) => batch === 1
      ? { ...emptyReply(), deferred: [{ text: SENTENCE, reason: "work_unresolved" }] }
      : emptyReply()));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    await setupSpace(service, "space_b");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1001, SENTENCE)]
    });
    await drain(service);
    const kept = rows(db.db, "c1", "space_a");
    expect(kept).toHaveLength(1);

    await add(service, {
      user_id: "user_b",
      conversation_id: "c2",
      space_ids: ["space_a"],
      messages: [message("user_b", AT_1005, "另一段会话。")]
    });
    await add(service, {
      user_id: "user_a",
      space_ids: ["space_a"],
      messages: [message("user_a", "2026-10-29 10:06:00", "没有会话号。")]
    });
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_b"],
      messages: [message("user_a", "2026-10-29 10:07:00", "另一个空间。")]
    });
    await drain(service);

    for (const payload of stub.extract.slice(1)) expect(payload).not.toHaveProperty("deferred_segments");
    expect(rows(db.db, "c1", "space_a")).toEqual(kept);
  });

  it("leaves the row in place when the model call fails, so the next task can retry", async () => {
    let phase: "defer" | "fail" | "take" = "defer";
    stubStages(combinedStages((payload) => {
      if (phase === "fail") throw new Error("model down");
      if (phase === "defer") return { ...emptyReply(), deferred: [{ text: SENTENCE, reason: "work_unresolved" }] };
      return claim(payload);
    }));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1001, SENTENCE)]
    });
    await drain(service);
    const pending = rows(db.db, "c1", "space_a");

    phase = "fail";
    const failed = await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1005, "说的是推送失败的重试上限。")]
    });
    await drain(service);
    expect((await call(service, "get/status", { task_id: failed })).data.error).toMatchObject({ reason: "MODEL_CALL_FAILED" });
    expect(rows(db.db, "c1", "space_a")).toEqual(pending);

    phase = "take";
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", "2026-10-29 10:06:00", "说的是推送失败的重试上限。")]
    });
    await drain(service);
    expect(rows(db.db, "c1", "space_a")).toEqual([]);
  });

  it("writes a backfill once across VERSION_CONFLICT and keeps backfillOf across TOPIC_SET_CHANGED", async () => {
    let mode: "seed" | "defer" | "conflict" | "topicset-defer" | "topicset" = "seed";
    let bumped = false;
    let openedTopic = false;
    let callsInBatch = 0;
    let batchSeen = 0;
    let topicId = "";
    const { service, db } = harness.createService();
    const stub = stubStages(combinedStages((payload, batch) => {
      if (batch !== batchSeen) {
        batchSeen = batch;
        callsInBatch = 0;
      }
      callsInBatch += 1;
      if (mode === "seed") return newLimitTopic(LIMIT_5);
      if (mode === "defer" || mode === "topicset-defer") {
        return { ...emptyReply(), deferred: [{ text: SENTENCE, reason: "work_unresolved" }] };
      }
      if (mode === "conflict") {
        const judging = payload.candidate_topics.some((topic) => topic.decisions.length > 0);
        if (judging && !bumped && topicId) {
          bumped = true;
          void storeOf(service).commitChangeSet({
            spaceId: "space_a",
            taskId: "bump",
            sourceBatchId: "bump",
            idempotencyKey: "bump-revision",
            topics: [{
              op: "update",
              topicId,
              domain: "代码开发",
              expectedRevision: 1,
              topicDescription: "并发写入抬高了版本。",
              decisions: [],
              experiences: [],
              timelineAppend: [],
              sourcesAppend: []
            }]
          }, { acceptedAt: new Date().toISOString() });
        }
        return claim(payload);
      }
      if (callsInBatch === 2 && !openedTopic) {
        openedTopic = true;
        void storeOf(service).commitChangeSet({
          spaceId: "space_a",
          taskId: "other",
          sourceBatchId: "other",
          idempotencyKey: "other-topic",
          topics: [{
            op: "create",
            topicId: "topic_concurrent",
            domain: "代码开发",
            expectedTopicSeq: 1,
            topicName: "告警通道",
            topicSummary: "告警通道的开关",
            topicDescription: "",
            decisions: [{ op: "add", decisionId: "dec_alert", content: "告警通道先保持关闭。", time: "2026-10-29T10:04:00+08:00", userIds: ["user_b"] }],
            experiences: [],
            timelineAppend: [],
            sourcesAppend: []
          }]
        }, { acceptedAt: new Date().toISOString() });
      }
      return claim(payload, { forceNew: true });
    }));
    await setupSpace(service, "space_a");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1000, "推送失败的重试上限改为 5。")]
    });
    await drain(service);
    topicId = (await call(service, "get/memory", { space_id: "space_a" })).data.topic_detail_list[0].id;

    mode = "defer";
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1001, SENTENCE)]
    });
    await drain(service);

    mode = "conflict";
    const judgesBefore = stub.judge.length;
    const extractsBefore = stub.extract.length;
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1005, "说的是推送失败的重试上限。")]
    });
    await drain(service);
    expect(stub.judge.length - judgesBefore).toBe(2);
    expect(stub.extract.length - extractsBefore).toBe(1);
    expect(rows(db.db, "c1", "space_a")).toEqual([]);
    const afterConflict = await call(service, "get/memory", { space_id: "space_a" });
    const rewritten = afterConflict.data.topic_detail_list
      .flatMap((topic: { decisions: Array<{ content: string; time: string }> }) => topic.decisions)
      .filter((item: { content: string }) => item.content === LIMIT_20);
    expect(rewritten).toEqual([expect.objectContaining({ time: ISO_1001 })]);

    mode = "topicset-defer";
    const extractsAtRetry = stub.extract.length;
    const assignsAtRetry = stub.assign.length;
    await add(service, {
      user_id: "user_a",
      conversation_id: "c2",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1001, SENTENCE)]
    });
    await drain(service);
    mode = "topicset";
    await add(service, {
      user_id: "user_a",
      conversation_id: "c2",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1005, "说的是推送失败的重试上限。")]
    });
    await drain(service);
    expect(stub.extract.length - extractsAtRetry).toBe(2);
    expect(stub.assign.length - assignsAtRetry).toBe(2);
    expect(rows(db.db, "c2", "space_a")).toEqual([]);
    const created = (await call(service, "get/memory", { space_id: "space_a" })).data.topic_detail_list
      .flatMap((topic: { decisions: Array<{ content: string; time: string }> }) => topic.decisions)
      .filter((item: { content: string; time: string }) => item.content === LIMIT_20 && item.time === ISO_1001);
    expect(created.length).toBeGreaterThanOrEqual(1);
  });

  it("deletes the row on a replayed commit and does not write the entry twice", async () => {
    stubStages(combinedStages((payload, batch) => batch === 1
      ? { ...emptyReply(), deferred: [{ text: SENTENCE, reason: "work_unresolved" }] }
      : claim(payload, { forceNew: true })));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    const seeded = await storeOf(service).commitChangeSet({
      spaceId: "space_a",
      taskId: "seed",
      sourceBatchId: "seed",
      idempotencyKey: "seed-replay",
      topics: [{
        op: "create",
        topicId: "topic_seed",
        domain: "代码开发",
        expectedTopicSeq: 0,
        topicName: "推送服务重试",
        topicSummary: "推送失败后的重试上限",
        topicDescription: "",
        decisions: [{ op: "add", decisionId: "dec_seed", content: LIMIT_5, time: "2026-10-29T10:00:00+08:00", userIds: ["user_a"] }],
        experiences: [],
        timelineAppend: [],
        sourcesAppend: []
      }]
    }, { acceptedAt: new Date().toISOString() });
    expect(seeded.ok).toBe(true);
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1001, SENTENCE)]
    });
    await drain(service);
    expect(rows(db.db, "c1", "space_a")).toHaveLength(1);

    const taskId = await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("user_a", AT_1005, "说的是推送失败的重试上限。")]
    });
    const storedTurns = db.db.prepare(
      `SELECT t.role, t.chat_time, t.content
       FROM pm_raw_turns t
       JOIN pm_task_turns l ON l.turn_id = t.turn_id
       WHERE l.task_id = ? AND t.role IN ('user', 'assistant')
       ORDER BY t.chat_time, t.rowid`
    ).all(taskId) as Array<{ role: string; chat_time: string; content: string }>;
    const key = `space_a:c1:${batchHash(storedTurns)}`;
    expect(key).not.toContain("df");
    db.db.prepare(
      `INSERT INTO pm_changesets (idempotency_key, space_id, task_id, result_json, committed_at)
       VALUES (?, 'space_a', ?, ?, ?)`
    ).run(key, taskId, JSON.stringify({
      ok: true,
      replayed: false,
      topics: [{ topicId: "topic_seed", revision: 1, updateTime: "2026-10-29T10:00:00.000Z" }]
    }), new Date().toISOString());

    await drain(service);
    expect(rows(db.db, "c1", "space_a")).toEqual([]);
    const listed = await call(service, "get/memory", { space_id: "space_a" });
    expect(listed.data.total).toBe(1);
    expect(JSON.stringify(listed.data)).not.toContain(LIMIT_20);
    expect(listed.data.topic_detail_list[0].decisions).toEqual([expect.objectContaining({ content: LIMIT_5 })]);
    const keys = db.db.prepare(`SELECT idempotency_key FROM pm_changesets`).all() as Array<{ idempotency_key: string }>;
    expect(keys.map((item) => item.idempotency_key)).toContain(key);
    expect(keys.every((item) => !item.idempotency_key.includes("df"))).toBe(true);
  });
});

describe("deferred extract parser", () => {
  it("drops an unknown ref, keeps the first draft for one ref, and drops an index outside didx", () => {
    const unknown = parseExtractOutput({
      drafts: [{ kind: "decision", content: LIMIT_20, deferred_ref: "df999", deferred_idx: 0, user_ids: ["user_b"] }],
      deferred: []
    }, extractInput([0]));
    expect(unknown.drafts).toEqual([]);
    expect(unknown.deferred).toEqual([]);

    const first = parseExtractOutput({
      drafts: [
        { kind: "decision", content: "先采用的上限", deferred_ref: "df7", deferred_idx: 0, user_ids: ["user_b"] },
        { kind: "decision", content: "后写的上限", deferred_ref: "df7", deferred_idx: 0, user_ids: ["user_b"] }
      ],
      deferred: []
    }, extractInput([0]));
    expect(first.drafts).toHaveLength(1);
    expect(first.drafts[0]).toMatchObject({
      content: "先采用的上限",
      time: ISO_1001,
      userIds: ["user_a"],
      backfillOf: 7
    });

    const outside = parseExtractOutput({
      drafts: [{ kind: "decision", content: LIMIT_20, deferred_ref: "df7", deferred_idx: 4 }],
      deferred: []
    }, extractInput([0]));
    expect(outside.drafts).toEqual([]);
    expect(outside.deferred.filter((item) => item.backfillOf == null)).toEqual([]);
    expect(outside.deferred.map((item) => item.backfillOf)).toEqual([7]);
  });
});

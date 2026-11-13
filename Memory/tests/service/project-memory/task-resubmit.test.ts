import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryDb, MemoryService } from "../../../src/index.js";
import { SqliteProjectMemoryStore } from "../../../src/service/project-memory/store/sqlite/sqlite-store.js";
import { call, combinedStages, createProjectMemoryHarness, drain, setupSpace, stubStages } from "./helpers.js";

const harness = createProjectMemoryHarness();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T02:00:00.000Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.cleanup();
});

function message(content: string, time?: string, roleId = "user_a", roleName = "用户A") {
  return {
    role: "user",
    role_id: roleId,
    role_name: roleName,
    content,
    ...(time ? { chat_time: time } : {})
  };
}

function decisionReply(content: string, deferred: Array<{ text: string; reason: string }> = []): Record<string, unknown> {
  return {
    drafts: [{
      kind: "decision",
      content,
      message_idx: 0,
      user_ids: ["user_a"],
      topic: { new_topic: "n1" }
    }],
    new_topics: [{ ref: "n1", topic_name: "推送方案", topic_summary: "推送失败后怎么继续", topic_description: "" }],
    deferred,
    topic_updates: [],
    informed_decision_ids: []
  };
}

async function add(service: MemoryService, body: Record<string, unknown>): Promise<string> {
  const accepted = await call(service, "add/message", {
    agent_id: "codex",
    allow_memory_view: ["project"],
    user_id: "user_a",
    ...body
  });
  expect(accepted.code, JSON.stringify(accepted)).toBe(0);
  return accepted.data.task_id as string;
}

function rawTurns(db: MemoryDb): string[] {
  return db.db.prepare(`SELECT chat_time FROM pm_raw_turns ORDER BY chat_time, rowid`).pluck().all() as string[];
}

function changesetKeys(db: MemoryDb): string[] {
  return db.db.prepare(`SELECT idempotency_key FROM pm_changesets ORDER BY committed_at, idempotency_key`).pluck().all() as string[];
}

function writeSideTopic(store: SqliteProjectMemoryStore, database: MemoryDb, id: string): void {
  const seq = Number(database.db.prepare(
    `SELECT topic_seq FROM pm_domain_topic_seq WHERE space_id = ? AND domain = ?`
  ).pluck().get("space_a", "代码开发") ?? 0);
  const before = Number(database.db.prepare(`SELECT COUNT(*) FROM pm_topics`).pluck().get() ?? 0);
  const pending = store.commitChangeSet({
    spaceId: "space_a",
    taskId: `side_${id}`,
    sourceBatchId: `side_${id}`,
    idempotencyKey: `side_${id}`,
    topics: [{
      op: "create",
      topicId: id,
      domain: "代码开发",
      expectedTopicSeq: seq,
      topicName: "旁路推送",
      topicSummary: "另一位成员写下的推送结论",
      topicDescription: "",
      decisions: [{
        op: "add",
        decisionId: `dec_${id}`,
        content: "旁路成员先写下了推送结论。",
        time: "2026-10-29T10:30:00+08:00",
        userIds: ["user_x"]
      }],
      experiences: [],
      timelineAppend: [],
      sourcesAppend: []
    }]
  }, { acceptedAt: new Date().toISOString() });
  void pending.catch(() => undefined);
  const after = Number(database.db.prepare(`SELECT COUNT(*) FROM pm_topics`).pluck().get() ?? 0);
  if (after !== before + 1) throw new Error(`side topic ${id} was not written`);
}

function instructionsOf(payload: Record<string, unknown>): string {
  const space = payload.space;
  if (!space || typeof space !== "object") return "";
  const instructions = (space as { instructions?: string | null }).instructions;
  return instructions ?? "";
}

describe("project memory task resubmit", () => {
  it("organizes the same text twice when the clock advances two seconds and chat_time is omitted", async () => {
    const stub = stubStages(combinedStages(() => decisionReply("推送失败后继续按上面的方案做。")));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    const body = {
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("继续按上面的方案做")]
    };

    const first = await add(service, body);
    await drain(service);
    vi.setSystemTime(new Date("2026-11-10T02:00:02.000Z"));
    const second = await add(service, body);
    await drain(service);

    expect(second).not.toBe(first);
    for (const taskId of [first, second]) {
      expect((await call(service, "get/status", { task_id: taskId })).data.status).toBe("completed");
    }
    expect(stub.extract).toHaveLength(2);
    expect(rawTurns(db)).toHaveLength(2);
    expect(new Set(rawTurns(db)).size).toBe(2);
    const keys = changesetKeys(db);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("keeps one task when the same text arrives again without moving the clock", async () => {
    const stub = stubStages(combinedStages(() => decisionReply("推送失败后继续按上面的方案做。")));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    const body = {
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("继续按上面的方案做")]
    };

    const first = await add(service, body);
    await drain(service);
    const second = await add(service, body);

    expect(second).toBe(first);
    expect(stub.extract).toHaveLength(1);
    expect(rawTurns(db)).toHaveLength(1);
  });

  it("keeps one task when the clock moves by less than a second", async () => {
    const stub = stubStages(combinedStages(() => decisionReply("推送失败后继续按上面的方案做。")));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    const body = {
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("继续按上面的方案做")]
    };

    const first = await add(service, body);
    await drain(service);
    vi.setSystemTime(new Date("2026-11-10T02:00:00.500Z"));
    const second = await add(service, body);

    expect(second).toBe(first);
    expect(stub.extract).toHaveLength(1);
    expect(rawTurns(db)).toHaveLength(1);
  });

  it("returns the original task when the same chat_time is replayed after completion", async () => {
    const stub = stubStages(combinedStages(() => decisionReply("推送失败后继续按上面的方案做。")));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    const body = {
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("继续按上面的方案做", "2026-10-29 10:00:00")]
    };

    const first = await add(service, body);
    await drain(service);
    vi.setSystemTime(new Date("2026-11-10T05:00:00.000Z"));
    const second = await add(service, body);

    expect(second).toBe(first);
    expect(stub.extract).toHaveLength(1);
    expect((await call(service, "get/status", { task_id: second })).data.status).toBe("completed");
  });

  it("can resubmit a configuration failure after the model is configured", async () => {
    stubStages(combinedStages(() => decisionReply("推送失败后重试五次。")));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    const llm = (service as unknown as { llm: { isConfigured(): boolean } }).llm;
    const configured = vi.spyOn(llm, "isConfigured").mockReturnValue(false);
    const body = { conversation_id: "config_retry", space_ids: ["space_a"], messages: [message("推送失败后重试五次", "2026-11-13T10:00:00Z")] };
    const first = await add(service, body);
    await drain(service);
    expect((await call(service, "get/status", { task_id: first })).data.error).toMatchObject({ reason: "MODEL_NOT_CONFIGURED" });
    configured.mockRestore();
    const second = await add(service, body);
    expect(second).not.toBe(first);
    await drain(service);
    expect((await call(service, "get/status", { task_id: second })).data.status).toBe("completed");
  });

  it("opens a new task after MODEL_CALL_FAILED and then replays that task", async () => {
    stubStages(combinedStages(() => {
      throw new Error("model down");
    }));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    const body = {
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("继续按上面的方案做", "2026-10-29 10:00:00")]
    };

    const first = await add(service, body);
    await drain(service);
    expect((await call(service, "get/status", { task_id: first })).data.error).toMatchObject({ reason: "MODEL_CALL_FAILED" });

    const working = stubStages(combinedStages(() => decisionReply("推送失败后继续按上面的方案做。")));
    const second = await add(service, body);
    await drain(service);
    const third = await add(service, body);

    expect(second).not.toBe(first);
    expect(third).toBe(second);
    expect((await call(service, "get/status", { task_id: first })).data.status).toBe("failed");
    expect((await call(service, "get/status", { task_id: second })).data.status).toBe("completed");
    expect((await call(service, "get/memory", { space_id: "space_a" })).data.total).toBe(1);
    expect(working.extract).toHaveLength(1);
    const rows = db.db.prepare(`SELECT task_id, batch_key, status FROM pm_tasks`).all() as Array<{
      task_id: string;
      batch_key: string;
      status: string;
    }>;
    const failed = rows.find((row) => row.task_id === first);
    const completed = rows.find((row) => row.task_id === second);
    expect(failed).toMatchObject({ status: "failed" });
    expect(completed).toMatchObject({ status: "completed" });
    expect(failed!.batch_key).toBe(`${completed!.batch_key}#${first}`);
  });

  it("can fail twice and resubmit again without duplicating the completed write", async () => {
    stubStages(combinedStages(() => { throw new Error("model down"); }));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    const body = { conversation_id: "retry_twice", space_ids: ["space_a"], messages: [message("推送重试三次", "2026-10-29 10:00:00")] };
    const first = await add(service, body);
    await drain(service);
    const second = await add(service, body);
    await drain(service);
    stubStages(combinedStages(() => decisionReply("推送重试三次。")));
    const third = await add(service, body);
    await drain(service);
    expect(new Set([first, second, third]).size).toBe(3);
    for (const id of [first, second]) expect((await call(service, "get/status", { task_id: id })).data.status).toBe("failed");
    expect((await call(service, "get/status", { task_id: third })).data.status).toBe("completed");
    expect(await add(service, body)).toBe(third);
    expect((await call(service, "get/memory", { space_id: "space_a" })).data.total).toBe(1);
  });

  it("records each conflict kind and writes the batch after the injector stops", async () => {
    const { service, db } = harness.createService();
    const side = new SqliteProjectMemoryStore({ db: db.db, now: () => new Date() });
    let inject = true;
    const stages = combinedStages(() => decisionReply("推送失败后继续按上面的方案做。"));
    const stub = stubStages({
      extract: (payload, call) => stages.extract(payload, call),
      assign: (payload, call) => {
        if (inject) writeSideTopic(side, db, `topic_side_${call}`);
        return stages.assign(payload, call);
      },
      judge: (payload, call) => stages.judge(payload, call)
    });
    await setupSpace(service, "space_a");
    const body = {
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("继续按上面的方案做", "2026-10-29 11:00:00")]
    };

    const first = await add(service, body);
    await drain(service);
    const failed = await call(service, "get/status", { task_id: first });
    expect(failed.data.status).toBe("failed");
    expect(failed.data.error).toMatchObject({
      reason: "VERSION_CONFLICT_RETRY_EXHAUSTED",
      detail: "TOPIC_SET_CHANGED,TOPIC_SET_CHANGED,TOPIC_SET_CHANGED; topics=topic_side_1,topic_side_2,topic_side_3"
    });
    expect(stub.extract).toHaveLength(1);
    expect(stub.assign).toHaveLength(3);

    inject = false;
    const second = await add(service, body);
    await drain(service);
    expect(second).not.toBe(first);
    expect((await call(service, "get/status", { task_id: second })).data.status).toBe("completed");
    expect((await call(service, "get/status", { task_id: first })).data.status).toBe("failed");
    expect(JSON.stringify(await call(service, "get/memory", { space_id: "space_a" }))).toContain("推送失败后继续按上面的方案做。");
    expect(stub.extract).toHaveLength(2);
    expect(stub.assign).toHaveLength(4);
  });

  it("does not store deferred rows until a resubmit commits", async () => {
    const { service, db } = harness.createService();
    const side = new SqliteProjectMemoryStore({ db: db.db, now: () => new Date() });
    let inject = true;
    const stages = combinedStages(() => decisionReply("推送失败后继续按上面的方案做。", [
      { text: "推送通道还没定。", reason: "work_unresolved" }
    ]));
    stubStages({
      extract: (payload, call) => stages.extract(payload, call),
      assign: (payload, call) => {
        if (inject) writeSideTopic(side, db, `topic_defer_${call}`);
        return stages.assign(payload, call);
      },
      judge: (payload, call) => stages.judge(payload, call)
    });
    await setupSpace(service, "space_a");
    const body = {
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("继续按上面的方案做", "2026-10-29 12:00:00")]
    };

    const first = await add(service, body);
    await drain(service);
    expect((await call(service, "get/status", { task_id: first })).data.error.reason).toBe("VERSION_CONFLICT_RETRY_EXHAUSTED");
    expect(db.db.prepare(`SELECT COUNT(*) FROM pm_deferred_segments`).pluck().get()).toBe(0);

    inject = false;
    const second = await add(service, body);
    await drain(service);
    expect((await call(service, "get/status", { task_id: second })).data.status).toBe("completed");
    expect(db.db.prepare(`SELECT segment FROM pm_deferred_segments`).pluck().all()).toEqual(["推送通道还没定。"]);
  });

  it("returns the same task when the space was cleared before the job ran", async () => {
    stubStages(combinedStages(() => decisionReply("推送失败后继续按上面的方案做。")));
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    const body = {
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("继续按上面的方案做", "2026-10-29 13:00:00")]
    };

    const first = await add(service, body);
    vi.setSystemTime(new Date("2026-11-10T04:00:00.000Z"));
    expect((await call(service, "delete/memory", { space_id: "space_a" })).code).toBe(0);
    await drain(service);
    expect((await call(service, "get/status", { task_id: first })).data.error).toMatchObject({ reason: "SPACE_CLEARED" });

    const second = await add(service, body);
    expect(second).toBe(first);
    expect((await call(service, "get/status", { task_id: second })).data.status).toBe("failed");
  });

  it("returns the running task and does not enqueue a second job", async () => {
    const stub = stubStages(combinedStages(() => decisionReply("推送失败后继续按上面的方案做。")));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    const body = {
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("继续按上面的方案做", "2026-10-29 14:00:00")]
    };

    const first = await add(service, body);
    const second = await add(service, body);
    expect(second).toBe(first);
    expect(db.db.prepare(
      `SELECT COUNT(*) FROM evolution_jobs WHERE job_type = 'project_memory_organize'`
    ).pluck().get()).toBe(1);

    await drain(service);
    expect(stub.extract).toHaveLength(1);
    expect((await call(service, "get/status", { task_id: first })).data.status).toBe("completed");
  });

  it("resubmits only the space whose model call failed", async () => {
    const stages = combinedStages(() => decisionReply("推送失败后继续按上面的方案做。"));
    let failSpaceB = true;
    const stub = stubStages({
      extract(payload, call) {
        if (failSpaceB && instructionsOf(payload) === "space_b") throw new Error("model down");
        return stages.extract(payload, call);
      },
      assign: (payload, call) => stages.assign(payload, call),
      judge: (payload, call) => stages.judge(payload, call)
    });
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    await setupSpace(service, "space_b");
    expect((await call(service, "update/space", { space_id: "space_a", instructions: "space_a" })).code).toBe(0);
    expect((await call(service, "update/space", { space_id: "space_b", instructions: "space_b" })).code).toBe(0);
    const body = {
      conversation_id: "c1",
      space_ids: ["space_a", "space_b"],
      messages: [message("继续按上面的方案做", "2026-10-29 15:00:00")]
    };

    const first = await add(service, body);
    await drain(service);
    expect((await call(service, "get/status", { task_id: first })).data.status).toBe("failed");
    const spaceAExtracts = () => stub.extract.filter((payload) => instructionsOf(payload) === "space_a").length;
    const spaceATopics = async () => (await call(service, "get/memory", { space_id: "space_a" })).data.total as number;
    expect(spaceAExtracts()).toBe(1);
    expect(await spaceATopics()).toBe(1);

    failSpaceB = false;
    const second = await add(service, body);
    expect(second).not.toBe(first);
    const queued = db.db.prepare(
      `SELECT json_extract(payload_json, '$.spaceId') AS space_id
       FROM evolution_jobs WHERE json_extract(payload_json, '$.taskId') = ?`
    ).pluck().all(second);
    expect(queued).toEqual(["space_b"]);
    const progress = JSON.parse(String(db.db.prepare(`SELECT progress_json FROM pm_tasks WHERE task_id = ?`).pluck().get(second))) as {
      space_a: { status: string; memoryIds: string[]; added: number; updated: number; resubmitOf?: string };
      space_b: { status: string };
    };
    expect(progress.space_a).toMatchObject({ status: "completed", memoryIds: [], added: 0, updated: 0, resubmitOf: first });
    expect(progress.space_b.status).toBe("running");
    expect(JSON.stringify(await call(service, "get/status", { task_id: second }))).not.toContain("resubmitOf");

    await drain(service);
    expect((await call(service, "get/status", { task_id: second })).data.status).toBe("completed");
    expect(spaceAExtracts()).toBe(1);
    expect(await spaceATopics()).toBe(1);
    expect((await call(service, "get/memory", { space_id: "space_b" })).data.total).toBe(1);
    expect((await call(service, "get/status", { task_id: first })).data.status).toBe("failed");
  });

  it("returns the original task when any space failed for a reason that cannot be retried", async () => {
    stubStages(combinedStages(() => decisionReply("推送失败后继续按上面的方案做。")));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    await setupSpace(service, "space_b");
    const body = {
      conversation_id: "c1",
      space_ids: ["space_a", "space_b"],
      messages: [message("继续按上面的方案做", "2026-10-29 16:00:00")]
    };

    const first = await add(service, body);
    vi.setSystemTime(new Date("2026-11-10T04:00:00.000Z"));
    expect((await call(service, "delete/memory", { space_id: "space_b" })).code).toBe(0);
    await drain(service);
    expect((await call(service, "get/status", { task_id: first })).data.error).toMatchObject({ reason: "SPACE_CLEARED" });
    expect((await call(service, "get/memory", { space_id: "space_a" })).data.total).toBe(1);

    const second = await add(service, body);
    expect(second).toBe(first);
    expect(db.db.prepare(`SELECT COUNT(*) FROM pm_tasks`).pluck().get()).toBe(1);
  });
});

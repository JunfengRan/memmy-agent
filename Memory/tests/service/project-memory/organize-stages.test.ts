import { afterEach, describe, expect, it } from "vitest";
import { PROJECT_MEMORY_LIMITS } from "../../../src/service/project-memory/contract/limits.js";
import type { RecallRequest } from "../../../src/service/project-memory/contract/types.js";
import { unionCandidates } from "../../../src/service/project-memory/organize/candidates.js";
import { buildJudgeMessages } from "../../../src/service/project-memory/merge/judge.js";
import { SqliteProjectMemoryStore } from "../../../src/service/project-memory/store/sqlite/sqlite-store.js";
import { call, combinedStages, createProjectMemoryHarness, drain, emptyReply, setupSpace, stubStages, type OrganizePayload } from "./helpers.js";

const harness = createProjectMemoryHarness();
afterEach(() => harness.cleanup());

function message(user: string, time: string, content: string) {
  return { role: "user", role_id: user, role_name: user, chat_time: time, content };
}

function newTopic(payload: OrganizePayload, content: string): Record<string, unknown> {
  return {
    ...emptyReply(),
    drafts: [{
      kind: "decision",
      content,
      message_idx: 0,
      user_ids: [payload.messages[0]!.user_id],
      topic: { new_topic: "n1" }
    }],
    new_topics: [{ ref: "n1", topic_name: "推送服务重试", topic_summary: "推送失败后的重试策略", topic_description: "" }]
  };
}

describe("merge candidate union", () => {
  it("keeps a topic that only the second query returns, drops ranks past the cap, and keeps mustConsider", () => {
    const onlySecond = unionCandidates([
      [{ topicId: "push", rank: 0 }],
      [{ topicId: "only-second", rank: 0 }, { topicId: "push", rank: 2 }]
    ], new Set(), 20);
    expect(onlySecond).toContain("only-second");
    expect(onlySecond).toContain("push");

    const many = Array.from({ length: 25 }, (_, rank) => ({ topicId: `t${String(rank).padStart(2, "0")}`, rank }));
    const kept = unionCandidates([many], new Set(["t24", "t00"]), PROJECT_MEMORY_LIMITS.mergeCandidateCap);
    expect(PROJECT_MEMORY_LIMITS.mergeCandidateCap).toBe(20);
    expect(kept).toHaveLength(21);
    expect(kept.slice(0, 20)).toEqual(many.slice(0, 20).map((hit) => hit.topicId));
    expect(kept).toContain("t24");
    expect(kept).not.toContain("t23");
    expect(kept.filter((id) => id === "t00")).toHaveLength(1);
  });
});

describe("project memory organize stages", () => {
  it("gives M05 the current summary and description that it is responsible for updating", () => {
    const messages = buildJudgeMessages({ drafts: [], conflictsShown: new Set(), stateHints: [], topics: [{
      topicId: "topic_retry", spaceId: "space_a", domain: "工程", topicName: "推送",
      topicSummary: "推送失败的重试策略", topicDescription: "发送失败最多重试三次。",
      decisions: [], experiences: [], timeline: [], sources: [], revision: 1,
      createTime: "2026-11-12T00:00:00Z", updateTime: "2026-11-12T00:00:00Z"
    }] });
    expect(JSON.parse(messages[1]!.content).topics[0]).toMatchObject({
      topic_summary: "推送失败的重试策略", topic_description: "发送失败最多重试三次。"
    });
  });

  it("strips closed injection blocks before M02 and counts them on the task details", async () => {
    const stub = stubStages(combinedStages(() => emptyReply()));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    const accepted = await call(service, "add/message", {
      user_id: "user_a",
      agent_id: "codex",
      conversation_id: "c_strip",
      space_ids: ["space_a"],
      allow_memory_view: ["project"],
      messages: [{
        role: "assistant",
        role_id: "user_a",
        role_name: "用户A",
        chat_time: "2026-10-29 10:00:00",
        content: [
          { type: "text", text: "前文<project_index>索引</project_index>后文" },
          "<memos_context v=\"1\" kind=\"turn\">旧结论</memos_context> <memos_context v=\"1\" kind=\"tool\">没关"
        ],
        tool_calls: [{
          function: {
            name: "search_project_memory",
            arguments: "<memos_context v=\"1\" kind=\"tool\">参数</memos_context>"
          }
        }]
      }]
    });
    expect(accepted.code).toBe(0);
    await drain(service);
    const request = JSON.stringify(stub.extract[0]);
    expect(request).not.toContain("</memos_context>");
    expect(request).not.toContain("</project_index>");
    expect(request).not.toContain("<project_index");
    expect(request).toContain("前文");
    expect(request).toContain("后文");
    expect(request).toContain("没关");
    expect(request).not.toContain("参数");
    const taskId = accepted.data.task_id as string;
    const row = db.db.prepare(`SELECT progress_json FROM pm_tasks WHERE task_id = ?`).get(taskId) as { progress_json: string };
    const details = (JSON.parse(row.progress_json) as {
      space_a: { details: { strippedBlocks: number; unclosedBlocks: number } };
    }).space_a.details;
    expect(details.strippedBlocks).toBe(3);
    expect(details.unclosedBlocks).toBe(1);
    const stored = db.db.prepare(`SELECT tool_calls_json FROM pm_raw_turns WHERE task_id = ?`).get(taskId) as { tool_calls_json: string };
    expect(stored.tool_calls_json).not.toContain("</memos_context>");
    expect(stored.tool_calls_json).not.toContain("参数");
  });

  it("stops after extract when the model returns no drafts", async () => {
    const stub = stubStages(combinedStages(() => emptyReply()));
    const { service } = harness.createService();
    const store = (service as unknown as { projectMemory: { store: SqliteProjectMemoryStore } }).projectMemory.store;
    const recalls: RecallRequest[] = [];
    const original = store.recall.bind(store);
    store.recall = async (request) => {
      recalls.push(request);
      return original(request);
    };
    await setupSpace(service, "space_a");
    const taskId = await call(service, "add/message", {
      user_id: "user_a",
      agent_id: "codex",
      conversation_id: "c1",
      space_ids: ["space_a"],
      allow_memory_view: ["project"],
      messages: [message("user_a", "2026-10-29 10:00:00", "你好")]
    });
    expect(taskId.code).toBe(0);
    await drain(service);

    expect(stub.extract).toHaveLength(1);
    expect(stub.assign).toHaveLength(0);
    expect(stub.judge).toHaveLength(0);
    expect(recalls.filter((request) => request.purpose === "merge")).toHaveLength(0);
    expect((await call(service, "get/status", { task_id: taskId.data.task_id })).data.status).toBe("completed");
  });

  it("recalls one query per draft and still offers a topic only the second query hits", async () => {
    const first = "推送失败后指数退避重试三次。";
    const second = "告警静默窗口调到十分钟。";
    const stub = stubStages(combinedStages(() => ({
      ...emptyReply(),
      drafts: [
        { kind: "decision", content: first, message_idx: 0, topic: { new_topic: "n1" } },
        { kind: "timeline", content: second, message_idx: 0, topic: { new_topic: "n2" } }
      ],
      new_topics: [
        { ref: "n1", topic_name: "推送服务重试", topic_summary: "推送失败后的重试策略", topic_description: "" },
        { ref: "n2", topic_name: "告警静默", topic_summary: "告警静默窗口的时长", topic_description: "" }
      ]
    })), { embeddings: "fail" });
    const { service } = harness.createService();
    const store = (service as unknown as { projectMemory: { store: SqliteProjectMemoryStore } }).projectMemory.store;
    await setupSpace(service, "space_a");
    const topics = [
      ...Array.from({ length: 11 }, (_, index) => ({
        op: "create" as const,
        topicId: `topic_push_${index}`,
        domain: "代码开发",
        expectedTopicSeq: 0,
        topicName: `推送通道${index}`,
        topicSummary: `推送通道 ${index} 失败后的重试`,
        topicDescription: "",
        decisions: [{ op: "add" as const, decisionId: `dec_push_${index}`, content: `推送通道 ${index} 失败后重试。`, time: "2026-10-28T10:00:00+08:00", userIds: ["user_a"] }],
        experiences: [],
        timelineAppend: [],
        sourcesAppend: []
      })),
      {
        op: "create" as const,
        topicId: "topic_alert",
        domain: "代码开发",
        expectedTopicSeq: 0,
        topicName: "告警静默",
        topicSummary: "告警静默窗口的时长",
        topicDescription: "",
        decisions: [{ op: "add" as const, decisionId: "dec_alert", content: "告警静默窗口默认为 5 分钟。", time: "2026-10-28T10:00:00+08:00", userIds: ["user_a"] }],
        experiences: [],
        timelineAppend: [],
        sourcesAppend: []
      }
    ];
    const seeded = await store.commitChangeSet({
      spaceId: "space_a",
      taskId: "seed",
      sourceBatchId: "seed",
      idempotencyKey: "seed-topics",
      topics
    }, { acceptedAt: new Date().toISOString() });
    expect(seeded.ok).toBe(true);

    const recalls: RecallRequest[] = [];
    const hits: Array<{ qid: string; ids: string[] }> = [];
    const original = store.recall.bind(store);
    store.recall = async (request) => {
      const result = await original(request);
      if (request.purpose === "merge") {
        recalls.push(request);
        for (const row of result.results) hits.push({ qid: row.qid, ids: row.topics.map((topic) => topic.topicId) });
      }
      return result;
    };

    const accepted = await call(service, "add/message", {
      user_id: "user_a",
      agent_id: "codex",
      conversation_id: "c1",
      space_ids: ["space_a"],
      allow_memory_view: ["project"],
      messages: [message("user_a", "2026-10-29 10:00:00", "推送和告警各记一笔。")]
    });
    expect(accepted.code).toBe(0);
    await drain(service);

    expect(recalls).toHaveLength(1);
    expect(recalls[0]!.queries).toEqual([
      { qid: "d0", text: first },
      { qid: "d1", text: second }
    ]);
    expect(hits.find((row) => row.qid === "d0")!.ids).not.toContain("topic_alert");
    expect(hits.find((row) => row.qid === "d1")!.ids).toContain("topic_alert");
    const candidates = stub.assign[0]!.candidates as Array<Record<string, unknown>>;
    expect(candidates.map((topic) => topic.topic_id)).toContain("topic_alert");
    for (const candidate of candidates) {
      expect(Object.keys(candidate).sort()).toEqual(["domain", "topic_description", "topic_id", "topic_summary"]);
      expect(candidate).not.toHaveProperty("decisions");
      expect(candidate).not.toHaveProperty("entries");
    }
  });

  it("tells M04 when vector recall degraded", async () => {
    const stub = stubStages(combinedStages((payload) => newTopic(payload, "推送失败后指数退避重试三次。")), { embeddings: "fail" });
    const { service } = harness.createService();
    await setupSpace(service, "space_a");
    const accepted = await call(service, "add/message", {
      user_id: "user_a",
      agent_id: "codex",
      conversation_id: "c1",
      space_ids: ["space_a"],
      allow_memory_view: ["project"],
      messages: [message("user_a", "2026-10-29 10:00:00", "推送失败就指数退避重试三次。")]
    });
    expect(accepted.code).toBe(0);
    await drain(service);
    expect(stub.assign[0]!.degraded).toEqual(["vector"]);
  });

  it("keeps assignment and op basis in progress_json and out of get/status", async () => {
    stubStages(combinedStages((payload) => ({
      ...newTopic(payload, "推送失败后指数退避重试三次。"),
      dropped: [{ reason: "unrelated", text: "收到" }]
    })));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    const accepted = await call(service, "add/message", {
      user_id: "user_a",
      agent_id: "codex",
      conversation_id: "c1",
      space_ids: ["space_a"],
      allow_memory_view: ["project"],
      messages: [message("user_a", "2026-10-29 10:00:00", "推送失败就指数退避重试三次。")]
    });
    expect(accepted.code).toBe(0);
    await drain(service);
    const taskId = accepted.data.task_id as string;
    const row = db.db.prepare(`SELECT progress_json FROM pm_tasks WHERE task_id = ?`).get(taskId) as { progress_json: string };
    const details = (JSON.parse(row.progress_json) as { space_a: { details: {
      assignments: Array<{ basis: { independentDelivery: boolean; affectsExistingDecisions: boolean } }>;
      dropped: Array<{ reason: string; text: string | null }>;
      ops: Array<{ basis: { draftId: string; hit: string | null; checked: string[] } }>;
    } } }).space_a.details;
    expect(details.assignments[0]!.basis).toEqual({ independentDelivery: true, affectsExistingDecisions: false });
    expect(details.dropped).toEqual([{ reason: "unrelated", text: "收到" }]);
    expect(details.ops[0]!.basis).toEqual({ draftId: "d0", hit: null, checked: [] });

    const status = await call(service, "get/status", { task_id: taskId });
    const body = JSON.stringify(status);
    expect(body).not.toContain("independentDelivery");
    expect(body).not.toContain("affectsExistingDecisions");
    expect(body).not.toContain("basis");
    expect(status.data.status).toBe("completed");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { assignRelativity } from "../../../src/service/project-memory/retrieve/search.js";
import { call, combinedStages, createProjectMemoryHarness, drain, emptyReply, setupSpace, stubStages, type OrganizePayload } from "./helpers.js";

const harness = createProjectMemoryHarness();
afterEach(() => harness.cleanup());

const TOPICS = [
  { name: "推送服务重试", summary: "推送失败后的重试策略", decision: "推送失败后指数退避重试三次，间隔 1s/2s/4s。" },
  { name: "日志采样", summary: "线上日志的采样比例", decision: "线上日志按 10% 采样，错误日志全量保留。" },
  { name: "灰度发布", summary: "新版本灰度发布流程", decision: "灰度先放 5% 流量，观察 30 分钟再全量。" }
];

/** Each batch opens a fresh topic carrying the message as its decision. */
function topicPerBatch(payload: OrganizePayload): Record<string, unknown> {
  const topic = TOPICS.find((item) => item.decision === payload.messages[0]!.content)!;
  return {
    ...emptyReply(),
    drafts: [{ kind: "decision", content: topic.decision, message_idx: 0, user_ids: [payload.messages[0]!.user_id], topic: { new_topic: "n1" } }],
    new_topics: [{ ref: "n1", topic_name: topic.name, topic_summary: topic.summary, topic_description: "" }]
  };
}

async function seed(embeddings: "ok" | "fail") {
  const stub = stubStages(combinedStages(topicPerBatch), { embeddings });
  const { service, db } = harness.createService();
  await setupSpace(service, "space_a");
  for (const [index, topic] of TOPICS.entries()) {
    const accepted = await call(service, "add/message", {
      user_id: "user_a",
      agent_id: "codex",
      conversation_id: `c${index}`,
      space_ids: ["space_a"],
      allow_memory_view: ["project"],
      messages: [{ role: "user", role_id: "user_a", chat_time: `2026-10-2${index + 1} 10:00:00`, content: topic.decision }]
    });
    expect(accepted.code).toBe(0);
    await drain(service);
  }
  return { service, db, stub };
}

function search(service: Parameters<typeof call>[0], body: Record<string, unknown> = {}) {
  return call(service, "search/memory", {
    user_id: "user_a",
    query: "推送失败以后怎么重试？",
    space_ids: ["space_a"],
    include_memory_view: ["project"],
    ...body
  });
}

describe("project memory search", () => {
  it("returns the same ranked topics for the same input and logs what it showed", async () => {
    const { service, db, stub } = await seed("ok");
    expect(stub.embeddingCalls).toBeGreaterThan(0);
    expect(db.db.prepare("SELECT COUNT(*) FROM pm_topic_vectors").pluck().get()).toBe(TOPICS.length);

    const first = await search(service, { conversation_id: "conv_search" });
    const second = await search(service, { conversation_id: "conv_search" });
    expect(first.code).toBe(0);
    expect(first.data.degraded).toBeUndefined();
    expect(second.data).toEqual(first.data);

    const top = first.data.topic_detail_list[0];
    expect(top.topic_name).toBe("推送服务重试");
    expect(top.decisions).toEqual([{
      content: "推送失败后指数退避重试三次，间隔 1s/2s/4s。",
      time: "2026-10-21T10:00:00+08:00",
      user_ids: ["user_a"]
    }]);
    const scores = first.data.topic_detail_list.map((topic: { relativity: number }) => topic.relativity);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores[0]).toBeGreaterThan(0);

    const logged = db.db.prepare("SELECT conversation_id, via FROM pm_recall_log").all() as Array<{ conversation_id: string; via: string }>;
    expect(logged.length).toBeGreaterThan(0);
    expect(new Set(logged.map((row) => row.conversation_id))).toEqual(new Set(["conv_search"]));
  });

  it("caps results at memory_limit_number and filters by relativity", async () => {
    const { service } = await seed("ok");
    const capped = await search(service, { memory_limit_number: 1 });
    expect(capped.data.topic_detail_list).toHaveLength(1);

    const strict = await search(service, { relativity: 0.99 });
    expect(strict.data.topic_detail_list.every((topic: { relativity: number }) => topic.relativity >= 0.99)).toBe(true);

    expect((await search(service, { memory_limit_number: 26 })).code).toBe(40001);
  });

  it("filters relativity on each topic's own relevance and keeps the list monotonic", () => {
    // MMR placed a weaker topic first; the stronger one behind it must survive the threshold.
    const ordered = [{ id: "weak", relevance: 0.4 }, { id: "strong", relevance: 0.9 }, { id: "noise", relevance: 0.2 }];

    const kept = assignRelativity(ordered, 0.5);
    expect(kept.map(({ item }) => item.id)).toEqual(["strong"]);
    expect(kept[0]!.relativity).toBe(0.9);

    const all = assignRelativity(ordered);
    expect(all.map(({ item, relativity }) => [item.id, relativity])).toEqual([["weak", 0.4], ["strong", 0.4], ["noise", 0.2]]);
    expect(assignRelativity(ordered, 0.4).every(({ relativity }) => relativity >= 0.4)).toBe(true);
  });

  it("falls back to lexical recall and reports it when embeddings are unavailable", async () => {
    const { service } = await seed("fail");
    const result = await search(service);
    expect(result.code).toBe(0);
    expect(result.data.degraded).toEqual(["vector"]);
    expect(result.data.topic_detail_list[0].topic_name).toBe("推送服务重试");
    expect((await search(service)).data).toEqual(result.data);
  });
});

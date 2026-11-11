import { describe, expect, it } from "vitest";
import type { RecallTopic, TopicSnapshot } from "../../../src/service/project-memory/contract/types.js";
import { rankProjectCandidates, scoreProjectTopics } from "../../../src/service/project-memory/retrieve/search.js";

function topic(id: string, lexical: number | null, vector: number | null, updateTime: string, entries: RecallTopic["entries"] = []): RecallTopic {
  return {
    topicId: id,
    spaceId: "space",
    revision: 1,
    domain: "代码开发",
    topicName: id,
    topicSummary: "",
    topicDescription: "",
    updateTime,
    hasConversation: false,
    scores: { lexical, vector },
    entries
  };
}

describe("scoreProjectTopics", () => {
  it("orders by fused score and breaks ties by topic id", () => {
    const topics = [
      topic("b", null, 1, "2026-10-21T00:00:00.000Z"),
      topic("a", 1, null, "2026-10-21T00:00:00.000Z"),
      topic("c", 0.1, null, "2026-10-01T00:00:00.000Z")
    ];
    const scored = scoreProjectTopics("月报", topics);
    expect(scored.map((item) => item.topic.topicId)).toEqual(["a", "b", "c"]);
    expect(scored[0]?.fused).toBe(scored[1]?.fused);
    expect(scored[2]!.fused).toBeLessThan(scored[0]!.fused);
  });

  it("drops an entry that misses the lexical hit floor and keeps the score", () => {
    const scored = scoreProjectTopics("月报 客户 金额 过滤 汇总", [
      topic("t", 1, null, "2026-10-21T00:00:00.000Z", [
        { kind: "decision", id: "keep", scores: { lexical: 1, vector: null } },
        { kind: "decision", id: "drop", scores: { lexical: 0, vector: null } }
      ])
    ]);
    expect(scored[0]?.entries.map((entry) => entry.id)).toEqual(["keep"]);
    expect(scored[0]?.entryScores.find((item) => item.entry.id === "drop")?.kept).toBe(false);
  });

  it("matches rankProjectCandidates order when the decision router is off", async () => {
    const topics = [
      topic("low", 0.2, null, "2026-10-01T00:00:00.000Z"),
      topic("high", 0.9, 0.9, "2026-10-21T00:00:00.000Z")
    ];
    const store = {
      recall: async () => ({ results: [{ qid: "q", topics }], topicSeq: {}, degraded: [] }),
      getTopicsFull: async (_spaceId: string | null, ids: string[]) => ids.map((id) => ({ topicId: id }) as TopicSnapshot)
    };
    const ranked = await rankProjectCandidates({
      userId: "u",
      spaceIds: ["space"],
      query: "月报",
      memoryLimit: 9,
      views: { userMemory: false, agentLayers: [], project: true }
    }, { store: store as never });
    expect(ranked.candidates.map((item) => item.id)).toEqual(scoreProjectTopics("月报", topics).map((item) => item.topic.topicId));
  });
});

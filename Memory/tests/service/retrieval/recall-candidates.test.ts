import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type MemoryService } from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import type { MemoryRow } from "../../../src/types.js";
import { countRows, createMemoryServiceFixture, byokRuntimeConfig } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

describe("recallCandidates", () => {
  it("does not call the chat model, and ignores context budget and wall-clock time", async () => {
    const chats = stubModelFetch();
    const { db, service } = createRecallService();
    const repos = new Repositories(db.db);
    repos.memories.insert(traceMemory("l1-old", "clockorder clockorder clockorder", "2026-03-01T00:00:00.000Z", 1));
    repos.memories.insert(traceMemory("l1-recent", "clockorder", "2026-06-01T00:00:00.000Z", 1));
    const before = countRows(db, "recall_events");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));
    const tight = await recall(service, { query: "clockorder", layers: ["L1"], contextBudget: 1 });
    const wide = await recall(service, { query: "clockorder", layers: ["L1"], contextBudget: 100_000 });
    expect(wide).toEqual(tight);
    expect(tight.candidates.map((item) => item.id).sort()).toEqual(["l1-old", "l1-recent"]);

    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    const later = await recall(service, { query: "clockorder", layers: ["L1"], contextBudget: 8_000 });
    expect(later.candidates.map((item) => item.id)).toEqual(tight.candidates.map((item) => item.id));
    // Rank for fusion is this order. Relativity is applied later; the port still returns score.
    expect(tight.candidates.every((item) => typeof item.score === "number" && !("relativity" in item))).toBe(true);
    expect(chats.count).toBe(0);
    expect(countRows(db, "recall_events")).toBe(before);
    db.close();
  });

  it("returns only the requested layers", async () => {
    stubModelFetch();
    const { db, service } = createRecallService();
    const repos = new Repositories(db.db);
    repos.memories.insert(traceMemory("l1-layer", "layermarker in the trace", "2026-05-01T00:00:00.000Z", 0.4));
    repos.memories.insert(skillMemory("skill-layer", "layermarker"));
    repos.userMemories.insert({
      id: "user-layer",
      sourceTurnId: "turn-user-layer",
      userId: "user_a",
      memoryTypes: ["User Fact"],
      content: "layermarker for this user",
      normalizedUserTextHash: "user-layer",
      sourceTurnRefs: ["turn-user-layer"],
      status: "active",
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z"
    });

    const l1 = await recall(service, { query: "layermarker", layers: ["L1"] });
    const skill = await recall(service, { query: "layermarker", layers: ["Skill"] });
    const user = await recall(service, { query: "layermarker", includeUserMemory: true, layers: [] });

    expect(l1.candidates.map((item) => item.layer)).toEqual(["L1"]);
    expect(l1.candidates.map((item) => item.id)).toEqual(["l1-layer"]);
    expect(skill.candidates.map((item) => item.layer)).toEqual(["Skill"]);
    expect(skill.candidates.map((item) => item.id)).toEqual(["skill-layer"]);
    expect(user.candidates.map((item) => item.layer)).toEqual(["UserMemory"]);
    expect(user.candidates.map((item) => item.id)).toEqual(["user-layer"]);
    expect(l1.candidates.every((item) => typeof item.score === "number" && !("relativity" in item))).toBe(true);
    db.close();
  });
});

function createRecallService(): { db: ReturnType<typeof createTestService>["db"]; service: MemoryService } {
  return createTestService({
    config: byokRuntimeConfig({
      algorithm: {
        ...DEFAULT_MEMMY_CONFIG.algorithm,
        enableMemorySearch: true,
        enableQueryRewrite: true,
        retrieval: {
          ...DEFAULT_MEMMY_CONFIG.algorithm.retrieval,
          llmFilterEnabled: true
        }
      }
    })
  });
}

function recall(service: MemoryService, input: {
  query: string;
  includeUserMemory?: boolean;
  layers?: Array<"L1" | "Skill">;
  contextBudget?: number;
}) {
  const retrieval = (service as unknown as {
    retrieval: {
      recallCandidates(request: {
        userId: string;
        query: string;
        limit: number;
        includeUserMemory?: boolean;
        layers?: Array<"L1" | "Skill">;
        contextBudget?: number;
      }): Promise<{ candidates: Array<{ id: string; layer: string; score: number; content: string }> }>;
    };
  }).retrieval;
  return retrieval.recallCandidates({
    userId: "user_a",
    query: input.query,
    limit: 10,
    includeUserMemory: input.includeUserMemory ?? false,
    layers: input.layers ?? [],
    contextBudget: input.contextBudget
  });
}

function stubModelFetch(): { count: number } {
  const chats = { count: 0 };
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/embeddings") || url.includes("byok-token-usage")) {
      return json({ data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1, total_tokens: 1 }, ok: true });
    }
    chats.count += 1;
    return json({ choices: [{ message: { content: JSON.stringify({ queries: ["rewritten query"] }) } }] });
  });
  return chats;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function traceMemory(id: string, text: string, at: string, value: number): MemoryRow {
  return {
    id,
    timeline: at,
    userId: "user_a",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: id,
    memoryValue: text,
    tags: [],
    info: {},
    properties: {
      internal_info: {
        memory_layer: "L1",
        memory_kind: "trace",
        trace: {
          ts: Date.parse(at),
          summary: text,
          userText: text,
          agentText: "",
          value,
          alpha: 0.5,
          episode_id: `episode-${id}`,
          turn_id: `turn-${id}`
        }
      }
    },
    memoryLayer: "L1",
    contentHash: id,
    version: 1,
    createdAt: at,
    updatedAt: at,
    deletedAt: null
  };
}

function skillMemory(id: string, text: string): MemoryRow {
  const at = "2026-05-03T00:00:00.000Z";
  return {
    id,
    timeline: at,
    userId: "user_a",
    memoryType: "SkillMemory",
    status: "activated",
    visibility: "private",
    memoryKey: id,
    memoryValue: text,
    tags: ["skill"],
    info: {},
    properties: {
      internal_info: {
        memory_layer: "Skill",
        memory_kind: "skill",
        skill: {
          name: text,
          status: "active",
          eta: 0.9,
          invocation_guide: text,
          procedure_json: { retrievalBlurb: text, triggerContext: text }
        }
      }
    },
    memoryLayer: "Skill",
    contentHash: id,
    version: 1,
    createdAt: at,
    updatedAt: at,
    deletedAt: null
  };
}

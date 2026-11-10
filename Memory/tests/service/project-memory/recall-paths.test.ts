import { afterEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import type { MemoryRow } from "../../../src/types.js";
import { PROJECT_MEMORY_LIMITS } from "../../../src/service/project-memory/contract/limits.js";
import type { RecallRequest, RecallResult, TopicSnapshot } from "../../../src/service/project-memory/contract/types.js";
import {
  recallSearchPaths,
  type NonProjectRecallInput,
  type NonProjectRecallPort,
  type NonProjectRecallResult,
  type ThreePathSearchOutput
} from "../../../src/service/project-memory/retrieve/recall-paths.js";
import type { MemoryViewSelection, SearchInput } from "../../../src/service/project-memory/retrieve/search.js";
import type { ProjectLocalState } from "../../../src/service/project-memory/store/sqlite/local-state.js";
import type { ProjectMemoryStore } from "../../../src/service/project-memory/store/store.js";
import { call, combinedStages, createProjectMemoryHarness, drain, emptyReply, setupSpace, stubStages } from "./helpers.js";

const harness = createProjectMemoryHarness();
afterEach(() => harness.cleanup());

const PATHS = ["user_memory", "agent_memory", "project"] as const;
type PathName = (typeof PATHS)[number];

const local = { appendRecallLog() {} } as unknown as ProjectLocalState;

const snapshot: TopicSnapshot = {
  topicId: "topic_retry",
  spaceId: "space_a",
  domain: "代码开发",
  topicName: "队列重试",
  topicSummary: "retrybackoff after a push failure",
  topicDescription: "retrybackoff",
  revision: 1,
  createTime: "2026-10-21T10:00:00+08:00",
  updateTime: "2026-10-21T10:00:00+08:00",
  decisions: [{
    id: "dec_1",
    content: "retrybackoff after the push worker fails",
    time: "2026-10-21T10:00:00+08:00",
    userIds: ["user_a"],
    history: [],
    conflicts: []
  }],
  experiences: [],
  timeline: [],
  sources: []
};

function projectRecall(degraded: string[] = []): RecallResult {
  return {
    results: [{
      qid: "q",
      topics: [{
        topicId: snapshot.topicId,
        spaceId: snapshot.spaceId,
        revision: snapshot.revision,
        domain: snapshot.domain,
        topicName: snapshot.topicName,
        topicSummary: snapshot.topicSummary,
        topicDescription: snapshot.topicDescription,
        updateTime: snapshot.updateTime,
        hasConversation: false,
        scores: { lexical: 4, vector: degraded.includes("vector") ? null : 0.8 },
        entries: [{ kind: "decision", id: "dec_1", scores: { lexical: 3, vector: null } }]
      }]
    }],
    topicSeq: {},
    degraded
  };
}

function storeFrom(recall: (request: RecallRequest) => Promise<RecallResult>): { store: ProjectMemoryStore; requests: RecallRequest[] } {
  const requests: RecallRequest[] = [];
  const store = {
    async recall(request: RecallRequest) {
      requests.push(request);
      return recall(request);
    },
    async getTopicsFull() {
      return [snapshot];
    }
  } as unknown as ProjectMemoryStore;
  return { store, requests };
}

function portFrom(handle: (input: NonProjectRecallInput) => Promise<NonProjectRecallResult> | NonProjectRecallResult): {
  port: NonProjectRecallPort;
  calls: NonProjectRecallInput[];
} {
  const calls: NonProjectRecallInput[] = [];
  return {
    calls,
    port: {
      async recallCandidates(input) {
        calls.push(input);
        return handle(input);
      }
    }
  };
}

function ready(input: NonProjectRecallInput): NonProjectRecallResult {
  if (input.includeUserMemory) {
    return {
      vectorDegraded: false,
      candidates: [{ id: "user-1", layer: "UserMemory", content: "retrybackoff habit", score: 0.5, updatedAt: "2026-10-01T00:00:00.000Z" }]
    };
  }
  return {
    vectorDegraded: false,
    candidates: input.layers?.map((layer, index) => ({
      id: layer === "L1" ? "l1-1" : "skill-1",
      layer,
      content: `retrybackoff ${layer}`,
      score: 0.4 - index / 10,
      updatedAt: "2026-10-02T00:00:00.000Z"
    })) ?? []
  };
}

function input(views: MemoryViewSelection, memoryLimit = 9): SearchInput {
  return {
    userId: "user_a",
    spaceIds: ["space_a"],
    query: "retrybackoff",
    memoryLimit,
    views
  };
}

function requestedPaths(views: MemoryViewSelection): PathName[] {
  return [
    ...(views.userMemory ? ["user_memory" as const] : []),
    ...(views.agentLayers.length > 0 ? ["agent_memory" as const] : []),
    ...(views.project ? ["project" as const] : [])
  ];
}

function expectAccounted(result: ThreePathSearchOutput, requested: readonly PathName[]): void {
  const present: Record<PathName, boolean> = {
    user_memory: result.userMemory !== undefined,
    agent_memory: result.agentMemory !== undefined,
    project: result.topics !== undefined
  };
  for (const path of PATHS) {
    const named = result.degraded.includes(path);
    if (requested.includes(path)) {
      expect(present[path], path).toBe(!named);
    } else {
      expect(present[path], path).toBe(false);
      expect(named, path).toBe(false);
      expect(result.degraded.some((item) => item.startsWith(`${path}:`)), path).toBe(false);
    }
  }
  if (!requested.includes("project")) expect(result.degraded).not.toContain("vector");
}

const allViews: MemoryViewSelection = { userMemory: true, agentLayers: ["L1", "Skill"], project: true };

describe("project memory three-path recall", () => {
  it("returns each requested path and caps non-project candidates at twice the memory limit", async () => {
    const recalled = portFrom(ready);
    const project = storeFrom(async () => projectRecall());
    const views: MemoryViewSelection = { userMemory: true, agentLayers: ["L1"], project: true };
    const result = await recallSearchPaths(input(views, 4), {
      store: project.store,
      local,
      nonProjectRecall: recalled.port
    });

    expect(result.userMemory?.map((item) => item.id)).toEqual(["user-1"]);
    expect(result.agentMemory?.map((item) => item.id)).toEqual(["l1-1"]);
    expect(result.topics?.map((topic) => topic.topic_name)).toEqual(["队列重试"]);
    expect(result.degraded).toEqual([]);
    expect(recalled.calls.map((call) => call.limit)).toEqual([8, 8]);
    expect(project.requests[0]?.topicK).toBe(Math.max(PROJECT_MEMORY_LIMITS.topicK, 8));
    expectAccounted(result, requestedPaths(views));
  });

  it("does not call personal recall or mark it degraded when only project is requested", async () => {
    const recalled = portFrom(ready);
    const project = storeFrom(async () => projectRecall());
    const views: MemoryViewSelection = { userMemory: false, agentLayers: [], project: true };
    const result = await recallSearchPaths(input(views), {
      store: project.store,
      local,
      nonProjectRecall: recalled.port
    });
    expect(recalled.calls).toEqual([]);
    expect(result.topics).toHaveLength(1);
    expect(result.userMemory).toBeUndefined();
    expect(result.agentMemory).toBeUndefined();
    expectAccounted(result, ["project"]);
  });

  it("treats an empty lane as success", async () => {
    const recalled = portFrom(async () => ({ candidates: [], vectorDegraded: false }));
    const project = storeFrom(async () => ({ results: [{ qid: "q", topics: [] }], topicSeq: {}, degraded: [] }));
    const result = await recallSearchPaths(input(allViews), {
      store: project.store,
      local,
      nonProjectRecall: recalled.port
    });
    expect(result.userMemory).toEqual([]);
    expect(result.agentMemory).toEqual([]);
    expect(result.topics).toEqual([]);
    expect(result.degraded).toEqual([]);
    expectAccounted(result, PATHS);
  });

  it("keeps the project vector fallback name", async () => {
    const recalled = portFrom(ready);
    const project = storeFrom(async () => projectRecall(["vector"]));
    const result = await recallSearchPaths(input(allViews), {
      store: project.store,
      local,
      nonProjectRecall: recalled.port
    });
    expect(result.topics).toHaveLength(1);
    expect(result.degraded).toEqual(["vector"]);
    expectAccounted(result, PATHS);
  });

  it.each([
    ["user_memory", { includeUserMemory: true }],
    ["agent_memory", { layers: ["L1", "Skill"] }]
  ] as const)("marks %s lexical-only without dropping the lane", async (name, match) => {
    const recalled = portFrom(async (request) => {
      const selected = "includeUserMemory" in match ? Boolean(request.includeUserMemory) : (request.layers?.length ?? 0) > 0;
      const body = ready(request);
      return selected ? { ...body, vectorDegraded: true } : body;
    });
    const result = await recallSearchPaths(input(allViews), {
      store: storeFrom(async () => projectRecall()).store,
      local,
      nonProjectRecall: recalled.port
    });
    expect(result.degraded).toEqual([`${name}:vector`]);
    expect(result.userMemory).toBeDefined();
    expect(result.agentMemory).toBeDefined();
    expect(result.topics).toHaveLength(1);
    expectAccounted(result, PATHS);
  });

  it.each(["user_memory", "agent_memory", "project"] as const)("degrades only %s when that path throws", async (path) => {
    const recalled = portFrom(async (request) => {
      if (path === "user_memory" && request.includeUserMemory) throw new Error("user lane down");
      if (path === "agent_memory" && !request.includeUserMemory) throw new Error("agent lane down");
      return ready(request);
    });
    const project = storeFrom(async () => {
      if (path === "project") throw new Error("project lane down");
      return projectRecall();
    });
    const result = await recallSearchPaths(input(allViews), {
      store: project.store,
      local,
      nonProjectRecall: recalled.port
    });
    expect(result.degraded).toEqual([path]);
    expect(JSON.stringify(result)).not.toMatch(/no memory|没有记忆/i);
    expectAccounted(result, PATHS);
  });

  it("degrades every requested path when all three fail", async () => {
    const result = await recallSearchPaths(input(allViews), {
      store: storeFrom(async () => {
        throw new Error("project lane down");
      }).store,
      local,
      nonProjectRecall: {
        async recallCandidates() {
          throw new Error("personal lane down");
        }
      }
    });
    expect(result.userMemory).toBeUndefined();
    expect(result.agentMemory).toBeUndefined();
    expect(result.topics).toBeUndefined();
    expect(result.degraded).toEqual(["user_memory", "agent_memory", "project"]);
    expectAccounted(result, PATHS);
  });

  it("degrades paths ① and ② when the recall port is missing and still returns project", async () => {
    const views: MemoryViewSelection = { userMemory: true, agentLayers: ["Skill"], project: true };
    const result = await recallSearchPaths(input(views), {
      store: storeFrom(async () => projectRecall()).store,
      local,
      nonProjectRecall: null
    });
    expect(result.topics).toHaveLength(1);
    expect(result.degraded).toEqual(["user_memory", "agent_memory"]);
    expectAccounted(result, requestedPaths(views));
  });

  it("leaves an unrequested path out of the result and degraded", async () => {
    const views: MemoryViewSelection = { userMemory: true, agentLayers: [], project: false };
    const result = await recallSearchPaths(input(views), {
      store: storeFrom(async () => projectRecall()).store,
      local,
      nonProjectRecall: portFrom(ready).port
    });
    expect(result.userMemory?.map((item) => item.id)).toEqual(["user-1"]);
    expectAccounted(result, ["user_memory"]);
  });

  it.each(["user_memory", "agent_memory", "project"] as const)("times out %s without failing the other paths", async (path) => {
    vi.useFakeTimers();
    try {
      const recalled = portFrom((request) => {
        const hangUser = path === "user_memory" && request.includeUserMemory;
        const hangAgent = path === "agent_memory" && !request.includeUserMemory;
        if (hangUser || hangAgent) return new Promise(() => undefined);
        return ready(request);
      });
      const project = storeFrom(() => path === "project" ? new Promise(() => undefined) : Promise.resolve(projectRecall()));
      const pending = recallSearchPaths(input(allViews), {
        store: project.store,
        local,
        nonProjectRecall: recalled.port
      });
      await vi.advanceTimersByTimeAsync(PROJECT_MEMORY_LIMITS.recallPathTimeoutMs);
      const result = await pending;
      expect(result.degraded).toEqual([path]);
      expectAccounted(result, PATHS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a user memory, an L1, and a project topic, then degrades personal search only", async () => {
    stubStages(combinedStages((payload) => ({
      ...emptyReply(),
      drafts: [{
        kind: "decision",
        content: payload.messages[0]!.content,
        message_idx: 0,
        user_ids: [payload.messages[0]!.user_id],
        topic: { new_topic: "n1" }
      }],
      new_topics: [{ ref: "n1", topic_name: "队列重试", topic_summary: "retrybackoff", topic_description: "" }]
    })));
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    const accepted = await call(service, "add/message", {
      user_id: "user_a",
      agent_id: "codex",
      conversation_id: "conv_retry",
      space_ids: ["space_a"],
      allow_memory_view: ["project"],
      messages: [{ role: "user", role_id: "user_a", chat_time: "2026-10-21 10:00:00", content: "retrybackoff after the push worker fails" }]
    });
    expect(accepted.code).toBe(0);
    await drain(service);

    const repos = new Repositories(db.db);
    repos.userMemories.insert({
      id: "user-retry",
      sourceTurnId: "turn-user-retry",
      userId: "user_a",
      memoryTypes: ["User Fact"],
      content: "retrybackoff is how this user handles a push failure",
      normalizedUserTextHash: "user-retry",
      sourceTurnRefs: ["turn-user-retry"],
      status: "active",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z"
    });
    repos.memories.insert(traceMemory("l1-retry", "retrybackoff while checking the push worker", "2026-10-19T00:00:00.000Z", 0.4));

    const searched = await call(service, "search/memory", {
      user_id: "user_a",
      query: "retrybackoff",
      space_ids: ["space_a"],
      include_memory_view: ["user_memory", "detail_factual", "project"],
      conversation_id: "conv_retry"
    });
    expect(searched.code).toBe(0);
    expect(searched.data.user_memory.map((item: { id: string }) => item.id)).toContain("user-retry");
    expect(searched.data.agent_memory.map((item: { id: string }) => item.id)).toContain("l1-retry");
    expect(searched.data.topic_detail_list.map((topic: { topic_name: string }) => topic.topic_name)).toContain("队列重试");
    expect(searched.data.memory_detail_list).toBeUndefined();
    expect(searched.data.degraded ?? []).not.toEqual(expect.arrayContaining(["user_memory", "agent_memory", "project"]));

    (service as unknown as { config: { algorithm: { enableMemorySearch: boolean } } }).config.algorithm.enableMemorySearch = false;
    const personalOff = await call(service, "search/memory", {
      user_id: "user_a",
      query: "retrybackoff",
      space_ids: ["space_a"],
      include_memory_view: ["user_memory", "detail_factual", "project"]
    });
    expect(personalOff.code).toBe(0);
    expect(personalOff.message).toBe("ok");
    expect(personalOff.data.user_memory).toBeUndefined();
    expect(personalOff.data.agent_memory).toBeUndefined();
    expect(personalOff.data.degraded).toEqual(expect.arrayContaining(["user_memory", "agent_memory"]));
    expect(personalOff.data.degraded).not.toContain("project");
    expect(personalOff.data.topic_detail_list.map((topic: { topic_name: string }) => topic.topic_name)).toContain("队列重试");

    const store = (service as unknown as { projectMemory: { store: { recall: (...args: unknown[]) => Promise<unknown> } } }).projectMemory.store;
    store.recall = async () => {
      throw new Error("recall failed");
    };
    const allFailed = await call(service, "search/memory", {
      user_id: "user_a",
      query: "retrybackoff",
      space_ids: ["space_a"],
      include_memory_view: ["user_memory", "detail_factual", "project"]
    });
    expect(allFailed.code).toBe(0);
    expect(allFailed.message).toBe("ok");
    expect(allFailed.data.topic_detail_list).toEqual([]);
    expect(allFailed.data.user_memory).toBeUndefined();
    expect(allFailed.data.agent_memory).toBeUndefined();
    expect(allFailed.data.degraded).toEqual(["user_memory", "agent_memory", "project"]);
    expect(JSON.stringify(allFailed)).not.toMatch(/no memory|没有记忆/i);
  });
});

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

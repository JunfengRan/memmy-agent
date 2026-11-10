import { afterEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import type { MemoryRow } from "../../../src/types.js";
import { PROJECT_MEMORY_LIMITS } from "../../../src/service/project-memory/contract/limits.js";
import type { RecallLogInput, RecallRequest, RecallResult, TopicSnapshot } from "../../../src/service/project-memory/contract/types.js";
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
    for (const list of [searched.data.user_memory, searched.data.agent_memory, searched.data.topic_detail_list]) {
      const relativities = list.map((item: { relativity: number }) => item.relativity);
      expect(relativities).toEqual([...relativities].sort((left: number, right: number) => right - left));
      for (const item of list) expect(item).not.toHaveProperty("score");
    }
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

  it("keeps the order of the paths that succeeded when one path fails", async () => {
    const text = "retrybackoff shared";
    const at = "2026-10-01T00:00:00.000Z";
    const users = [
      { id: "user-low", layer: "UserMemory" as const, content: text, score: 0.1, updatedAt: at },
      { id: "user-high", layer: "UserMemory" as const, content: text, score: 0.9, updatedAt: at }
    ];
    const agents = [
      { id: "l1-low", layer: "L1" as const, content: text, score: 0.2, updatedAt: at },
      { id: "skill-high", layer: "Skill" as const, content: text, score: 0.8, updatedAt: at }
    ];
    const port = (failUser: boolean): NonProjectRecallPort => ({
      async recallCandidates(request) {
        if (request.includeUserMemory) {
          if (failUser) throw new Error("user lane down");
          return { vectorDegraded: false, candidates: users };
        }
        return { vectorDegraded: false, candidates: agents };
      }
    });
    const { store } = projectPair();
    const views: MemoryViewSelection = { userMemory: true, agentLayers: ["L1", "Skill"], project: true };
    const all = await recallSearchPaths(input(views), { store, local, nonProjectRecall: port(false) });
    const failed = await recallSearchPaths(input(views), { store, local, nonProjectRecall: port(true) });
    const absent = await recallSearchPaths(input({ ...views, userMemory: false }), { store, local, nonProjectRecall: port(false) });

    expect(all.userMemory?.map((item) => item.id)).toEqual(["user-low", "user-high"]);
    expect(all.userMemory?.[0]).not.toHaveProperty("score");
    expect(all.userMemory?.[0]?.relativity).toBe(1);
    expect(all.agentMemory?.map((item) => item.id)).toEqual(["l1-low", "skill-high"]);
    expect(all.topics?.map((topic) => topic.id)).toEqual(["topic_high", "topic_low"]);
    expect(failed.degraded).toEqual(["user_memory"]);
    expect(failed.userMemory).toBeUndefined();
    expect(failed.agentMemory?.map((item) => item.id)).toEqual(all.agentMemory?.map((item) => item.id));
    expect(failed.topics?.map((topic) => topic.id)).toEqual(all.topics?.map((topic) => topic.id));
    expect(failed.agentMemory?.map((item) => item.relativity)).toEqual(absent.agentMemory?.map((item) => item.relativity));
    expect(failed.topics?.map((topic) => [topic.id, topic.relativity])).toEqual(absent.topics?.map((topic) => [topic.id, topic.relativity]));
    for (const item of [...(failed.agentMemory ?? []), ...(failed.topics ?? [])]) expect(item).not.toHaveProperty("score");
  });

  it("logs only topics that are returned, and defaults via to turn_start", async () => {
    const logged: RecallLogInput[] = [];
    const recording = {
      appendRecallLog(entries: RecallLogInput[]) {
        logged.push(...entries);
      }
    } as unknown as ProjectLocalState;
    const views: MemoryViewSelection = { userMemory: false, agentLayers: [], project: true };
    const request = { ...input(views), conversationId: "conv_log", relativity: 0.99 };
    await recallSearchPaths(request, { store: projectPair().store, local: recording, nonProjectRecall: null });
    expect(logged.map((row) => [row.topicId, row.decisionId, row.via])).toEqual([
      ["topic_high", null, "turn_start"],
      ["topic_high", "dec_high", "turn_start"]
    ]);

    logged.length = 0;
    await recallSearchPaths({ ...request, via: "tool" }, { store: projectPair().store, local: recording, nonProjectRecall: null });
    expect(logged.map((row) => row.via)).toEqual(["tool", "tool"]);
    expect(logged.map((row) => row.topicId)).toEqual(["topic_high", "topic_high"]);
  });

  it("drops a project topic with no snapshot before fusion", async () => {
    const logged: RecallLogInput[] = [];
    const recording = {
      appendRecallLog(entries: RecallLogInput[]) {
        logged.push(...entries);
      }
    } as unknown as ProjectLocalState;
    const views: MemoryViewSelection = { userMemory: false, agentLayers: [], project: true };
    const result = await recallSearchPaths({ ...input(views), conversationId: "conv_gap" }, {
      store: projectPair({ missingHigh: true }).store,
      local: recording,
      nonProjectRecall: null
    });
    expect(result.topics?.map((topic) => topic.id)).toEqual(["topic_low"]);
    expect(result.topics?.[0]?.relativity).toBe(1);
    expect(logged.map((row) => row.topicId)).toEqual(["topic_low", "topic_low"]);
    expect(logged.some((row) => row.topicId === "topic_high")).toBe(false);
  });
});

function projectPair(options: { missingHigh?: boolean } = {}): { store: ProjectMemoryStore } {
  const text = "retrybackoff shared";
  const at = "2026-10-21T10:00:00+08:00";
  const snapshots = ["topic_high", "topic_low"].map((id): TopicSnapshot => ({
    topicId: id,
    spaceId: "space_a",
    domain: "代码开发",
    topicName: text,
    topicSummary: text,
    topicDescription: text,
    revision: 1,
    createTime: at,
    updateTime: at,
    decisions: [{ id: id === "topic_high" ? "dec_high" : "dec_low", content: text, time: at, userIds: ["user_a"], history: [], conflicts: [] }],
    experiences: [],
    timeline: [],
    sources: []
  }));
  const recallTopic = (snapshot: TopicSnapshot, lexical: number) => ({
    topicId: snapshot.topicId,
    spaceId: snapshot.spaceId,
    revision: snapshot.revision,
    domain: snapshot.domain,
    topicName: snapshot.topicName,
    topicSummary: snapshot.topicSummary,
    topicDescription: snapshot.topicDescription,
    updateTime: snapshot.updateTime,
    hasConversation: false,
    scores: { lexical, vector: null },
    entries: [{ kind: "decision" as const, id: snapshot.decisions[0]!.id, scores: { lexical: 1, vector: null } }]
  });
  return {
    store: {
      async recall() {
        return {
          results: [{ qid: "q", topics: [recallTopic(snapshots[0]!, 5), recallTopic(snapshots[1]!, 1)] }],
          topicSeq: {},
          degraded: []
        };
      },
      async getTopicsFull() {
        return options.missingHigh ? snapshots.filter((item) => item.topicId !== "topic_high") : snapshots;
      }
    } as unknown as ProjectMemoryStore
  };
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

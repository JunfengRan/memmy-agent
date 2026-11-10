import { createMemoryLogger, memoryErrorFields } from "../../../logging/logger.js";
import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { ProjectLocalState } from "../store/sqlite/local-state.js";
import type { ProjectMemoryStore } from "../store/store.js";
import type { DecisionTopicRouter } from "../decisions/client.js";
import { searchProjectMemory, type SearchInput, type SearchTopicView } from "./search.js";

/**
 * M08: three recall paths, no fusion. Path ③ still runs today's project search
 * so a project-only request keeps its topic list and recall_log. Cross-path RRF,
 * relativity changes, and memory_detail_list stay in PM-20.
 */
const log = createMemoryLogger("project-memory.recall");
const SKIP = Symbol("recall-path-skipped");

export interface RecallCandidateView {
  id: string;
  layer: "UserMemory" | "L1" | "Skill";
  content: string;
  score: number;
  updated_at: string;
}

export interface NonProjectRecallInput {
  userId: string;
  query: string;
  limit: number;
  includeUserMemory?: boolean;
  layers?: Array<"L1" | "Skill">;
  contextBudget?: number;
}

export interface NonProjectRecallCandidate {
  id: string;
  layer: "UserMemory" | "L1" | "Skill";
  content: string;
  score: number;
  updatedAt: string;
}

export interface NonProjectRecallResult {
  candidates: NonProjectRecallCandidate[];
  vectorDegraded: boolean;
}

export interface NonProjectRecallPort {
  recallCandidates(input: NonProjectRecallInput): Promise<NonProjectRecallResult>;
}

export interface ThreePathSearchOutput {
  /** Present only when path ① was requested and returned. An empty array is success. */
  userMemory?: RecallCandidateView[];
  /** Present only when path ② was requested and returned. */
  agentMemory?: RecallCandidateView[];
  /** Present only when path ③ was requested and returned. HTTP maps a failure to []. */
  topics?: SearchTopicView[];
  degraded: string[];
}

export interface RecallPathDeps {
  store: ProjectMemoryStore;
  local: ProjectLocalState;
  decision?: DecisionTopicRouter | null;
  nonProjectRecall: NonProjectRecallPort | null;
  timeoutMs?: number;
}

export async function recallSearchPaths(input: SearchInput, deps: RecallPathDeps): Promise<ThreePathSearchOutput> {
  const timeoutMs = deps.timeoutMs ?? PROJECT_MEMORY_LIMITS.recallPathTimeoutMs;
  const candidateLimit = input.memoryLimit * 2;
  const wantAgent = input.views.agentLayers.length > 0;

  const userTask = beginPath(input.views.userMemory, () => recallLane(deps, {
    userId: input.userId,
    query: input.query,
    limit: candidateLimit,
    includeUserMemory: true,
    layers: []
  }, "UserMemory"), timeoutMs);
  const agentTask = beginPath(wantAgent, () => recallLane(deps, {
    userId: input.userId,
    query: input.query,
    limit: candidateLimit,
    includeUserMemory: false,
    layers: input.views.agentLayers
  }, ...input.views.agentLayers), timeoutMs);
  const projectTask = beginPath(input.views.project, () => searchProjectMemory(input, deps), timeoutMs);
  const [userSettled, agentSettled, projectSettled] = await settleAll([userTask, agentTask, projectTask] as const);

  const degraded: string[] = [];
  let userMemory: RecallCandidateView[] | undefined;
  let agentMemory: RecallCandidateView[] | undefined;
  let topics: SearchTopicView[] | undefined;

  const user = readPath(input.views.userMemory, userSettled, "user_memory");
  if (user.state === "failed") degraded.push("user_memory");
  if (user.state === "ok") {
    userMemory = user.value.candidates;
    if (user.value.vectorDegraded) degraded.push("user_memory:vector");
  }

  const agent = readPath(wantAgent, agentSettled, "agent_memory");
  if (agent.state === "failed") degraded.push("agent_memory");
  if (agent.state === "ok") {
    agentMemory = agent.value.candidates;
    if (agent.value.vectorDegraded) degraded.push("agent_memory:vector");
  }

  const project = readPath(input.views.project, projectSettled, "project");
  if (project.state === "failed") degraded.push("project");
  if (project.state === "ok") {
    topics = project.value.topics;
    for (const name of project.value.degraded) {
      if (!degraded.includes(name)) degraded.push(name);
    }
  }

  return {
    ...(userMemory !== undefined ? { userMemory } : {}),
    ...(agentMemory !== undefined ? { agentMemory } : {}),
    ...(topics !== undefined ? { topics } : {}),
    degraded
  };
}

function settleAll<T extends readonly Promise<unknown>[]>(
  tasks: T
): Promise<{ -readonly [K in keyof T]: PromiseSettledResult<Awaited<T[K]>> }> {
  return Promise.allSettled(tasks) as Promise<{ -readonly [K in keyof T]: PromiseSettledResult<Awaited<T[K]>> }>;
}

function beginPath<T>(enabled: boolean, run: () => Promise<T>, timeoutMs: number): Promise<T | typeof SKIP> {
  if (!enabled) return Promise.resolve(SKIP);
  try {
    return withPathTimeout(run(), timeoutMs);
  } catch (error) {
    return Promise.reject(error);
  }
}

function withPathTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`recall path timed out after ${timeoutMs}ms`)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function recallLane(
  deps: RecallPathDeps,
  request: NonProjectRecallInput,
  ...layers: Array<NonProjectRecallCandidate["layer"]>
): Promise<{ candidates: RecallCandidateView[]; vectorDegraded: boolean }> {
  if (!deps.nonProjectRecall) throw new Error("non-project recall is unavailable");
  const result = await deps.nonProjectRecall.recallCandidates(request);
  const allowed = new Set(layers);
  return {
    vectorDegraded: result.vectorDegraded,
    candidates: result.candidates
      .filter((candidate) => allowed.has(candidate.layer))
      .slice(0, request.limit)
      .map((candidate) => ({
        id: candidate.id,
        layer: candidate.layer,
        content: candidate.content,
        score: candidate.score,
        updated_at: candidate.updatedAt
      }))
  };
}

function readPath<T>(
  enabled: boolean,
  settled: PromiseSettledResult<T | typeof SKIP>,
  path: string
): { state: "absent" } | { state: "failed" } | { state: "ok"; value: T } {
  if (!enabled) return { state: "absent" };
  if (settled.status === "rejected" || settled.value === SKIP) {
    log.warn("recall.path_failed", { path, ...memoryErrorFields(settled.status === "rejected" ? settled.reason : new Error("recall path skipped")) });
    return { state: "failed" };
  }
  return { state: "ok", value: settled.value };
}

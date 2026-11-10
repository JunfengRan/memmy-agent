import { createHash } from "node:crypto";
import { join } from "node:path";
import { vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb, MemoryService } from "../../../src/index.js";
import { errorEnvelope, type OpenMemEnvelope } from "../../../src/service/project-memory/api.js";
import { ProjectMemoryError } from "../../../src/service/project-memory/contract/errors.js";
import { ASSIGN_PROMPT_VERSION } from "../../../src/service/project-memory/prompts/assign.js";
import { EXTRACT_PROMPT_VERSION } from "../../../src/service/project-memory/prompts/extract.js";
import { JUDGE_PROMPT_VERSION } from "../../../src/service/project-memory/prompts/merge-judge.js";
import { byokRuntimeConfig, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

export type DeferredTurnView = {
  didx: number;
  role: string;
  user_id: string | null;
  name: string | null;
  time: string;
  content: string;
};

export type DeferredSegmentView = {
  ref: string;
  text: string;
  reason: string;
  didx: number[];
};

export type OrganizePayload = {
  messages: Array<{ idx: number; role: string; user_id: string | null; name: string | null; time: string; content: string }>;
  context_turns: Array<{ role: string; user_id: string | null; content: string }>;
  deferred_turns: DeferredTurnView[];
  deferred_segments: DeferredSegmentView[];
  candidate_topics: Array<{
    topic_id: string;
    domain: string;
    topic_summary?: string;
    topic_name?: string;
    decisions: Array<{ id: string; content: string; user_ids: string[]; conflicts: Array<{ ref: string; content: string; user_ids: string[] }> }>;
    experiences: Array<{ id: string; content: string }>;
  }>;
  conflicts_shown: string[];
  request_domains: string[];
};

export type OrganizeReply = (payload: OrganizePayload, batchNumber: number) => Record<string, unknown>;

export type StageReply = (payload: Record<string, unknown>, call: number) => Record<string, unknown>;

export interface StageStub {
  extract: Array<Record<string, unknown>>;
  assign: Array<Record<string, unknown>>;
  judge: Array<Record<string, unknown>>;
  embeddingCalls: number;
}

/** Deterministic bag-of-hashes vector so similar text lands close together. */
function fakeVector(input: unknown): number[] {
  const vector = new Array<number>(16).fill(0);
  const text = typeof input === "string" ? input : JSON.stringify(input);
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]{1,2}/gu) ?? []) {
    const bucket = createHash("md5").update(token).digest()[0]! % 16;
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  return vector;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function acceptedDrafts(combined: Record<string, unknown>): Array<{ index: number; draft: Record<string, unknown> }> {
  const drafts = Array.isArray(combined.drafts) ? combined.drafts : [];
  const kept: Array<{ index: number; draft: Record<string, unknown> }> = [];
  drafts.forEach((item, index) => {
    const draft = asRecord(item);
    if (!draft) return;
    if (draft.kind !== "decision" && draft.kind !== "experience" && draft.kind !== "timeline") return;
    if (typeof draft.content !== "string" || !draft.content.trim()) return;
    const hasMessage = Number.isInteger(draft.message_idx);
    const hasDeferred = typeof draft.deferred_ref === "string" && draft.deferred_ref.length > 0 && Number.isInteger(draft.deferred_idx);
    if (!hasMessage && !hasDeferred) return;
    kept.push({ index, draft });
  });
  return kept;
}

function mapExtract(combined: Record<string, unknown>): Record<string, unknown> {
  return {
    drafts: acceptedDrafts(combined).map(({ index, draft }) => ({
      draft_id: `d${index}`,
      kind: draft.kind,
      category: draft.category ?? null,
      content: draft.content,
      ...(Number.isInteger(draft.message_idx) ? { message_idx: draft.message_idx } : {}),
      ...(typeof draft.deferred_ref === "string" ? { deferred_ref: draft.deferred_ref, deferred_idx: draft.deferred_idx } : {}),
      reason: draft.reason ?? null,
      user_ids: draft.user_ids ?? [],
      signals: []
    })),
    state_hints: Array.isArray(combined.state_hints) ? combined.state_hints : [],
    dropped: Array.isArray(combined.dropped) ? combined.dropped : [],
    deferred: Array.isArray(combined.deferred) ? combined.deferred : []
  };
}

function mapAssign(combined: Record<string, unknown>): Record<string, unknown> {
  return {
    assignments: acceptedDrafts(combined).map(({ index, draft }) => {
      const topic = asRecord(draft.topic);
      const topicId = typeof topic?.topic_id === "string" ? topic.topic_id : "";
      const newTopic = typeof topic?.new_topic === "string" ? topic.new_topic : "";
      const target = topicId ? { topic_id: topicId } : newTopic ? { new_topic: newTopic } : { defer: true };
      return {
        draft_id: `d${index}`,
        target,
        basis: {
          independent_delivery: !topicId && newTopic.length > 0,
          affects_existing_decisions: topicId.length > 0
        }
      };
    }),
    new_topics: Array.isArray(combined.new_topics) ? combined.new_topics : [],
    // The combined reply's deferred list is M02 output. M04 adds its own when a draft cannot be placed.
    deferred: []
  };
}

function mapJudge(combined: Record<string, unknown>): Record<string, unknown> {
  return {
    drafts: acceptedDrafts(combined).map(({ index, draft }) => ({
      draft_id: `d${index}`,
      same_question_as: draft.same_question_as ?? null,
      same_as: draft.same_as ?? null,
      approved_by: draft.approved_by ?? [],
      resolve: draft.resolve ?? null,
      split: draft.split ?? null,
      same_experience_as: draft.same_experience_as ?? null,
      experience_change: draft.experience_change ?? null
    })),
    informed_decision_ids: Array.isArray(combined.informed_decision_ids) ? combined.informed_decision_ids : [],
    topic_updates: Array.isArray(combined.topic_updates) ? combined.topic_updates : []
  };
}

/**
 * Routes one combined reply across the three stage calls. batchNumber increments
 * once per extract, so assign and judge of the same batch see the same number.
 * Extract is shown no candidates; assign is shown candidates without entries;
 * judge is shown the full decisions.
 */
export function combinedStages(reply: OrganizeReply): { extract: StageReply; assign: StageReply; judge: StageReply } {
  let batchNumber = 0;
  let messages: OrganizePayload["messages"] = [];
  let contextTurns: OrganizePayload["context_turns"] = [];
  let deferredTurns: OrganizePayload["deferred_turns"] = [];
  let deferredSegments: OrganizePayload["deferred_segments"] = [];
  let requestDomains: string[] = [];

  const view = (candidateTopics: OrganizePayload["candidate_topics"], conflictsShown: string[] = []): OrganizePayload => ({
    messages,
    context_turns: contextTurns,
    deferred_turns: deferredTurns,
    deferred_segments: deferredSegments,
    candidate_topics: candidateTopics,
    conflicts_shown: conflictsShown,
    request_domains: requestDomains
  });

  return {
    extract(payload) {
      batchNumber += 1;
      messages = Array.isArray(payload.messages) ? payload.messages as OrganizePayload["messages"] : [];
      contextTurns = Array.isArray(payload.context_turns) ? payload.context_turns as OrganizePayload["context_turns"] : [];
      deferredTurns = Array.isArray(payload.deferred_turns) ? payload.deferred_turns as OrganizePayload["deferred_turns"] : [];
      deferredSegments = Array.isArray(payload.deferred_segments) ? payload.deferred_segments as OrganizePayload["deferred_segments"] : [];
      requestDomains = Array.isArray(payload.request_domains) ? payload.request_domains as string[] : [];
      return mapExtract(reply(view([]), batchNumber));
    },
    assign(payload) {
      const candidates = Array.isArray(payload.candidates) ? payload.candidates as Array<Record<string, unknown>> : [];
      const topics = candidates.map((topic) => ({
        topic_id: String(topic.topic_id ?? ""),
        domain: String(topic.domain ?? ""),
        topic_summary: typeof topic.topic_summary === "string" ? topic.topic_summary : "",
        decisions: [],
        experiences: []
      }));
      return mapAssign(reply(view(topics), batchNumber));
    },
    judge(payload) {
      const topics = Array.isArray(payload.topics) ? payload.topics as Array<Record<string, unknown>> : [];
      const conflictsShown = Array.isArray(payload.conflicts_shown) ? payload.conflicts_shown as string[] : [];
      const candidateTopics = topics.map((topic) => ({
        topic_id: String(topic.topic_id ?? ""),
        domain: String(topic.domain ?? ""),
        decisions: Array.isArray(topic.decisions) ? topic.decisions as OrganizePayload["candidate_topics"][number]["decisions"] : [],
        experiences: Array.isArray(topic.experiences) ? topic.experiences as OrganizePayload["candidate_topics"][number]["experiences"] : []
      }));
      return mapJudge(reply(view(candidateTopics, conflictsShown), batchNumber));
    }
  };
}

/** Stubs chat completions by the version string in the system prompt, and embeddings. */
export function stubStages(
  handlers: { extract: StageReply; assign: StageReply; judge: StageReply },
  options: { embeddings?: "ok" | "fail" } = {}
): StageStub {
  const stub: StageStub = { extract: [], assign: [], judge: [], embeddingCalls: 0 };
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/app/byok-token-usage/events")) return json({ ok: true });
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.endsWith("/embeddings")) {
      stub.embeddingCalls += 1;
      if (options.embeddings === "fail") return json({ error: { message: "embedding unavailable" } }, 401);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return json({ data: inputs.map((item, index) => ({ index, embedding: fakeVector(item) })), usage: { prompt_tokens: 1, total_tokens: 1 } });
    }
    const messages = body.messages as Array<{ role: string; content: string }>;
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    const user = messages.find((message) => message.role === "user");
    const payload = JSON.parse(user?.content ?? "{}") as Record<string, unknown>;
    const stage = system.includes(EXTRACT_PROMPT_VERSION) ? "extract"
      : system.includes(ASSIGN_PROMPT_VERSION) ? "assign"
        : system.includes(JUDGE_PROMPT_VERSION) ? "judge"
          : null;
    if (!stage) throw new Error(`unexpected model call: ${system.slice(0, 120)}`);
    stub[stage].push(payload);
    const output = handlers[stage](payload, stub[stage].length);
    return json({
      choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    });
  });
  return stub;
}

export function createProjectMemoryHarness() {
  const fixture = createMemoryServiceFixture();
  const services: MemoryService[] = [];
  const databases: MemoryDb[] = [];

  function createService(): { service: MemoryService; db: MemoryDb } {
    const db = new MemoryDb({ path: join(fixture.createTestRoot("pm-"), "memory.sqlite") });
    databases.push(db);
    const service = new MemoryService({
      db,
      mode: "dev",
      config: byokRuntimeConfig({ algorithm: { ...DEFAULT_MEMMY_CONFIG.algorithm, enableQueryRewrite: false } }),
      fetchAppMemoryBudget: async () => null,
      tokenUsage: {
        fetchImpl: globalThis.fetch,
        runtimeConfig: { baseUrl: "http://127.0.0.1:18100", localToken: "runtime-token" },
        retryDelaysMs: [15]
      }
    });
    services.push(service);
    return { service, db };
  }

  async function cleanup(): Promise<void> {
    vi.unstubAllGlobals();
    for (const service of services.splice(0)) await service.stop();
    for (const database of databases.splice(0)) if (database.db.open) database.close();
    fixture.cleanup();
  }

  return { createService, cleanup };
}

/** Calls an `/api/openmem/v1/*` route through the service and returns the envelope, errors included. */
export async function call(service: MemoryService, route: string, body: Record<string, unknown>): Promise<OpenMemEnvelope & { data: any }> {
  try {
    const result = await service.handleProjectMemoryRequest({
      method: "POST",
      path: `/api/openmem/v1/${route}`,
      body,
      timezone: "Asia/Shanghai"
    });
    if (!result) throw new Error(`no route for ${route}`);
    return result.envelope as OpenMemEnvelope & { data: any };
  } catch (error) {
    if (error instanceof ProjectMemoryError) return errorEnvelope(error) as OpenMemEnvelope & { data: any };
    throw error;
  }
}

export async function drain(service: MemoryService): Promise<void> {
  await runWorkerRounds(service, 4);
}

/**
 * Creates a Space with a fixed id so fixtures can name it. The public `create/space`
 * always generates the id (open-questions Q-04), so this goes through the store.
 */
export async function setupSpace(service: MemoryService, spaceId: string, domains: string[] = ["代码开发"]): Promise<void> {
  const store = (service as unknown as { projectMemory: { store: { createSpace(input: unknown): Promise<unknown> } } }).projectMemory.store;
  await store.createSpace({ spaceId, spaceName: spaceId, domains: domains.map((domain) => ({ domain, description: "" })) });
}

export function emptyReply(): Record<string, unknown> {
  return { drafts: [], new_topics: [], topic_updates: [], informed_decision_ids: [], deferred: [] };
}

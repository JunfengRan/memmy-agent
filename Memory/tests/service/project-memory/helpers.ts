import { createHash } from "node:crypto";
import { join } from "node:path";
import { vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb, MemoryService } from "../../../src/index.js";
import { errorEnvelope, type OpenMemEnvelope } from "../../../src/service/project-memory/api.js";
import { ProjectMemoryError } from "../../../src/service/project-memory/contract/errors.js";
import { byokRuntimeConfig, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

export type OrganizePayload = {
  messages: Array<{ idx: number; role: string; user_id: string | null; name: string | null; time: string; content: string }>;
  context_turns: Array<{ role: string; user_id: string | null; content: string }>;
  candidate_topics: Array<{
    topic_id: string;
    domain: string;
    topic_summary: string;
    decisions: Array<{ id: string; content: string; user_ids: string[]; conflicts: Array<{ ref: string; content: string; user_ids: string[] }> }>;
    experiences: Array<{ id: string; content: string }>;
  }>;
  conflicts_shown: string[];
  request_domains: string[];
};

export type OrganizeReply = (payload: OrganizePayload, call: number) => Record<string, unknown>;

export interface ModelStub {
  organizeCalls: OrganizePayload[];
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

/** Stubs the chat and embedding endpoints the summary model and embedder call (see memory-service-fixture). */
export function stubModel(reply: OrganizeReply, options: { embeddings?: "ok" | "fail" } = {}): ModelStub {
  const stub: ModelStub = { organizeCalls: [], embeddingCalls: 0 };
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
    const payload = JSON.parse(messages.find((message) => message.role === "user")!.content) as OrganizePayload;
    stub.organizeCalls.push(payload);
    const output = reply(payload, stub.organizeCalls.length);
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

export async function setupSpace(service: MemoryService, spaceId: string, domains: string[] = ["代码开发"]): Promise<void> {
  const created = await call(service, "create/space", {
    space_id: spaceId,
    space_name: spaceId,
    domains: domains.map((domain) => ({ domain, description: "" }))
  });
  if (created.code !== 0) throw new Error(JSON.stringify(created));
}

export function emptyReply(): Record<string, unknown> {
  return { drafts: [], new_topics: [], topic_updates: [], informed_decision_ids: [], deferred: [] };
}

import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb, MemoryService } from "../../src/index.js";
import { byokRuntimeConfig, createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
const services: MemoryService[] = [];
const databases: MemoryDb[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const service of services.splice(0)) await service.stop();
  for (const database of databases.splice(0)) if (database.db.open) database.close();
  fixture.cleanup();
});

describe("project memory topics", () => {
  it("guides extraction with the topic skill and the project's existing topics", async () => {
    const prompts: Array<{ system: string; user: string }> = [];
    const replies = [
      { entries: [{ kind: "experience", topic_id: "search-index-build", text: "index build uses batch size 500", source_trace_ids: ["t1"] }] },
      { entries: [{ kind: "experience", topic_id: "billing-invoice", text: "invoices are sent monthly", source_trace_ids: ["t2"] }] },
      { entries: [{ kind: "experience", topic_id: "search-index-build", text: "index build retries twice on timeout", source_trace_ids: ["t3"] }] }
    ];
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes("/api/app/byok-token-usage/events")) return jsonResponse({ ok: true });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      prompts.push({
        system: body.messages.find((message) => message.role === "system")?.content ?? "",
        user: body.messages.find((message) => message.role === "user")?.content ?? ""
      });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(replies[prompts.length - 1]) } }] });
    });
    const service = createService();
    const add = (spaceIds: string, traceId: string, content: string) => service.addProjectMemory({
      userId: "eval-user",
      spaceIds,
      allowMemoryView: ["project"],
      messages: [{ role: "user", content, sourceTraceId: traceId, chatTime: "2026-10-21T08:40:00.000Z" }]
    });

    await add("proj_search", "t1", "index build batch size is 500");
    await add("proj_billing", "t2", "send invoices monthly");
    await add("proj_search", "t3", "retry the index build twice on timeout");

    expect(prompts).toHaveLength(3);
    expect(prompts[0]!.system).toContain("# Topic skill: choosing topic_id");
    expect(prompts[0]!.user).toContain("Existing topics in this project:\nnone yet");
    expect(prompts[2]!.user).toContain("- search-index-build (1 entries): index build uses batch size 500");
    expect(prompts[2]!.user).not.toContain("billing-invoice");
    expect(prompts[2]!.user).toContain("[trace:t3]");

    const searched = await service.searchProjectMemory({ userId: "eval-user", query: "monthly", spaceIds: "proj_search", includeMemoryView: ["project"] });
    expect(searched.topicDetailList).toEqual([]);
  });
});

function createService(): MemoryService {
  const db = new MemoryDb({ path: join(fixture.createTestRoot(), "memory.sqlite") });
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
  return service;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

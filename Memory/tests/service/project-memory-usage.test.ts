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

describe("project memory usage", () => {
  it("reports model token usage for project add and search", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes("/api/app/byok-token-usage/events")) return jsonResponse({ ok: true });
      calls += 1;
      const content = calls === 1
        ? JSON.stringify({ entries: [{ kind: "decision", topic_id: "ledger-amount", text: "entries 增加 amount 列", source_trace_ids: ["t_column"] }] })
        : "月报按 amount 列汇总。";
      return jsonResponse({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: calls === 1 ? 120 : 80, completion_tokens: calls === 1 ? 30 : 12, total_tokens: calls === 1 ? 150 : 92 }
      });
    });
    const service = createService();

    const added = await service.addProjectMemory({
      userId: "eval-user",
      spaceIds: "proj_ledger",
      allowMemoryView: ["project"],
      messages: [
        { role: "user", content: "entries 加 amount 列", sourceTraceId: "t_column", chatTime: "2026-10-21T08:40:00.000Z" },
        { role: "assistant", content: "entries 上加了 amount 列。", sourceTraceId: "t_column", chatTime: "2026-10-21T08:40:00.000Z" }
      ]
    });
    expect(added.entries).toHaveLength(1);
    expect(added.usage).toEqual({ model: "memory_summary", llmCalls: 1, inputTokens: 120, outputTokens: 30, cachedInputTokens: 0 });

    const searched = await service.searchProjectMemory({
      userId: "eval-user",
      query: "月报 amount 列",
      spaceIds: "proj_ledger",
      includeMemoryView: ["project"],
      generateAnswer: true
    });
    expect(searched.answer).toBe("月报按 amount 列汇总。");
    expect(searched.usage).toEqual({ model: "memory_summary", llmCalls: 1, inputTokens: 80, outputTokens: 12, cachedInputTokens: 0 });

    const withoutAnswer = await service.searchProjectMemory({
      userId: "eval-user",
      query: "月报 amount 列",
      spaceIds: "proj_ledger",
      includeMemoryView: ["project"]
    });
    expect(withoutAnswer.usage).toEqual({ llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
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

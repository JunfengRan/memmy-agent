import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHookContext, SystemPromptBuildContext } from "../../src/core/agent-runtime/hook.js";
import { INTERACTIVE_MEMORY_TIMEOUT_MS } from "../../src/memmy-memory/client.js";
import { MemmyMemoryHook } from "../../src/memmy-memory/hook.js";
import * as appRender from "../../src/memmy-memory/project-inject.js";

const topic = {
  id: "topic_retry", space_id: "space_a", topic_name: "推送重试", topic_summary: "失败后重试三次",
  decisions: [{ content: "推送重试三次", time: "2026-11-12T10:00:00+08:00", user_ids: ["a"] }]
};
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pm-hook-audit-"));
  vi.stubEnv("MEMMY_HOME", home);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
function context(turnId = "one", abortSignal?: AbortSignal) {
  return new AgentHookContext({ spec: { sessionKey: "pm-audit", turnId, abortSignal }, messages: [{ role: "user", content: "推送如何重试" }] });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const client = {
    openSession: vi.fn(async () => ({ sessionId: "conversation_a", userId: "a" })),
    startTurn: vi.fn(async () => ({})),
    post: vi.fn(async (_path: string, _body: unknown, _options?: unknown): Promise<any> => ({ data: { topic_detail_list: [topic] } }))
  };
  const hook = new MemmyMemoryHook(client as any, { userId: "a", projectSpaceIds: ["space_a"] });
  return { client, hook };
}

describe("bound project hook", () => {
  it("injects the session guide/index and a bound turn search", async () => {
    const { client, hook } = fixture();
    const ctx = context();
    await hook.beforeBuildSystemPrompt(ctx);
    const prompt = new SystemPromptBuildContext({ sessionKey: "pm-audit" });
    hook.onBuildSystemPrompt(prompt);
    expect(prompt.getSection("memmy-project-memory")?.content).toContain("<project_index>");
    expect(prompt.getSection("memmy-project-memory")?.content).toContain("推送重试");
    await hook.beforeRun(ctx);
    expect(client.post).toHaveBeenCalledWith("/api/openmem/v1/search/memory", expect.objectContaining({
      user_id: "a", space_ids: ["space_a"], conversation_id: "conversation_a", include_memory_view: ["project"]
    }), expect.anything());
    expect(JSON.stringify(ctx.messages?.[0].content)).toContain("memos_context");
  });

  it.each(["empty", "degraded", "failure"])("continues on %s project results", async (kind) => {
    const { client, hook } = fixture();
    client.post.mockImplementation(async () => {
      if (kind === "failure") throw new Error("offline");
      return { data: { topic_detail_list: [], ...(kind === "degraded" ? { degraded: ["project"] } : {}) } };
    });
    const ctx = context();
    await expect(hook.beforeRun(ctx)).resolves.toBeUndefined();
    const content = JSON.stringify(ctx.messages?.[0].content);
    expect(content.includes("<memos_context")).toBe(kind === "degraded");
    if (kind === "degraded") expect(content).toContain("召回降级");
  });

  it.each(["abort", "supersede"])("ignores a late response after %s even when transport ignores cancellation", async (kind) => {
    const { client, hook } = fixture();
    const late = deferred<any>();
    const started = deferred<void>();
    client.post.mockImplementationOnce(async () => { started.resolve(); return late.promise; });
    const controller = new AbortController();
    const old = context("old", controller.signal);
    const running = hook.beforeRun(old);
    await started.promise;
    if (kind === "abort") controller.abort();
    else await hook.beforeRun(context("new"));
    late.resolve({ data: { topic_detail_list: [topic] } });
    await running;
    expect(String(old.messages?.[0].content)).not.toContain("<memos_context");
  });

  it.each(["prompt", "turn"])("bounds hanging project %s calls with the shared deadline", async (stage) => {
    vi.useFakeTimers();
    const { client, hook } = fixture();
    client.post.mockImplementation(() => new Promise(() => {}));
    const ctx = context();
    let done = false;
    const run = (stage === "prompt" ? hook.beforeBuildSystemPrompt(ctx) : hook.beforeRun(ctx)).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(INTERACTIVE_MEMORY_TIMEOUT_MS + 1);
    expect(done).toBe(true);
    await run;
  });

  it("keeps both renderer implementations equivalent, including offset chronology", () => {
    const input = { kind: "turn" as const, topics: [{ ...topic, decisions: [{ ...topic.decisions[0], history: [
      { content: "earlier", time: "2026-11-12T08:10:00+09:00" },
      { content: "later", time: "2026-11-11T23:20:00Z" },
      { content: "latest", time: "2026-11-11T18:30:00-05:00" }
    ] }] }] };
    const appSource = readFileSync(new URL("../../src/memmy-memory/project-inject.ts", import.meta.url), "utf8");
    const memorySource = readFileSync(new URL("../../../../Memory/src/service/project-memory/inject/render.ts", import.meta.url), "utf8");
    const marker = "export type MemosContextKind";
    expect(appSource.slice(appSource.indexOf(marker), appSource.indexOf("/** Tool HTTP errors only.")).trim()).toBe(memorySource.slice(memorySource.indexOf(marker)).trim());
    const result = appRender.renderTurnMemories(input)!;

    expect(result).not.toContain("此前：earlier");
    expect(result.indexOf("此前：latest")).toBeLessThan(result.indexOf("此前：later"));
    const groups = [{ spaceName: "推送", topics: [{ ...topic, timeline: [
      { content: "earlier", time: "2026-11-12T08:10:00+09:00" },
      { content: "latest", time: "2026-11-11T23:20:00Z" }
    ] }] }];
    const index = appRender.renderProjectIndex({ groups });
    expect(index).toContain("最新进展（11/11）：latest");
  });
});

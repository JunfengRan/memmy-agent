import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopProjectMemoryService, parseDesktopMemorySession } from "../project-memory-service.js";
import type { MemoryClient } from "../../adapters/outbound/memory-client/types.js";
const a = "22222222-2222-4222-8222-222222222222";
const b = "33333333-3333-4333-8333-333333333333";
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pm-desktop-")); await mkdir(join(root, "sessions")); await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [a,b].map(id => ({ id, name: id, state: "active", root_path: `/${id}` })) })); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function file(projectId = a, key = "websocket:chat-one", at = "2026-11-13T10:00:00.000Z") {
  return [
    { recordType: "metadata", key, metadata: { webui: true, webuiProjectId: projectId, title: "设计推送策略" }, updatedAt: at },
    { role: "user", timestamp: at, content: "推送失败后重试五次" },
    { role: "assistant", timestamp: at, content: "已确认推送重试五次" }
  ].map(row => JSON.stringify(row)).join("\n");
}
function fixture() {
  const openMem = vi.fn(async (route: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (route === "create/space") return { space_id: `space_${String(body.space_name)}` };
    if (route === "add/message") return { task_id: "task_one", status: "running" };
    if (route === "get/status") return { status: "completed" };
    if (route.startsWith("get/memory/")) return { topic_detail_list: [{ id: "topic_foreign", space_id: `space_${b}` }] };
    return {};
  });
  const instructions = vi.fn(async () => "项目约定");
  const options = { memmyConfigPath: join(root, "config.yaml"), filePath: join(root, "bindings.json"), projectsFile: join(root, "projects.json"), sessionsDir: join(root, "sessions"), now: () => new Date("2026-11-13T09:00:00Z"), memoryClient: { openMem } as unknown as MemoryClient, getUserId: () => "local-user", readInstructions: instructions };
  return { openMem, options, instructions, service: createDesktopProjectMemoryService(options) };
}
describe("local desktop project memory", () => {
  it("automatically binds existing and new local projects without adding frontend controls", async () => {
    const { options, openMem } = fixture();
    const service = createDesktopProjectMemoryService({ ...options, autoEnableProjects: true });
    await service.tick();
    expect((await service.view(a)).binding!.enabled).toBe(true);
    await service.tick();
    expect(openMem.mock.calls.filter(([route]) => route === "create/space")).toHaveLength(2);
    await writeFile(join(root, "sessions/websocket_chat-one.jsonl"), file());
    await service.tick();
    expect((await service.view(a)).jobs[0]!.status).toBe("completed");
  });
  it("keeps the first turn submitted before the background project binding poll", async () => {
    const { options } = fixture();
    let clock = new Date("2026-11-13T09:00:00Z");
    const service = createDesktopProjectMemoryService({ ...options, autoEnableProjects: true, now: () => clock });
    await writeFile(join(root, "sessions/websocket_chat-one.jsonl"), file(a, "websocket:chat-one", "2026-11-13T09:00:01.000Z"));
    clock = new Date("2026-11-13T09:00:03Z");
    await service.tick();
    expect((await service.view(a)).jobs[0]?.status).toBe("completed");
  });
  it("serializes concurrent enables across service instances and preserves binding across disable/restart", async () => {
    const { openMem, options, service } = fixture();
    const peer = createDesktopProjectMemoryService(options);
    await Promise.all([service.configure(a, true), peer.configure(a, true)]);
    expect(openMem.mock.calls.filter(([route]) => route === "create/space")).toHaveLength(1);
    const initial = (await service.view(a)).binding!.spaceId;
    await service.configure(a, false);
    expect((await peer.view(a)).binding).toMatchObject({ enabled: false, spaceId: initial });
    await peer.configure(a, true);
    expect((await service.view(a)).binding!.spaceId).toBe(initial);
  });
  it("collects new saved turns, replays pending deliveries after restart and deduplicates manual history", async () => {
    const { service, options, openMem } = fixture();
    await service.configure(a, true);
    await writeFile(join(root, "sessions/websocket_chat-one.jsonl"), file());
    await service.tick();
    expect(openMem).toHaveBeenCalledWith("add/message", expect.objectContaining({ conversation_id: "websocket:chat-one", space_ids: [`space_${a}`], domains: ["通用"], messages: [expect.objectContaining({ chat_time: "2026-11-13T10:00:00.000Z" }), expect.anything()] }));
    const restarted = createDesktopProjectMemoryService(options);
    await restarted.importSessions(a, ["websocket:chat-one"]);
    await restarted.tick();
    expect(openMem.mock.calls.filter(([route]) => route === "add/message")).toHaveLength(1);
    expect((await restarted.view(a)).jobs[0]!.status).toBe("completed");
  });
  it("persists outbox before submitting, leaves failures visible and permits explicit retry", async () => {
    const { service, openMem, options } = fixture();
    await service.configure(a, true);
    await writeFile(join(root, "sessions/websocket_chat-one.jsonl"), file());
    openMem.mockImplementation(async route => {
      if (route === "add/message") { expect(JSON.parse(await readFile(options.filePath, "utf8")).jobs).not.toEqual({}); throw new Error("模型服务未配置"); }
      return { status: "completed" };
    });
    await service.tick();
    expect((await service.view(a)).jobs[0]).toMatchObject({ status: "failed", error: "模型服务未配置" });
    openMem.mockImplementation(async route => route === "add/message" ? { task_id: "task_retry" } : { status: "completed" });
    await service.retry(a); await service.tick();
    expect((await service.view(a)).jobs[0]!.status).toBe("completed");
  });
  it("keeps disable responsive during delivery and fences a second backend claim", async () => {
    const { service, openMem, options } = fixture();
    await service.configure(a, true);
    await writeFile(join(root, "sessions/websocket_chat-one.jsonl"), file());
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    openMem.mockImplementation(async route => {
      if (route === "add/message") { started(); await gate; return { task_id: "in_flight" }; }
      return { status: "completed" };
    });
    const running = service.tick();
    await entered;
    const peer = createDesktopProjectMemoryService(options);
    await peer.tick();
    try {
      const closed = await Promise.race([peer.configure(a, false), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("disable waited for network delivery")), 1000))]);
      expect(closed.binding!.enabled).toBe(false);
    } finally { release(); await running; }
    expect((await peer.view(a)).binding!.enabled).toBe(false);
    expect(openMem.mock.calls.filter(([route]) => route === "add/message")).toHaveLength(1);
  });

  it("requires explicit history import and rejects foreign sessions/topics", async () => {
    const { service, openMem } = fixture();
    await writeFile(join(root, "sessions/websocket_chat-one.jsonl"), file(a, "websocket:chat-one", "2026-11-12T10:00:00.000Z"));
    await writeFile(join(root, "sessions/websocket_chat-two.jsonl"), file(b, "websocket:chat-two"));
    await service.configure(a, true); await service.tick();
    expect(openMem.mock.calls.some(([route]) => route === "add/message")).toBe(false);
    await expect(service.importSessions(a, ["websocket:chat-two"])).rejects.toThrow("当前项目");
    await expect(service.topic(a, "topic_foreign")).rejects.toThrow("不属于");
    await service.importSessions(a, ["websocket:chat-one"]); await service.tick();
    expect((await service.view(a)).jobs).toHaveLength(1);
  });
  it("stops collection when disabled, syncs instructions and detaches removed projects without deleting memory", async () => {
    const { service, openMem, instructions } = fixture();
    await service.configure(a, true);
    instructions.mockResolvedValue("新项目规范"); await service.tick();
    expect(openMem).toHaveBeenCalledWith("update/space", expect.objectContaining({ instructions: "新项目规范" }));
    await service.configure(a, false);
    await writeFile(join(root, "sessions/websocket_chat-one.jsonl"), file()); await service.tick();
    expect((await service.view(a)).jobs).toHaveLength(0);
    await writeFile(join(root, "projects.json"), '{"projects":[]}'); await service.tick();
    expect(JSON.parse(await readFile(join(root, "bindings.json"), "utf8")).projects).toEqual({});
    expect(openMem.mock.calls.some(([route]) => route === "delete/space")).toBe(false);
  });
  it("does not organize model failures or interruption recovery placeholders", () => {
    const records = file().split("\n").map(line => JSON.parse(line));
    records[2].model_error = { code: "model_failed", detail: "offline" };
    expect(parseDesktopMemorySession(records.map(row => JSON.stringify(row)).join("\n"))?.turns).toEqual([]);
    delete records[2].model_error;
    records[2].content = "Error: Task interrupted before a response was generated.";
    expect(parseDesktopMemorySession(records.map(row => JSON.stringify(row)).join("\n"))?.turns).toEqual([]);
    records.splice(2, 0, { role: "assistant", timestamp: records[1].timestamp, content: "正在检查网络", tool_calls: [{ function: { name: "inspect", arguments: "{}" } }] });
    expect(parseDesktopMemorySession(records.map(row => JSON.stringify(row)).join("\n"))?.turns).toEqual([]);
  });
  it("ignores incomplete/tool-only turns and fails closed on a corrupt registry", async () => {
    expect(parseDesktopMemorySession(file().split("\n").slice(0,2).join("\n"))?.turns).toEqual([]);
    const { service, openMem } = fixture();
    await writeFile(join(root, "bindings.json"), "broken");
    await expect(service.configure(a, true)).rejects.toThrow();
    expect(openMem).not.toHaveBeenCalled();
  });
});

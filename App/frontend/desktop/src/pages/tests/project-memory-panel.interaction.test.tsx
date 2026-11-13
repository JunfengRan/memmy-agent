// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectMemoryPanel, ProjectMemorySetting } from "../project-memory-panel.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
const api = vi.hoisted(() => ({ view: vi.fn(), configure: vi.fn(), topics: vi.fn(), topic: vi.fn(), sessions: vi.fn(), importSessions: vi.fn(), retry: vi.fn() }));
vi.mock("../../api/project-memory-client.js", () => ({ createProjectMemoryClient: () => api }));
vi.mock("../../app/providers.js", () => ({ useApiClients: () => ({ clients: { runtimeConfig: {} } }) }));
let root: Root;
const binding = { enabled: true, spaceId: "space_test", projectName: "推送服务" };
const view = { binding, jobs: [{ id: "failed", title: "推送配置", status: "failed", error: "模型未配置" }], error: null };
const topic = { id: "topic_push", space_id: "space_test", domain: "通用", topic_name: "推送策略", topic_summary: "失败后重试五次", topic_description: "网络错误会重试", decisions: [{ content: "重试五次", time: "2026-11-13", user_ids: ["a"], history: [{ content: "此前重试三次", time: "2026-11-12" }], conflicts: [{ content: "成员建议重试两次", time: "2026-11-12" }] }], experiences: [], timeline: [], sources: [{ conversation_id: "websocket:source" }] };
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  api.view.mockResolvedValue(view); api.topics.mockResolvedValue({ topic_detail_list: [topic], total: 1 }); api.topic.mockResolvedValue({ topic_detail_list: [topic] });
  api.sessions.mockResolvedValue({ sessions: [{ conversationId: "websocket:source", title: "已完成的推送配置", turnCount: 2 }] });
  api.configure.mockResolvedValue(view); api.importSessions.mockResolvedValue(view); api.retry.mockResolvedValue(view);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; });
async function click(label: string) { const button = Array.from(document.querySelectorAll("button")).find(node => node.textContent?.trim() === label); expect(button, label).toBeTruthy(); await act(async () => button!.click()); }
async function panel(onOpenSource = vi.fn()) { await act(async () => root.render(<I18nProvider language="zh-CN"><ProjectMemoryPanel projectId="a" projectName="推送服务" onClose={vi.fn()} sourceKeys={["websocket:source"]} onOpenSource={onOpenSource} /></I18nProvider>)); return onOpenSource; }
describe("project memory UI", () => {
  it("renders raw decisions/history/conflicts and opens an allowed source", async () => {
    const open = await panel();
    const button = Array.from(document.querySelectorAll("button")).find(node => node.textContent?.includes("推送策略"));
    await act(async () => button!.click());
    expect(document.body.textContent).toContain("此前重试三次"); expect(document.body.textContent).toContain("成员建议重试两次");
    await click("查看来源任务"); expect(open).toHaveBeenCalledWith("websocket:source");
  });
  it("imports only selected tasks and retries failures", async () => {
    await panel(); await click("导入历史任务");
    const input = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => input.click()); await click("导入所选任务");
    expect(api.importSessions).toHaveBeenCalledWith(["websocket:source"]);
    await click("重试失败任务"); expect(api.retry).toHaveBeenCalled();
  });
  it("starts disabled and explicitly enables local memory in settings", async () => {
    api.view.mockResolvedValue({ binding: null, jobs: [], error: null });
    await act(async () => root.render(<I18nProvider language="zh-CN"><ProjectMemorySetting projectId="a" /></I18nProvider>));
    const input = document.querySelector<HTMLInputElement>('[role="switch"]')!;
    expect(input.checked).toBe(false); await act(async () => input.click()); expect(api.configure).toHaveBeenCalledWith(true);
  });
});

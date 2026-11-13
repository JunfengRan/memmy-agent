import { projectPayloadView, renderTurnMemories } from "./project-render.js";
/** Local project access is resolved and authorized by the desktop backend. */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { SourceTurn } from "@memmy/agent-source-core";

export interface LocalProjectRequestOptions {
  configUrl?: URL;
  configPath?: string;
  fetch?: typeof fetch;
}
export async function requestLocalProjectMemory(action: "recall" | "capture", body: Record<string, unknown>, options: LocalProjectRequestOptions = {}): Promise<Record<string, unknown>> {
  const snapshot = options.configUrl ? JSON.parse(await readFile(options.configUrl, "utf8")) : {};
  const configPath = options.configPath || snapshot.memmy_config_path || join(homedir(), ".memmy", "config.yaml");
  const runtime = JSON.parse(await readFile(join(dirname(configPath), "runtime.json"), "utf8"));
  const base = new URL(runtime.baseUrl);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !runtime.localToken) throw new Error("Local Memmy backend is unavailable");
  const response = await (options.fetch || fetch)(new URL(`/api/project-memory/${action}`, base), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/json", "x-memmy-local-token": runtime.localToken },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Local project memory ${action} failed (${response.status})`);
  return await response.json() as Record<string, unknown>;
}
export async function recallLocalProjectMemory(input: { configUrl: URL; workspace: string; query: string; conversationId?: string }): Promise<string> {
  if (!input.workspace || !input.query.trim()) return "";
  try {
    const result = await requestLocalProjectMemory("recall", { workspace: input.workspace, query: input.query, conversationId: input.conversationId, recallVia: "turn_start" }, input);
    if (result.bound !== true) return "";
    const view = projectPayloadView(result.data);
    return renderTurnMemories({ kind: "turn", topics: view.topics, degraded: view.degraded, budgetTokens: 2500 }) || "";
  } catch { return ""; }
}
export async function captureLocalProjectTurn(input: { configUrl: URL; workspace: string; turn: SourceTurn }): Promise<void> {
  if (!input.workspace || input.turn.source !== "codex" || input.turn.status !== "succeeded") return;
  await requestLocalProjectMemory("capture", { workspace: input.workspace, turn: input.turn }, input);
}

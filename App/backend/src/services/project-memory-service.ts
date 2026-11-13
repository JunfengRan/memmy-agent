import { homedir } from "node:os";
import YAML from "yaml";
import { redactSecrets } from "@memmy/agent-source-core";
/** Desktop-owned bindings and durable delivery journal. Memory owns all organization and storage. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import * as lockfile from "proper-lockfile";
import { z } from "zod";
import { PROJECT_MEMORY_BINDINGS_FILE, ProjectMemoryBindingsSchema, ProjectMemoryJobSchema, type ProjectMemoryBinding, type ProjectMemoryView } from "@memmy/local-api-contracts";
import { MemoryLayerError, type MemoryClient } from "../adapters/outbound/memory-client/index.js";

const MessageSchema = z.object({ role: z.enum(["user", "assistant"]), chat_time: z.string().datetime({ offset: true }), content: z.string(), tool_calls: z.array(z.unknown()).optional() });
const JobSchema = ProjectMemoryJobSchema.extend({ projectId: z.string(), messages: z.array(MessageSchema), userId: z.string(), agentId: z.string().default("memmy"), deliveryLease: z.object({ token: z.string(), until: z.string().datetime() }).nullable().default(null) });
export const ExternalProjectTurnSchema = z.object({
  source: z.literal("codex"), conversationId: z.string().min(1).max(512), turnId: z.string().min(1).max(512),
  startedAt: z.string().datetime({ offset: true }), completedAt: z.string().datetime({ offset: true }),
  query: z.string().max(500_000), answer: z.string().max(500_000), status: z.enum(["succeeded", "failed"]),
  workspacePath: z.string().optional(), toolCalls: z.array(z.object({ name: z.string(), input: z.unknown().optional(), id: z.string().optional() })).max(1000).default([])
});
type Job = z.infer<typeof JobSchema>;
const StateSchema = ProjectMemoryBindingsSchema.extend({ jobs: z.record(z.string(), JobSchema).default({}) });
type State = z.infer<typeof StateSchema>;
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const contentText = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(item => text(object(item).text)).filter(Boolean).join("\n") : "";
export interface DesktopMemorySession { conversationId: string; projectId: string; title: string; updatedAt: string; turns: Array<{ messages: z.infer<typeof MessageSchema>[]; at: string }> }

/** Both live collection and explicit history import use the same saved messages and timestamps. */
export function parseDesktopMemorySession(source: string): DesktopMemorySession | null {
  const records = source.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as RecordValue);
  const header = records.find(row => row.recordType === "metadata");
  const metadata = object(header?.metadata);
  const key = text(header?.key);
  const projectId = text(metadata.webuiProjectId);
  if (!projectId || metadata.webui !== true || !key.startsWith("websocket:")) return null;
  const turns: DesktopMemorySession["turns"] = [];
  let messages: z.infer<typeof MessageSchema>[] = [];
  const finish = () => {
    if (messages.length > 1 && messages.at(-1)?.role === "assistant" && messages.at(-1)?.content.trim() && !messages.at(-1)?.tool_calls?.length) turns.push({ at: messages[0]!.chat_time, messages });
    messages = [];
  };
  for (const row of records) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    if (row.role === "user") finish();
    if (row.model_error || contentText(row.content) === "Error: Task interrupted before a response was generated.") { messages = []; continue; }
    if (/^\s*<memmy_assist_result\b/u.test(contentText(row.content)) || row.internal_context || row.assist_result || row.status === "cancelled" || row.status === "failed") continue;
    const parsed = MessageSchema.safeParse({ role: row.role, chat_time: row.timestamp, content: contentText(row.content), ...(Array.isArray(row.tool_calls) ? { tool_calls: row.tool_calls } : {}) });
    if (!parsed.success) continue;
    if (row.role === "user" ? !parsed.data.content.trim() : !messages.length) continue;
    messages.push(parsed.data);
  }
  finish();
  return { conversationId: key, projectId, title: text(metadata.title) || key.slice(10), updatedAt: text(header?.updatedAt), turns };
}

export interface ProjectMemoryServiceOptions {
  autoEnableProjects?: boolean;
  memmyConfigPath: string; memoryClient: MemoryClient; getUserId: () => string;
  readInstructions: (directory: string) => Promise<string>;
  filePath?: string; projectsFile?: string; sessionsDir?: string; now?: () => Date;
}
export function createDesktopProjectMemoryService(options: ProjectMemoryServiceOptions) {
  const configDir = dirname(options.memmyConfigPath);
  const filePath = options.filePath ?? join(configDir, PROJECT_MEMORY_BINDINGS_FILE);
  const projectsFile = options.projectsFile ?? join(process.env.MEMMY_AGENT_DATA_DIR || configDir, "webui", "projects.json");
  async function sessionsDirectory() {
    if (options.sessionsDir) return options.sessionsDir;
    let workspace = process.env.MEMMY_AGENT_WORKSPACE;
    if (!workspace) {
      try { workspace = text(object(object(object(YAML.parse(await readFile(options.memmyConfigPath, "utf8"))).agents).defaults).workspace); }
      catch { /* The normal default is used when the configuration has not been written yet. */ }
    }
    workspace ||= join(homedir(), ".memmy", "workspace");
    if (workspace === "~" || workspace.startsWith("~/")) workspace = join(homedir(), workspace.slice(2));
    return join(workspace, "sessions");
  }
  const now = options.now ?? (() => new Date());
  const automaticBindingStart = now().toISOString();
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeTick: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let lastError: string | null = null;
  const open = async (route: string, body: RecordValue) => {
    if (!options.memoryClient.openMem) throw new Error("请更新并启动项目记忆服务");
    return options.memoryClient.openMem(route, body);
  };
  async function load(): Promise<State> {
    try { return StateSchema.parse(JSON.parse(await readFile(filePath, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: {}, jobs: {} }; throw error; }
  }
  async function store(state: State) {
    const temp = `${filePath}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await rename(temp, filePath); }
    finally { await rm(temp, { force: true }); }
  }
  function mutate<T>(run: (state: State) => Promise<T>): Promise<T> {
    const next = queue.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const target = `${filePath}.target`;
      await writeFile(target, "", { flag: "a", mode: 0o600 });
      const release = await lockfile.lock(target, { retries: { retries: 40, minTimeout: 50, maxTimeout: 250 }, stale: 120_000 });
      try { const state = await load(); const result = await run(state); await store(state); return result; }
      finally { await release(); }
    });
    queue = next.catch(() => undefined);
    return next;
  }
  async function projects(): Promise<Array<{ id: string; name: string; root_path: string; state: string }>> {
    try { return z.object({ projects: z.array(z.object({ id: z.string(), name: z.string(), root_path: z.string(), state: z.string() })) }).parse(JSON.parse(await readFile(projectsFile, "utf8"))).projects.filter(project => project.state === "active"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async function project(id: string) {
    const found = (await projects()).find(entry => entry.id === id);
    if (!found) throw new MemoryLayerError("not_found", 404, "本机项目不存在");
    return found;
  }
  const sessionCache = new Map<string, { stamp: string; session: DesktopMemorySession | null }>();
  async function readSessions() {
    const found: DesktopMemorySession[] = [];
    const sessionsDir = await sessionsDirectory();
    for (const entry of await readdir(sessionsDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.startsWith("websocket_") || !entry.name.endsWith(".jsonl")) continue;
      try {
        const path = join(sessionsDir, entry.name);
        const info = await stat(path);
        if (info.size > 50 * 1024 * 1024) continue;
        const stamp = `${info.mtimeMs}:${info.size}`;
        let cached = sessionCache.get(path);
        if (!cached || cached.stamp !== stamp) { cached = { stamp, session: parseDesktopMemorySession(await readFile(path, "utf8")) }; sessionCache.set(path, cached); }
        if (cached.session) found.push(cached.session);
      }
      catch { /* An in-flight or malformed file is retried on the next collection. */ }
    }
    return found;
  }
  async function sessions(id: string) { await project(id); return (await readSessions()).filter(session => session.projectId === id); }
  function addTurns(state: State, binding: ProjectMemoryBinding, session: DesktopMemorySession, history: boolean) {
    for (const turn of session.turns) {
      if (!history && Date.parse(turn.at) < Date.parse(binding.enabledAt)) continue;
      const id = createHash("sha256").update(JSON.stringify([binding.spaceId, session.conversationId, turn.messages])).digest("hex");
      if (state.jobs[id]) continue;
      state.jobs[id] = { id, projectId: session.projectId, conversationId: session.conversationId, title: session.title, messages: turn.messages, userId: options.getUserId(), agentId: "memmy", taskId: null, status: "pending", error: null, deliveryLease: null };
    }
  }
  async function tick(): Promise<void> {
    if (options.autoEnableProjects) {
      const bindings = (await load()).projects;
      for (const owner of await projects()) if (!bindings[owner.id]) await service.configure(owner.id, true);
    }
    const updates = await mutate(async state => {
      lastError = null;
      const updates: Array<{ id: string; spaceId: string; instructions: string; name: string }> = [];
      const active = await projects();
      const localSessions = Object.values(state.projects).some(binding => binding.enabled) ? await readSessions() : [];
      for (const id of Object.keys(state.projects)) {
        const owner = active.find(entry => entry.id === id);
        if (!owner) { delete state.projects[id]; for (const [key, job] of Object.entries(state.jobs)) if (job.projectId === id) delete state.jobs[key]; continue; }
        const binding = state.projects[id]!;
        if (!binding.enabled) continue;
        try {
          const instructions = await options.readInstructions(owner.root_path);
          if (binding.instructions !== instructions || binding.projectName !== owner.name) updates.push({ id, spaceId: binding.spaceId, instructions, name: owner.name });
          for (const session of localSessions.filter(session => session.projectId === id)) addTurns(state, binding, session, false);
        } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
      }
      // mutate persists every raw delivery before any network side effect.
      return updates;
    });
    for (const update of updates) {
      try {
        await open("update/space", { space_id: update.spaceId, space_name: update.name, instructions: update.instructions });
        await mutate(async state => { const binding = state.projects[update.id]; if (binding?.spaceId === update.spaceId) { binding.instructions = update.instructions; binding.projectName = update.name; } });
      } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    }
    const visited = new Set<string>();
    // Bound each pass. Only short claims and journal writes hold the global file lock.
    for (let count = 0; count < 4; count++) {
      const work = await mutate(async state => {
        const job = Object.values(state.jobs).find(job => !visited.has(job.id) && state.projects[job.projectId]?.enabled
          && (job.status === "pending" || job.status === "running")
          && (!job.deliveryLease || Date.parse(job.deliveryLease.until) <= now().getTime()));
        if (!job) return null;
        job.deliveryLease = { token: randomUUID(), until: new Date(now().getTime() + 300_000).toISOString() };
        return { job: structuredClone(job), spaceId: state.projects[job.projectId]!.spaceId };
      });
      if (!work) break;
      const { job, spaceId } = work;
      visited.add(job.id);
      const save = async (release: boolean) => mutate(async state => {
        const current = state.jobs[job.id];
        if (!current || current.deliveryLease?.token !== job.deliveryLease?.token || state.projects[job.projectId]?.spaceId !== spaceId) return;
        current.taskId = job.taskId; current.status = job.status; current.error = job.error;
        if (release) current.deliveryLease = null;
      });
      try {
        const latest = await load();
        if (!latest.projects[job.projectId]?.enabled) { await save(true); continue; }
        if (!job.taskId) {
          const result = await open("add/message", { user_id: job.userId, agent_id: job.agentId, conversation_id: job.conversationId, space_ids: [spaceId], domains: ["通用"], allow_memory_view: ["project"], messages: job.messages });
          job.taskId = z.string().min(1).parse(result.task_id); job.status = "running";
          await save(false);
        }
        const result = await open("get/status", { task_id: job.taskId });
        if (result.status === "completed") { job.status = "completed"; job.error = null; }
        else if (result.status === "failed") { job.status = "failed"; job.error = JSON.stringify(result.error ?? "整理失败，请检查记忆模型配置后重试"); }
      } catch (error) { job.status = "failed"; job.error = error instanceof Error ? error.message : String(error); }
      await save(true);
    }
  }
  async function resolveWorkspace(workspace: string) {
    if (!isAbsolute(workspace)) return null;
    const canonical = await realpath(workspace).catch(() => null);
    if (!canonical) return null;
    const matches = [];
    for (const owner of await projects()) {
      const directory = await realpath(owner.root_path).catch(() => null);
      if (!directory) continue;
      const remainder = relative(directory, canonical);
      if (!remainder || (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`))) matches.push({ owner, directory });
    }
    matches.sort((a, b) => b.directory.length - a.directory.length || a.owner.id.localeCompare(b.owner.id));
    if (!matches.length || (matches[1] && matches[0]!.directory === matches[1].directory)) return null;
    const owner = matches[0]!.owner;
    const binding = (await load()).projects[owner.id];
    return binding?.enabled ? { owner, binding } : null;
  }
  const service = {
    async recallWorkspace(workspace: string, query: string, conversationId?: string, recallVia: "turn_start" | "tool" = "turn_start", domains?: string[], memoryLimit = 5) {
      const resolved = await resolveWorkspace(workspace);
      if (!resolved) return { bound: false, data: {} };
      const { owner, binding } = resolved;
      const data = await open("search/memory", { user_id: options.getUserId(), space_ids: [binding.spaceId], query, include_memory_view: ["project"], memory_limit_number: memoryLimit, recall_via: recallVia, ...(domains?.length ? { domains } : {}), ...(conversationId ? { conversation_id: `codex:${conversationId.replace(/^codex:/u, "")}` } : {}) });
      // Disabling a project while a slow search is running must also discard its response.
      const latest = await resolveWorkspace(workspace);
      if (latest?.owner.id !== owner.id || latest.binding.spaceId !== binding.spaceId) return { bound: false, data: {} };
      return { bound: true, projectId: owner.id, spaceId: binding.spaceId, data };
    },
    async captureWorkspace(workspace: string, input: z.infer<typeof ExternalProjectTurnSchema>) {
      const turn = ExternalProjectTurnSchema.parse(input);
      const resolved = await resolveWorkspace(workspace);
      if (!resolved) return { bound: false, jobIds: [] };
      if (turn.workspacePath && (await resolveWorkspace(turn.workspacePath))?.owner.id !== resolved.owner.id) throw new MemoryLayerError("invalid_argument", 400, "轮次目录不属于当前项目");
      if (turn.status !== "succeeded" || !turn.query.trim() || !turn.answer.trim() || Date.parse(turn.completedAt) < Date.parse(turn.startedAt)) return { bound: true, jobIds: [] };
      const messages: z.infer<typeof MessageSchema>[] = [
        { role: "user", chat_time: turn.startedAt, content: redactSecrets(turn.query) },
        { role: "assistant", chat_time: turn.completedAt, content: redactSecrets(turn.answer), ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls.map(call => ({ type: "function", ...(call.id ? { id: call.id } : {}), function: { name: call.name, arguments: redactSecrets(JSON.stringify(call.input ?? {})) } })) } : {}) }
      ];
      return mutate(async state => {
        const latest = await resolveWorkspace(workspace);
        if (latest?.owner.id !== resolved.owner.id || latest.binding.spaceId !== resolved.binding.spaceId) return { bound: false, jobIds: [] };
        const binding = state.projects[resolved.owner.id];
        if (!binding?.enabled || binding.spaceId !== resolved.binding.spaceId) return { bound: false, jobIds: [] };
        if (Date.parse(turn.startedAt) < Date.parse(binding.enabledAt)) return { bound: true, jobIds: [] };
        const conversationId = `codex:${turn.conversationId.replace(/^codex:/u, "")}`;
        const id = createHash("sha256").update(JSON.stringify([binding.spaceId, conversationId, messages])).digest("hex");
        state.jobs[id] ??= { id, projectId: resolved.owner.id, conversationId, title: turn.query.slice(0, 80), messages, userId: options.getUserId(), agentId: "codex", taskId: null, status: "pending", error: null, deliveryLease: null };
        return { bound: true, jobIds: [id] };
      });
    },
    async view(id: string): Promise<ProjectMemoryView> { await project(id); const state = await load(); return { binding: state.projects[id] ?? null, jobs: Object.values(state.jobs).filter(job => job.projectId === id).map(({ messages: _messages, userId: _userId, projectId: _projectId, deliveryLease: _deliveryLease, ...job }) => job), error: lastError }; },
    async configure(id: string, enabled: boolean): Promise<ProjectMemoryView> {
      const owner = await project(id);
      let createdSpace: string | null = null;
      try { await mutate(async state => {
        let binding = state.projects[id];
        if (!binding && enabled) {
          const instructions = await options.readInstructions(owner.root_path);
          const space = await open("create/space", { space_name: owner.name, instructions, domains: [{ domain: "通用", description: "本项目的决策、经验与进展" }] });
          const spaceId = z.string().min(1).parse(space.space_id);
          createdSpace = spaceId;
          binding = { spaceId, enabled, enabledAt: options.autoEnableProjects ? automaticBindingStart : now().toISOString(), directory: owner.root_path, projectName: owner.name, instructions };
          state.projects[id] = binding;
        } else if (binding) { if (enabled && !binding.enabled) binding.enabledAt = now().toISOString(); binding.enabled = enabled; }
      }); } catch (error) {
        if (createdSpace) await open("delete/space", { space_id: createdSpace }).catch(() => undefined);
        throw error;
      }
      return this.view(id);
    },
    async listTopics(id: string, page: number) { await project(id); const binding = (await load()).projects[id]; return binding ? open("get/memory", { space_id: binding.spaceId, page, size: 20 }) : { topic_detail_list: [], total: 0 }; },
    async topic(id: string, topicId: string) {
      await project(id); const binding = (await load()).projects[id];
      if (!binding) throw new MemoryLayerError("not_found", 404, "项目尚未开启记忆");
      const result = await open(`get/memory/${topicId}`, {});
      const topic = object((result.topic_detail_list as unknown[])?.[0]);
      if (topic.space_id !== binding.spaceId) throw new MemoryLayerError("not_found", 404, "主题不属于当前项目");
      return result;
    },
    async listSessions(id: string) { return { sessions: (await sessions(id)).map(session => ({ conversationId: session.conversationId, title: session.title, turnCount: session.turns.length, updatedAt: session.updatedAt })) }; },
    async importSessions(id: string, ids: string[]) {
      const available = await sessions(id);
      if (ids.some(key => !available.some(session => session.conversationId === key))) throw new MemoryLayerError("invalid_argument", 400, "只能导入当前项目的本机 Memmy 任务");
      await mutate(async state => {
        const binding = state.projects[id];
        if (!binding?.enabled) throw new MemoryLayerError("conflict", 409, "请先开启本机项目记忆");
        for (const session of available.filter(session => ids.includes(session.conversationId))) addTurns(state, binding, session, true);
      });
      return this.view(id);
    },
    async retry(id: string) { await project(id); await mutate(async state => { for (const job of Object.values(state.jobs)) if (job.projectId === id && job.status === "failed") { job.status = "pending"; job.taskId = null; job.error = null; } }); return this.view(id); },
    tick,
    start() { if (timer) return; const run = () => { if (activeTick) return; activeTick = tick().catch(error => { lastError = error instanceof Error ? error.message : String(error); }).finally(() => { activeTick = null; }); }; timer = setInterval(run, 3_000); timer.unref(); run(); },
    async stop() { if (timer) clearInterval(timer); timer = undefined; await activeTick; await queue; }
  };
  return service;
}
export type DesktopProjectMemoryService = ReturnType<typeof createDesktopProjectMemoryService>;

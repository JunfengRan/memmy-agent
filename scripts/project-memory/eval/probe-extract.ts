import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSourceTurnRequest, type SourceTurn } from "../../../AgentSourceCore/src/source-turn.ts";
import { readCodexRollout } from "../../../AgentSourceCore/src/codex-source-turn.ts";
import Database from "better-sqlite3";
import { readCursorComposer, type CursorVscdbSource } from "../../../AgentSourceCore/src/cursor-source-turn.ts";
import { discoverCodexSessions } from "../../../Memory/src/agent-source/adapters/codex/session-discovery.ts";
import { listCursorComposerLocations } from "../../../Memory/src/agent-source/adapters/cursor/vscdb-reader.ts";
import { resolveCursorWorkspaceLocation } from "../../../Memory/src/agent-source/adapters/cursor/workspace-discovery.ts";
import { resolveCodexSessionsDirectory, resolveCursorDataPaths } from "../../../Memory/src/agent-source/agent-paths.ts";
import { DEFAULT_MEMMY_CONFIG, MemoryDb, MemoryService } from "../../../Memory/src/index.ts";
import { projectIdentityForLocation, resolveProjectRoot } from "../../../Memory/src/service/project/identity.ts";
import { defaultWorkspaceHostId } from "../../../Memory/src/service/project/host-id.ts";

const hostId = defaultWorkspaceHostId();

async function firstCodexTurn(): Promise<{ turn: SourceTurn; gitRoot: string | null; workspacePath: string | null } | null> {
  const sessions = await discoverCodexSessions({
    root: resolveCodexSessionsDirectory(),
    order: "recent_first",
    maxSessions: 20
  });
  for (const session of sessions) {
    if (!session.gitRoot) continue;
    for await (const message of readCodexRollout(session.sessionFilePath)) {
      const turn = message.rawMeta.sourceTurn;
      if (!turn || typeof turn !== "object") continue;
      const native = turn as SourceTurn;
      if (!native.query.trim() || !native.answer.trim()) continue;
      return {
        turn: { ...native, workspacePath: session.workspacePath ?? undefined, gitRoot: session.gitRoot },
        gitRoot: session.gitRoot,
        workspacePath: session.workspacePath
      };
    }
  }
  return null;
}

function cursorSource(db: Database.Database, composerId: string): CursorVscdbSource | null {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
  if (!table.get("composerHeaders") || !table.get("cursorDiskKV")) return null;
  const diskValue = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
  const parse = (key: string): unknown => {
    const row = diskValue.get(key) as { value?: unknown } | undefined;
    if (typeof row?.value !== "string") return undefined;
    try { return JSON.parse(row.value); } catch { return undefined; }
  };
  return {
    mainComposerIds: () => [composerId],
    composerData: (id) => parse(`composerData:${id}`),
    bubble: (id, bubbleId) => parse(`bubbleId:${id}:${bubbleId}`)
  };
}

async function firstCursorTurn(): Promise<{ turn: SourceTurn; gitRoot: string | null; workspacePath: string | null } | null> {
  const paths = resolveCursorDataPaths();
  const wanted = "33bef163eb370e5dab0fb6e7a11d1454";
  const match = listCursorComposerLocations(paths.globalStateDbPath).find((location) => location.workspaceId === wanted);
  if (!match) return null;
  const located = await resolveCursorWorkspaceLocation(paths.workspaceStorageDirectory, match.workspaceId);
  const db = new Database(paths.globalStateDbPath, { readonly: true, fileMustExist: true });
  try {
    const source = cursorSource(db, match.composerId);
    if (!source) return null;
    for await (const message of readCursorComposer(source, match.composerId)) {
      const turn = message.rawMeta.sourceTurn;
      if (!turn || typeof turn !== "object") continue;
      const native = turn as SourceTurn;
      if (!native.query.trim() || !native.answer.trim()) continue;
      return {
        turn: { ...native, workspacePath: located.workspacePath ?? undefined, gitRoot: located.gitRoot ?? undefined },
        gitRoot: located.gitRoot,
        workspacePath: located.workspacePath
      };
    }
  } finally {
    db.close();
  }
  return null;
}

function importTurn(label: string, found: { turn: SourceTurn; gitRoot: string | null; workspacePath: string | null } | null) {
  if (!found) return { label, missing: true };
  const root = mkdtempSync(join(tmpdir(), `memmy-probe-${label}-`));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const service = new MemoryService({
    db,
    mode: "dev",
    config: DEFAULT_MEMMY_CONFIG,
    fetchAppMemoryBudget: async () => null,
    llm: { config: DEFAULT_MEMMY_CONFIG.summary, isConfigured: () => false, async complete() { return ""; }, async completeJson() { return {}; }, status: () => ({ provider: "host", model: "off", configured: false, remote: false }) },
    embedder: { config: DEFAULT_MEMMY_CONFIG.embedding, isRemote: () => false, async embed(texts: string[]) { return texts.map(() => [1, 0, 0]); }, async embedOne() { return [1, 0, 0]; }, status: () => ({ provider: "local", model: "probe", configured: true, remote: false }) }
  });
  const request = {
    ...buildSourceTurnRequest(found.turn, "agent_source_scan"),
    gitRoot: found.gitRoot ?? found.turn.gitRoot,
    workspacePath: found.workspacePath ?? found.turn.workspacePath,
    captureLegacyHistory: true,
    namespace: { source: found.turn.source, profileId: "default", userId: "probe-user" }
  };
  const response = service.completeSourceTurn(request);
  const sessionRows = db.db.prepare(`SELECT project_id, workspace_path, source FROM sessions`).all() as Array<{ project_id: string | null; workspace_path: string | null; source: string }>;
  const memories = db.db.prepare(`SELECT memory_value, info_json FROM memories WHERE deleted_at IS NULL`).all() as Array<{ memory_value: string; info_json: string }>;
  const infos = memories.map((row) => JSON.parse(row.info_json || "{}") as Record<string, unknown>);
  const expected = projectIdentityForLocation("probe-user", hostId, found.gitRoot || found.workspacePath || "");
  const resolved = resolveProjectRoot(found.workspacePath || found.gitRoot || "");
  const subdir = expected ? projectIdentityForLocation("probe-user", hostId, `${expected.rootPath}/Memory`) : null;
  db.close();
  return {
    label,
    status: response.status,
    reason: "reason" in response ? response.reason : undefined,
    turnId: found.turn.turnId,
    extractor: {
      workspacePath: found.workspacePath,
      gitRoot: found.gitRoot,
      queryChars: found.turn.query.length,
      answerChars: found.turn.answer.length
    },
    expectedRoot: expected?.rootPath ?? null,
    resolvedKind: resolved?.kind ?? null,
    session: sessionRows[0] ?? null,
    memoryScope: infos.map((info) => info.memory_scope),
    memoryProject: infos.map((info) => info.project_id),
    checks: {
      gitRootIsResolvedRoot: Boolean(found.gitRoot && expected && found.gitRoot === expected.rootPath),
      sessionProjectMatches: sessionRows[0]?.project_id === (expected?.projectId ?? null),
      workspaceStoredAsRoot: sessionRows[0]?.workspace_path === (expected?.rootPath ?? null),
      scopeIsProject: Boolean(expected) && infos.some((info) => info.memory_scope === "project" && info.project_id === expected.projectId),
      subdirSharesProject: Boolean(expected && subdir && subdir.projectId === expected.projectId)
    }
  };
}

const codex = await firstCodexTurn();
const cursor = await firstCursorTurn();
process.stdout.write(`${JSON.stringify({ codex: importTurn("codex", codex), cursor: importTurn("cursor", cursor) }, null, 2)}\n`);

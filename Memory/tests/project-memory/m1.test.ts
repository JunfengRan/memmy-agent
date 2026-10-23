import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { deriveWorkspaceHostId } from "../../src/contracts/index.js";
import { cursorTurnInjection } from "../../src/service/project/capture.js";
import { changedFilesFromToolCalls } from "../../src/service/project/changed-files.js";
import { activitySectionLength, renderProjectActivity } from "../../src/service/project/context.js";
import { clearGitSnapshotCache, readGitSnapshot } from "../../src/service/project/git-status.js";
import { projectIdentityForLocation, resolveProjectRoot } from "../../src/service/project/identity.js";
import { mergeSubdirProjects } from "../../src/service/project/merge-subdirs.js";
import { SCOPE_WEIGHTS, scopeWeight } from "../../src/service/project/scope-weight.js";
import { renderMemmyResumeHookScript } from "../../src/agent-source/integration/templates/memmy-resume-hook.js";
import type { MemoryKind, MemoryRow } from "../../src/types.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";
import { readFileSync as readSource } from "node:fs";
import { fileURLToPath } from "node:url";

const cases = JSON.parse(readFileSync(new URL("./cases/m1/cases.json", import.meta.url), "utf8")) as Array<{
  id: string;
  requirement: string;
  kind: string;
  input: Record<string, unknown>;
  expect: Record<string, unknown>;
}>;
const fixture = createMemoryServiceFixture();
const roots: string[] = [];
afterEach(() => {
  clearGitSnapshotCache();
  fixture.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project memory M1 cases", () => {
  for (const item of cases) {
    it(`${item.id} ${item.requirement}`, () => {
      runCase(item);
    });
  }
});

function runCase(item: (typeof cases)[number]): void {
  switch (item.kind) {
    case "identity":
      return runIdentity(item.input.layout as string, item.expect);
    case "merge":
      return runMerge(item.expect);
    case "files":
      return runFiles(item.input.tool as string, item.expect);
    case "git":
      return runGit(item.expect);
    case "scope":
      return runScope(item.input.relation as string, item.expect);
    case "context":
      return runContext(item.expect);
    case "context-budget":
      return runContextBudget(item.expect);
    case "hook":
      return runHook(item.input.mode as string, item.expect);
    case "dedup":
      return runDedup(item.expect);
    default:
      throw new Error(`unknown case kind ${item.kind}`);
  }
}

function runIdentity(layout: string, expectCase: Record<string, unknown>): void {
  const userId = "m1-user";
  const hostId = deriveWorkspaceHostId("m1-installation");
  if (layout === "subdir") {
    const repo = gitRepo();
    mkdirSync(join(repo, "sub"));
    const root = projectIdentityForLocation(userId, hostId, repo);
    const sub = projectIdentityForLocation(userId, hostId, join(repo, "sub"));
    expect(sub?.projectId).toBe(root?.projectId);
    expect(Boolean(root?.projectId)).toBe(expectCase.sameProject);
    return;
  }
  if (layout === "symlink") {
    const parent = tempRoot();
    const repo = gitRepo(join(parent, "repo"));
    mkdirSync(join(repo, "sub"));
    const link = join(parent, "link");
    symlinkSync(join(repo, "sub"), link);
    const viaLink = projectIdentityForLocation(userId, hostId, link);
    const viaRoot = projectIdentityForLocation(userId, hostId, repo);
    expect(viaLink?.projectId).toBe(viaRoot?.projectId);
    expect(viaLink?.projectId === viaRoot?.projectId).toBe(expectCase.sameProject);
    return;
  }
  if (layout === "nongit") {
    const dir = tempRoot();
    const found = resolveProjectRoot(dir);
    expect(found?.kind).toBe(expectCase.kind);
    expect(found?.rootPath).toBe(realpathSync(dir));
    return;
  }
  const parent = tempRoot();
  const repo = gitRepo(join(parent, "repo"));
  commitFile(repo, "README.md", "hello\n");
  const worktree = join(parent, "wt");
  git(repo, ["worktree", "add", "--detach", worktree, "HEAD"]);
  const main = projectIdentityForLocation(userId, hostId, repo);
  const other = projectIdentityForLocation(userId, hostId, worktree);
  expect(main?.projectId).not.toBe(other?.projectId);
  expect(main?.projectId !== other?.projectId).toBe(expectCase.separateProjects);
}

function runMerge(expectCase: Record<string, unknown>): void {
  const { db, service } = fixture.createTestService();
  const repo = gitRepo();
  const sub = join(repo, "pkg");
  mkdirSync(sub);
  const hostId = deriveWorkspaceHostId("m1-merge");
  const opened = service.openSession({
    l3WorldModelProtocolVersion: 2,
    l3WorldModelTransition: "allow_legacy_rollover",
    workspaceUri: fileUri(sub),
    workspaceHostId: hostId,
    namespace: { source: "codex", profileId: "default", sessionKey: "merge-session", userId: "merge-user" }
  });
  service.completeTurn("merge-turn", {
    sessionId: opened.sessionId,
    query: "记一笔子目录改动",
    answer: "已记下",
    toolCalls: [{ name: "Edit", input: { file_path: "pkg/note.ts" } }]
  });
  const rootId = opened.projectId;
  db.db.prepare(`UPDATE sessions SET project_id = ? WHERE id = ?`).run("ws_old", opened.sessionId);
  db.db.prepare(
    `UPDATE memories SET info_json = json_set(info_json, '$.project_id', 'ws_old') WHERE session_id = ?`
  ).run(opened.sessionId);
  const report = mergeSubdirProjects(db.db, { userId: "merge-user", workspaceHostId: hostId, dryRun: true });
  expect(report.dryRun).toBe(true);
  expect(report.moves[0]?.sessions).toBe(expectCase.sessions);
  expect(report.moves[0]?.memories).toBe(expectCase.memories);
  mergeSubdirProjects(db.db, { userId: "merge-user", workspaceHostId: hostId, dryRun: false });
  const projectId = (db.db.prepare(`SELECT project_id AS projectId FROM sessions WHERE id = ?`).get(opened.sessionId) as { projectId: string }).projectId;
  expect(projectId).toBe(rootId);
}

function runFiles(tool: string, expectCase: Record<string, unknown>): void {
  if (tool === "apply_patch") {
    const files = changedFilesFromToolCalls([{
      name: "apply_patch",
      input: "*** Update File: src/a.ts\n*** Add File: src/b.ts\n"
    }], "/repo");
    expect(files).toEqual(expectCase.files);
    return;
  }
  if (tool === "edit") {
    const files = changedFilesFromToolCalls([
      { name: "Edit", input: { file_path: "src/edit.ts" } },
      { name: "Write", input: { file_path: "src/write.ts" } },
      { name: "file_write", input: { path: "src/memmy.ts" } }
    ]);
    expect(files).toEqual(expectCase.files);
    return;
  }
  const calls = Array.from({ length: 60 }, (_, index) => ({
    name: "Edit",
    input: { file_path: `src/file-${index}.ts` }
  }));
  expect(changedFilesFromToolCalls(calls)).toHaveLength(Number(expectCase.count));
}

function runGit(expectCase: Record<string, unknown>): void {
  const repo = gitRepo();
  writeFileSync(join(repo, "dirty.txt"), "changed\n");
  const snapshot = readGitSnapshot(repo);
  expect(snapshot.dirty).toBe(expectCase.dirty);
  expect(snapshot.head).toBeNull();
}

function runScope(relation: string, expectCase: Record<string, unknown>): void {
  if (relation === "other-l1") {
    expect(scopeWeight({ sessionProjectId: "ws_a" }, row("L1", "trace", "ws_b"))).toBe(expectCase.weight);
    return;
  }
  if (relation === "work-memory") {
    expect(scopeWeight({ sessionProjectId: "ws_a" }, row("L1", "work_memory", "ws_a"))).toBe(expectCase.same);
    expect(scopeWeight({ sessionProjectId: "ws_a" }, row("L1", "work_memory", "ws_b"))).toBe(expectCase.other);
    const source = readSource(fileURLToPath(new URL("../../src/storage/repositories.ts", import.meta.url)), "utf8");
    expect(source).toContain("workMemoryProjectId");
    return;
  }
  expect(SCOPE_WEIGHTS.projectSession.sameProjectL1).toBe(expectCase.sameL1);
  expect(scopeWeight({ sessionProjectId: "ws_a" }, row("L1", "trace", "ws_a"))).toBe(expectCase.sameL1);
  expect(scopeWeight({ sessionProjectId: "ws_a" }, row("L2", "policy", "ws_a"))).toBe(expectCase.sameL2);
  expect(scopeWeight({ sessionProjectId: "ws_a" }, row("L1", "trace", null))).toBe(expectCase.globalL1);
  expect(scopeWeight({ sessionProjectId: "ws_a" }, row("L2", "policy", null))).toBe(expectCase.globalL2);
  expect(scopeWeight({ sessionProjectId: "ws_a" }, row("Skill", "skill", null))).toBe(expectCase.globalSkill);
  expect(scopeWeight({ sessionProjectId: "ws_a" }, row("L2", "policy", "ws_b"))).toBe(expectCase.otherPolicy);
  expect(scopeWeight({ sessionProjectId: "ws_a" }, row("L2", "decision", "ws_b"))).toBeNull();
  expect(scopeWeight({ sessionProjectId: "ws_a" }, row("Skill", "skill", "ws_b"))).toBeNull();
  expect(scopeWeight({ sessionProjectId: null }, row("L2", "policy", "ws_a"))).toBe(1);
}

function runContext(expectCase: Record<string, unknown>): void {
  const rendered = renderProjectActivity({
    projectName: "memmy-agent",
    projectId: "ws_demo",
    events: [{
      agent: "cursor",
      at: "2026-10-21T06:02:00.000Z",
      summary: "改召回过滤",
      changedFiles: ["src/pool.ts"]
    }]
  });
  expect(rendered.markdown).toContain(`[${String(expectCase.includesAgent)} · 10/21 06:02]`);
  expect(rendered.markdown).toContain(String(expectCase.includesFile));
  expect(rendered.markdown).toContain("10/21 06:02");
}

function runContextBudget(expectCase: Record<string, unknown>): void {
  const rendered = renderProjectActivity({
    projectName: "memmy-agent",
    projectId: "ws_demo",
    events: Array.from({ length: 30 }, (_, index) => ({
      agent: "codex",
      at: "2026-10-21T06:02:00.000Z",
      summary: `事项 ${index} ${"细节".repeat(40)}`,
      changedFiles: [`src/file-${index}.ts`]
    }))
  });
  expect(activitySectionLength(rendered.markdown)).toBeLessThanOrEqual(Number(expectCase.max));
  expect(rendered.truncated).toBe(true);
}

function runHook(mode: string, expectCase: Record<string, unknown>): void {
  const script = renderMemmyResumeHookScript({ source: "cursor", mode: "cursor" });
  expect(script).toContain("MEMMY_CURSOR_TURN_INJECTION");
  expect(script).toContain("afterfileedit");
  expect(script).toContain("8000");
  if (mode === "off") {
    expect(cursorTurnInjection("项目近况", "0")).toEqual({ continue: expectCase.continue });
    return;
  }
  const injected = cursorTurnInjection("x".repeat(9000), undefined);
  expect(injected).toHaveProperty(String(expectCase.field));
  if ("additional_context" in injected) expect(injected.additional_context).toHaveLength(8000);
}

function runDedup(expectCase: Record<string, unknown>): void {
  const { db, service } = fixture.createTestService();
  const repo = gitRepo();
  mkdirSync(join(repo, "sub"));
  const query = "同一句问答";
  const answer = "只应在项目视图出现一次";
  const first = service.completeSourceTurn(sourceTurn("cursor", "cursor-chat", "turn-1", repo, query, answer));
  const second = service.completeSourceTurn(sourceTurn("codex", "codex-chat", "turn-2", join(repo, "sub"), query, answer));
  expect(first.status).toBe("stored");
  expect(second.status).toBe("stored");
  const rows = db.db.prepare(
    `SELECT json_extract(info_json, '$.duplicate_of') AS duplicateOf
     FROM memories WHERE memory_layer = 'L1' AND deleted_at IS NULL`
  ).all() as Array<{ duplicateOf: string | null }>;
  expect(rows).toHaveLength(Number(expectCase.stored));
  expect(rows.filter((row) => !row.duplicateOf)).toHaveLength(Number(expectCase.visible));
}

function sourceTurn(source: string, conversationId: string, turnId: string, gitRoot: string, query: string, answer: string) {
  return {
    namespace: { source, profileId: "default", userId: "dedup-user" },
    source,
    channel: "hook" as const,
    gitRoot,
    query,
    answer,
    sourceTurn: {
      source,
      profileId: "default",
      conversationId,
      turnId,
      startedAt: "2099-01-01T10:00:00.000Z",
      completedAt: "2099-01-01T10:01:00.000Z",
      sequence: 1,
      completionEvidence: `done:${turnId}`
    }
  };
}

function row(layer: MemoryRow["memoryLayer"], kind: string, projectId: string | null): MemoryRow {
  const at = "2026-10-21T00:00:00.000Z";
  return {
    id: `${layer}-${kind}-${projectId ?? "global"}`,
    timeline: at,
    userId: "scope-user",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryValue: "value",
    tags: [],
    info: projectId ? { project_id: projectId, memory_scope: "project" } : { memory_scope: "global" },
    properties: { internal_info: { memory_layer: layer, memory_kind: kind as MemoryKind } },
    memoryLayer: layer,
    version: 1,
    createdAt: at,
    updatedAt: at
  };
}

function gitRepo(path?: string): string {
  const repo = path ?? tempRoot();
  mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  return repo;
}

function commitFile(repo: string, name: string, contents: string): void {
  writeFileSync(join(repo, name), contents);
  git(repo, ["add", name]);
  git(repo, ["-c", "user.email=m1@example.com", "-c", "user.name=M1", "commit", "-m", "init"]);
}

function git(repo: string, args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-m1-"));
  roots.push(root);
  return root;
}

function fileUri(path: string): `file://${string}` {
  return `file://${path}` as `file://${string}`;
}

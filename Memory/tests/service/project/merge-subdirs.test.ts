import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { deriveWorkspaceHostId } from "../../../src/contracts/index.js";
import { mergeSubdirProjects } from "../../../src/service/project/merge-subdirs.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
const roots: string[] = [];
afterEach(() => {
  fixture.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("mergeSubdirProjects", () => {
  it("moves policy keys with the project and keeps one live policy per hash", () => {
    const repo = mkdtempSync(join(tmpdir(), "memmy-merge-"));
    roots.push(repo);
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "pkg"));
    const { db, service } = fixture.createTestService();
    const hostId = deriveWorkspaceHostId("merge-policy");
    const opened = service.openSession({
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: "allow_legacy_rollover",
      workspaceUri: pathToFileURL(join(repo, "pkg")).href,
      workspaceHostId: hostId,
      namespace: { source: "codex", profileId: "default", sessionKey: "merge-policy", userId: "merge-user" }
    });
    const turn = service.completeTurn("merge-policy-turn", {
      sessionId: opened.sessionId,
      query: "记一笔子目录改动",
      answer: "已记下"
    });
    const rootId = opened.projectId!;
    const repos = new Repositories(db.db);
    const trace = repos.memories.get(turn.l1MemoryIds[0]!)!;
    const policy = (id: string, key: string, projectId: string) => repos.memories.insert({
      ...trace,
      id,
      memoryLayer: "L2",
      memoryKey: key,
      contentHash: `${id}-hash`,
      info: { ...trace.info, project_id: projectId, memory_scope: "project" }
    });
    policy("policy-moved", "policy:ws_old:aaaaaaaaaaaaaaaa", "ws_old");
    policy("policy-clash", "policy:ws_old:bbbbbbbbbbbbbbbb", "ws_old");
    policy("policy-kept", `policy:${rootId}:bbbbbbbbbbbbbbbb`, rootId);
    db.db.prepare(`UPDATE sessions SET project_id = 'ws_old' WHERE id = ?`).run(opened.sessionId);
    db.db.prepare(`UPDATE memories SET info_json = json_set(info_json, '$.project_id', 'ws_old') WHERE id = ?`).run(trace.id);

    mergeSubdirProjects(db.db, { userId: "merge-user", workspaceHostId: hostId, dryRun: false });

    expect(repos.memories.get("policy-moved")!.memoryKey).toBe(`policy:${rootId}:aaaaaaaaaaaaaaaa`);
    expect(repos.memories.get("policy-clash")!.info.duplicate_of).toBe("policy-kept");
    expect(repos.memories.get("policy-kept")!.info.duplicate_of).toBeUndefined();
    expect(repos.memories.get(trace.id)!.info.project_id).toBe(rootId);
  });
});

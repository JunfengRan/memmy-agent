import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceHostId } from "../../../src/contracts/memory-workspace-identity.js";
import { projectIdentityForLocation } from "../../../src/service/project/identity.js";
import { Repositories } from "../../../src/storage/repositories.js";
import type { MemoryRow } from "../../../src/types.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const hostId = "a".repeat(64) as WorkspaceHostId;
const { cleanup, createTestService } = createMemoryServiceFixture();
const roots: string[] = [];

afterEach(() => {
  cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("listProjectTopics", () => {
  it("groups stored project notes for a local directory and leaves unknown paths empty", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-topics-"));
    roots.push(root);
    const { db, service } = createTestService();
    const identity = projectIdentityForLocation("local-user", hostId, root);
    expect(identity?.projectId).toBeTruthy();
    const repos = new Repositories(db.db);
    repos.memories.insert(note({
      id: "note-1",
      projectId: identity!.projectId!,
      topicName: "项目记忆",
      decision: "看板只读已有事项",
      checkpoint: "已从会话归纳",
      sessionId: "sess-1",
      updatedAt: "2026-10-23T08:00:00.000Z"
    }));
    repos.memories.insert(note({
      id: "activity-1",
      projectId: identity!.projectId!,
      topicName: "",
      decision: "",
      checkpoint: "",
      sessionId: "sess-2",
      updatedAt: "2026-10-23T09:00:00.000Z",
      summary: "另一位成员更新了检索"
    }));

    const listed = service.listProjectTopics({
      userId: "local-user",
      workspacePath: root,
      workspaceHostId: hostId
    });

    expect(listed.projectId).toBe(identity!.projectId);
    expect(listed.rootPath).toBe(identity!.rootPath);
    expect(listed.topics).toHaveLength(1);
    expect(listed.topics[0]).toMatchObject({
      name: "项目记忆",
      sourceSessionIds: ["sess-1", "sess-2"]
    });
    expect(listed.topics[0]?.summary).toContain("已从会话归纳");
    expect(listed.topics[0]?.decisions.map((item) => item.text)).toContain("看板只读已有事项");
    expect(listed.topics[0]?.events.some((item) => item.text.includes("检索"))).toBe(true);
    expect(service.listProjectTopics({
      userId: "local-user",
      workspacePath: join(root, "missing-child"),
      workspaceHostId: hostId
    })).toEqual({ projectId: null, rootPath: null, topics: [] });
    expect(() => service.listProjectTopics({
      userId: "local-user",
      workspacePath: "  ",
      workspaceHostId: hostId
    })).toThrow(/workspacePath/);
  });
});

function note(input: {
  id: string;
  projectId: string;
  topicName: string;
  decision: string;
  checkpoint: string;
  sessionId: string;
  updatedAt: string;
  summary?: string;
}): MemoryRow {
  return {
    id: input.id,
    timeline: input.updatedAt,
    userId: "local-user",
    sessionId: input.sessionId,
    agentId: "cursor",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryLayer: "L1",
    memoryValue: input.summary ?? (input.checkpoint || input.decision || input.topicName),
    info: {
      project_id: input.projectId,
      ...(input.topicName ? { topic_name: input.topicName } : {}),
      ...(input.decision ? { current_decision: input.decision } : {}),
      ...(input.checkpoint ? { checkpoint_summary: input.checkpoint } : {}),
      ...(input.summary ? { summary: input.summary } : {})
    },
    properties: {
      internal_info: { memory_layer: "L1" }
    },
    tags: [],
    contentHash: input.id,
    version: 1,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    deletedAt: null
  };
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { acceptProjectTask } from "../../../src/service/project-memory/pipeline/accept.js";
import { createSqliteProjectTaskRuntime } from "../../../src/service/project-memory/store/sqlite/task-runtime.js";
import { ProjectLocalState } from "../../../src/service/project-memory/store/sqlite/local-state.js";

const roots: string[] = [];
const databases: MemoryDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pm-accept-"));
  roots.push(root);
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  databases.push(db);
  const state = new ProjectLocalState(db.db);
  const runtime = createSqliteProjectTaskRuntime(new Repositories(db.db));
  const input = {
    task: { taskId: "task_a", spaceIds: ["space_a", "space_b"], conversationId: "conversation_a", batchKey: "batch_a", sourceBatchId: "task_a", acceptedAt: "2026-11-16T00:00:00.000Z" },
    turns: [{ conversationId: "conversation_a", role: "user" as const, roleId: "a", roleName: null, chatTime: "2026-11-16T00:00:00.000Z", chatTimeInferred: false, content: "推送失败重试三次", toolCalls: [] }],
    userId: "a", domains: ["通用"], agentId: "memmy", conversationId: "conversation_a", strippedBlocks: 0, unclosedBlocks: 0
  };
  return { db, state, runtime, input };
}

describe("project task acceptance", () => {
  it("rolls back messages, task and every queued Space if enqueue fails", () => {
    const { db, state, runtime, input } = fixture();
    let calls = 0;
    const failing = { ...runtime, enqueue: (...args: Parameters<typeof runtime.enqueue>) => {
      runtime.enqueue(...args);
      if (++calls === 2) throw new Error("enqueue failure");
    } };
    expect(() => acceptProjectTask(input, { state, runtime: failing })).toThrow("enqueue failure");
    for (const table of ["pm_raw_turns", "pm_task_turns", "pm_tasks", "evolution_jobs"]) {
      expect(db.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
    }
  });

  it("deduplicates acceptance without enqueueing a second set of jobs", () => {
    const { db, state, runtime, input } = fixture();
    const first = acceptProjectTask(input, { state, runtime });
    const second = acceptProjectTask({ ...input, task: { ...input.task, taskId: "task_replay" } }, { state, runtime });
    expect(second.taskId).toBe(first.taskId);
    const jobs = db.db.prepare("SELECT scope_key, scope_seq FROM evolution_jobs ORDER BY scope_key").all();
    expect(jobs).toEqual([{ scope_key: "project_memory:space_a", scope_seq: 1 }, { scope_key: "project_memory:space_b", scope_seq: 1 }]);
    expect(db.db.prepare("SELECT COUNT(*) FROM pm_tasks").pluck().get()).toBe(1);
  });
});

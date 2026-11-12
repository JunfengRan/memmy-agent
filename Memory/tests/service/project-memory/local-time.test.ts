import { afterEach, describe, expect, it } from "vitest";
import { ProjectLocalState } from "../../../src/service/project-memory/store/sqlite/local-state.js";
import { createProjectMemoryHarness } from "./helpers.js";

const harness = createProjectMemoryHarness();
afterEach(() => harness.cleanup());

describe("project local turn chronology", () => {
  it("orders offset timestamps by instant and excludes future context before applying the limit", () => {
    const { db } = harness.createService();
    const local = new ProjectLocalState(db.db);
    const turn = (time: string, content: string, roleName = content) => ({
      conversationId: "offsets", role: "user" as const, roleId: "user_a", roleName,
      chatTime: time, chatTimeInferred: false, content, toolCalls: []
    });
    const create = (taskId: string, turns: ReturnType<typeof turn>[]) => local.createTask({
      taskId, spaceIds: ["space_a"], conversationId: "offsets", batchKey: taskId,
      sourceBatchId: taskId, acceptedAt: "2026-11-12T00:00:00Z"
    }, turns);
    // Lexical order is the reverse of instant order across UTC midnight.
    create("old", [
      turn("2026-11-12T08:10:00+09:00", "earliest"),
      turn("2026-11-11T23:20:00Z", "latest", "Latest name"),
      turn("2026-11-11T18:30:00-05:00", "future")
    ]);
    create("current", [turn("2026-11-11T23:25:00Z", "current")]);
    expect(local.taskTurns("old").map((item) => item.content)).toEqual(["earliest", "latest", "future"]);
    expect(local.contextTurns("offsets", "current", "2026-11-11T23:25:00Z", 1).map((item) => item.content)).toEqual(["latest"]);
    expect(local.roleName("user_a")).toBe("future");
  });
});

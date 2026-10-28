import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectBoardStore } from "../../../src/entrypoints/frontend-bridge/project-boards.js";
import { WebuiProjectError } from "../../../src/entrypoints/frontend-bridge/projects.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ProjectBoardStore", () => {
  it("saves board config beside the project registry and reloads it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-project-board-"));
    roots.push(root);
    const filePath = path.join(root, "webui", "project-boards.json");
    const store = new ProjectBoardStore({ filePath });

    expect(store.get("project-1")).toEqual({
      instruction: "",
      knowledgeBaseIds: [],
      skillIds: [],
      connectorIds: [],
      citations: []
    });

    const saved = store.save("project-1", {
      instruction: "先看事项再改接口",
      knowledgeBaseIds: ["kb-1"],
      skillIds: ["skill-1"],
      connectorIds: [],
      citations: [{ fromSessionKey: "draft:project-1", toSessionKey: "sess-1" }]
    });
    expect(saved.instruction).toBe("先看事项再改接口");
    expect(new ProjectBoardStore({ filePath }).get("project-1")).toEqual(saved);
    expect(() => store.save("project-1", { instruction: "x", extra: true })).toThrow(WebuiProjectError);
  });
});

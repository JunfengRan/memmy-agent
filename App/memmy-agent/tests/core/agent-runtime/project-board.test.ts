import { describe, expect, it } from "vitest";
import { AgentHookContext, SystemPromptBuildContext } from "../../../src/core/agent-runtime/hook.js";
import {
  normalizeProjectRefs,
  ProjectBoardPromptHook,
  projectRefRuntimeLines,
} from "../../../src/core/agent-runtime/project-board.js";

describe("project board prompt", () => {
  it("adds the instruction of the session's project to the system prompt", async () => {
    const seen: Array<{ projectId: string | null; workspace: string | null }> = [];
    const hook = new ProjectBoardPromptHook((input) => {
      seen.push(input);
      return input.projectId === "p-1" ? "  README 用中文。 " : null;
    });
    await hook.beforeBuildSystemPrompt(new AgentHookContext({ sessionKey: "websocket:a", spec: { hostProjectId: "p-1" } }));

    const prompt = new SystemPromptBuildContext({ sessionKey: "websocket:a", workspace: "/repo" });
    hook.onBuildSystemPrompt(prompt);
    expect(prompt.getSection("project-instruction")?.content).toContain("# Project Instruction");
    expect(prompt.getSection("project-instruction")?.content.endsWith("README 用中文。")).toBe(true);

    const other = new SystemPromptBuildContext({ sessionKey: "websocket:b", workspace: "/elsewhere" });
    hook.onBuildSystemPrompt(other);
    expect(other.getSection("project-instruction")).toBeNull();
    expect(seen.at(-1)).toEqual({ projectId: null, workspace: "/elsewhere" });
  });

  it("skips the section when the instruction lookup fails", () => {
    const hook = new ProjectBoardPromptHook(() => {
      throw new Error("registry corrupt");
    });
    const prompt = new SystemPromptBuildContext({ sessionKey: "websocket:a" });
    hook.onBuildSystemPrompt(prompt);
    expect(prompt.sections).toEqual([]);
  });

  it("validates project refs and turns them into runtime-context lines", () => {
    expect(normalizeProjectRefs({ knowledge: [" 产品 文档 ", "产品 文档", 3], skills: [], sessions: ["接入看板"] }))
      .toEqual({ knowledge: ["产品 文档"], skills: [], sessions: ["接入看板"] });
    expect(normalizeProjectRefs({ knowledge: [], skills: [""] })).toBeNull();
    expect(normalizeProjectRefs("text")).toBeNull();
    expect(projectRefRuntimeLines({ metadata: { project_refs: { skills: ["tech-diagram"], sessions: ["接入看板"] } } }))
      .toEqual(["Project skills: tech-diagram", "Cited project sessions: 接入看板"]);
    expect(projectRefRuntimeLines({ metadata: {} })).toEqual([]);
  });
});

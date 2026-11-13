import { describe, expect, it } from "vitest";
import { buildExtractMessages } from "../../../src/service/project-memory/organize/extract.js";
import { stripInjectedContext } from "../../../src/service/project-memory/organize/collect.js";
import {
  stripInjectedMessage,
  stripInjectedText
} from "../../../src/service/project-memory/inject/strip.js";
import type { RawTurnRecord } from "../../../src/service/project-memory/contract/types.js";

describe("stripInjectedText", () => {
  it("strips closed blocks from strings and content-part arrays and leaves unclosed tags", () => {
    const text = stripInjectedText("前文<memos_context>旧</memos_context>后文 <project_index>索引</project_index>");
    expect(text).toEqual({ text: "前文后文", blocks: 2, unclosedBlocks: 0 });

    const parts = stripInjectedText([
      { type: "text", text: "甲<memos_context v=\"1\" kind=\"turn\">一</memos_context>" },
      "乙<project_index>二</project_index>丙",
      { content: " <memos_context v=\"1\" kind=\"tool\">没关" }
    ]);
    expect(parts.blocks).toBe(2);
    expect(parts.unclosedBlocks).toBe(1);
    expect(parts.text).toContain("甲");
    expect(parts.text).toContain("乙丙");
    expect(parts.text).toContain("<memos_context");
    expect(parts.text).not.toContain("</project_index>");
    expect(parts.text).not.toContain("</memos_context>");
    expect(stripInjectedContext("前文<memos_context>旧</memos_context>后文")).toBe("前文后文");
  });

  it("removes complete nested blocks without leaking their outer tail", () => {
    for (const tag of ["memos_context", "project_index"]) {
      const text = `before<${tag}>outer<${tag}>inner</${tag}>old conclusion</${tag}>after`;
      expect(stripInjectedText(text)).toEqual({ text: "beforeafter", blocks: 1, unclosedBlocks: 0 });
      const copied = stripInjectedMessage({ content: text, tool_calls: [{ name: "read", arguments: text }] });
      expect(copied.message.content).toBe("beforeafter");
      expect(copied.message.tool_calls[0]!.arguments).toBe("beforeafter");
    }
    expect(stripInjectedText("before<memos_context>unclosed<project_index>old</project_index>after"))
      .toEqual({ text: "before<memos_context>unclosedafter", blocks: 1, unclosedBlocks: 1 });
    expect(stripInjectedText("<memos_context>outer<project_index>index</project_index>end</memos_context>"))
      .toEqual({ text: "", blocks: 1, unclosedBlocks: 0 });
  });

  it("strips string tool-call arguments and keeps the surrounding message", () => {
    const stripped = stripInjectedMessage({
      role: "assistant",
      content: [{ type: "text", text: "调用前<memos_context>块</memos_context>调用后" }],
      tool_calls: [{
        function: {
          name: "search_project_memory",
          arguments: "{\"query\":\"<memos_context v=\\\"1\\\" kind=\\\"tool\\\">参数</memos_context>\"}"
        }
      }]
    });
    expect(stripped.blocks).toBe(2);
    expect(JSON.stringify(stripped.message)).not.toContain("</memos_context>");
    expect(stripped.message.content).toEqual([{ type: "text", text: "调用前调用后" }]);
    const args = (stripped.message.tool_calls![0]!.function as { arguments: string }).arguments;
    expect(args).toContain("query");
    expect(args).not.toContain("参数");
  });

  it("keeps closed blocks out of the M02 request body", () => {
    const turn: RawTurnRecord = {
      turnId: "turn_1",
      taskId: "task_1",
      conversationId: "c1",
      role: "assistant",
      roleId: "user_a",
      roleName: "用户A",
      chatTime: "2026-10-29 10:00:00",
      chatTimeInferred: false,
      content: "前文<memos_context v=\"1\" kind=\"turn\">旧结论</memos_context><project_index>索引</project_index>后文 <memos_context v=\"1\">没关",
      toolCalls: [{
        name: "search_project_memory",
        arguments: "<memos_context v=\"1\" kind=\"tool\">参数</memos_context>"
      }]
    };
    const body = JSON.stringify(buildExtractMessages({
      instructions: null,
      domains: [],
      requestDomains: [],
      messages: [turn],
      context: []
    }));
    expect(body).not.toContain("</memos_context>");
    expect(body).not.toContain("</project_index>");
    expect(body).not.toContain("<project_index");
    expect(body).toContain("前文");
    expect(body).toContain("后文");
    expect(body).toContain("没关");
    expect(body).not.toContain("参数");
  });
});

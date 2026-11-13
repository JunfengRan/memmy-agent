import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PROJECT_MEMORY_TOOL,
  PROJECT_MEMORY_TOOL_FIELDS,
  PROJECT_MEMORY_TOOL_VERSION,
  bindProjectToolRequest,
  wrapToolResult
} from "../../../src/service/project-memory/inject/tool.js";

describe("project memory tool binding", () => {
  it("exposes only query and domains, and matches the host copy", () => {
    expect(PROJECT_MEMORY_TOOL.version).toBe(PROJECT_MEMORY_TOOL_VERSION);
    expect(PROJECT_MEMORY_TOOL.name).toBe("search_project_memory");
    expect(Object.keys(PROJECT_MEMORY_TOOL.parameters.properties)).toEqual([...PROJECT_MEMORY_TOOL_FIELDS]);
    expect(PROJECT_MEMORY_TOOL.parameters.required).toEqual(["query"]);
    expect(PROJECT_MEMORY_TOOL.parameters.properties).not.toHaveProperty("user_id");
    expect(PROJECT_MEMORY_TOOL.parameters.properties).not.toHaveProperty("space_ids");
    expect(PROJECT_MEMORY_TOOL.parameters.properties).not.toHaveProperty("conversation_id");

    const agentTools = readFileSync(new URL("../../../../App/memmy-agent/src/memmy-memory/tools.ts", import.meta.url), "utf8");
    expect(agentTools).toContain(
      `export const SEARCH_PROJECT_MEMORY_FIELDS = [${PROJECT_MEMORY_TOOL_FIELDS.map((field) => `"${field}"`).join(", ")}] as const;`
    );
    const start = agentTools.indexOf("export const SEARCH_PROJECT_MEMORY_PARAMETERS");
    const parameters = agentTools.slice(start, agentTools.indexOf("\n};", start));
    const names = [...parameters.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]);
    expect(names).toEqual([...PROJECT_MEMORY_TOOL_FIELDS]);
    expect(PROJECT_MEMORY_TOOL_VERSION).toBe("pm-tool-v0.2.0");
  });

  it("overwrites model binding fields and defaults the limit to 3", () => {
    const body = bindProjectToolRequest({
      query: "并发整理怎么处理",
      domains: ["代码开发"],
      user_id: "model-user",
      space_ids: ["model-space"],
      conversation_id: "model-conv",
      include_memory_view: ["user_memory"],
      memory_limit_number: 9,
      recall_via: "turn_start"
    }, {
      userId: "host-user",
      spaceIds: ["space_a", "space_b"],
      conversationId: "conv_host"
    });

    expect(body).toEqual({
      user_id: "host-user",
      space_ids: ["space_a", "space_b"],
      query: "并发整理怎么处理",
      include_memory_view: ["project"],
      memory_limit_number: 3,
      recall_via: "tool",
      conversation_id: "conv_host",
      domains: ["代码开发"]
    });
  });

  it("renders template 3 for a tool result and lists domains inside a DOMAIN_INVALID tag", () => {
    const wrapped = wrapToolResult({
      topic_detail_list: [{ id: "topic_1", topic_name: "重试", topic_summary: "三次" }],
      degraded: ["vector"]
    });
    expect(wrapped.startsWith('<memos_context v="1" kind="tool">')).toBe(true);
    expect(wrapped.endsWith("</memos_context>")).toBe(true);
    expect(wrapped).toContain("重试");
    expect(wrapped).toContain("本次检索有部分召回降级，结果可能不全；需要时换个说法再查一次。");
    expect(wrapped).not.toContain("topic_detail_list");

    const invalid = wrapToolResult({
      code: 40002,
      message: "DOMAIN_INVALID",
      data: { domains: ["运维"], available_domains: ["代码开发", "产品设计"] }
    });
    expect(invalid).toContain('kind="tool"');
    expect(invalid).toContain("未登记的领域：运维");
    expect(invalid).toContain("可用领域：代码开发、产品设计");
    expect(invalid).not.toContain("<memories>");
  });
});

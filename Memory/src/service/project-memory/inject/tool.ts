/**
 * Project-memory tool definition (v3 §3.3.5).
 * The model sees query and domains only. The host binds the rest.
 * Results use template 3 with kind="tool" (inject/render.ts).
 */
import { renderToolResult } from "./render.js";

export const PROJECT_MEMORY_TOOL_VERSION = "pm-tool-v0.2.0";

/** Parameter names exposed to the model. Host copies must keep this list. */
export const PROJECT_MEMORY_TOOL_FIELDS = ["query", "domains"] as const;

export const PROJECT_MEMORY_TOOL = {
  version: PROJECT_MEMORY_TOOL_VERSION,
  name: "search_project_memory",
  description: "检索当前项目的项目记忆：已确定的决策、尚未定论的不一致结论、可复用的经验和产出进展。本轮记忆没有覆盖时调用。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "要查的工作或问题，一句话或几个关键词" },
      domains: {
        type: "array",
        items: { type: "string" },
        description: "可选，只在这些已登记领域中查"
      }
    },
    required: ["query"]
  }
} as const;

export interface ProjectToolBinding {
  userId: string;
  spaceIds: readonly string[];
  conversationId?: string;
  /** Host override. Omitted means 3, the tool default in v3 §3.3.5. */
  memoryLimit?: number;
}

/**
 * Builds a local search/memory body. Model-supplied user_id, space_ids,
 * conversation_id, include_memory_view, memory_limit_number, and recall_via
 * are ignored.
 */
export function bindProjectToolRequest(args: Record<string, unknown>, binding: ProjectToolBinding): Record<string, unknown> {
  const body: Record<string, unknown> = {
    user_id: binding.userId,
    space_ids: [...binding.spaceIds],
    query: typeof args.query === "string" ? args.query : "",
    include_memory_view: ["project"],
    memory_limit_number: binding.memoryLimit ?? 3,
    recall_via: "tool"
  };
  if (binding.conversationId) body.conversation_id = binding.conversationId;
  if (args.domains !== undefined) body.domains = args.domains;
  return body;
}

/** Template 3 with kind="tool". DOMAIN_INVALID lists unregistered and available domains. */
export function wrapToolResult(data: unknown): string {
  return renderToolResult(data);
}

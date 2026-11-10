import { invalidParams } from "../contract/errors.js";
import type { RawTurnInput } from "../contract/types.js";
import { normalizeChatTime, nowWithOffset } from "../time.js";

/**
 * M01: turn cloud-format messages into raw turns. Injected memory blocks are
 * stripped so recalled content is never organized back into the store.
 */
const ROLES = new Set(["user", "assistant", "system", "tool"]);
/** v3 §3.4: drop `<memos_context>` blocks, with or without attributes. */
const INJECTED_BLOCK = /<memos_context\b[^>]*>[\s\S]*?<\/memos_context>/gi;

export interface CollectOptions {
  conversationId: string;
  userId: string;
  timezone: string | null;
  now: Date;
}

function contentText(value: unknown, index: number): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
          if (typeof record.content === "string") return record.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  throw invalidParams(`messages[${index}].content must be a string or an array of parts`, { field: `messages[${index}].content` });
}

function toolCalls(value: unknown): RawTurnInput["toolCalls"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((call) => {
    if (!call || typeof call !== "object") return [];
    const record = call as Record<string, unknown>;
    const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : record;
    const name = typeof fn.name === "string" ? fn.name : null;
    return name ? [{ name, arguments: fn.arguments ?? null }] : [];
  });
}

export function stripInjectedContext(text: string): string {
  return text.replace(INJECTED_BLOCK, "").trim();
}

export function collectTurns(messages: unknown, options: CollectOptions): RawTurnInput[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw invalidParams("messages must be a non-empty array", { field: "messages" });
  }
  const receivedAt = nowWithOffset(options.timezone, options.now);
  const turns: RawTurnInput[] = [];
  messages.forEach((message, index) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw invalidParams(`messages[${index}] must be an object`, { field: `messages[${index}]` });
    }
    const record = message as Record<string, unknown>;
    const role = record.role;
    if (typeof role !== "string" || !ROLES.has(role)) {
      throw invalidParams(`messages[${index}].role must be user, assistant, system or tool`, { field: `messages[${index}].role` });
    }
    let chatTime = receivedAt;
    let inferred = true;
    if (record.chat_time !== undefined && record.chat_time !== null) {
      const normalized = typeof record.chat_time === "string" ? normalizeChatTime(record.chat_time, options.timezone, options.now) : null;
      if (!normalized) throw invalidParams(`messages[${index}].chat_time is not a valid time`, { field: `messages[${index}].chat_time` });
      chatTime = normalized;
      inferred = false;
    }
    const roleId = typeof record.role_id === "string" && record.role_id.trim()
      ? record.role_id.trim()
      : role === "user" ? options.userId : null;
    const roleName = typeof record.role_name === "string" && record.role_name.trim() ? record.role_name.trim() : null;
    const content = stripInjectedContext(contentText(record.content, index));
    const calls = toolCalls(record.tool_calls);
    if (!content && calls.length === 0) return;
    turns.push({
      conversationId: options.conversationId,
      role: role as RawTurnInput["role"],
      roleId,
      roleName,
      chatTime,
      chatTimeInferred: inferred,
      content,
      toolCalls: calls
    });
  });
  if (turns.length === 0) throw invalidParams("messages contain no content", { field: "messages" });
  return turns;
}

/** v3 §2.2.8: the domain a new topic gets, or null to defer with `domain_unresolved`. */
export function resolveNewTopicDomain(requestDomains: string[], spaceDomains: string[]): string | null {
  if (requestDomains.length === 1) return requestDomains[0]!;
  if (requestDomains.length === 0 && spaceDomains.length === 1) return spaceDomains[0]!;
  return null;
}

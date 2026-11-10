/**
 * v3 §3.4 strip_injected. Closed `<memos_context>` and `<project_index>` blocks
 * are removed. Unclosed tags stay in the text (Q-34).
 */

export interface StrippedInjection {
  text: string;
  /** Closed blocks removed. The M02 acceptance counts only these. */
  blocks: number;
  /** Open or stray tags left in `text`. */
  unclosedBlocks: number;
}

const CLOSED_MEMOS = /<memos_context\b[^>]*>[\s\S]*?<\/memos_context>/gi;
const CLOSED_INDEX = /<project_index\b[^>]*>[\s\S]*?<\/project_index>/gi;
const UNCLOSED = /<\/?(?:memos_context|project_index)\b/gi;

function stripTag(text: string, pattern: RegExp): { text: string; blocks: number } {
  pattern.lastIndex = 0;
  let blocks = 0;
  const next = text.replace(pattern, () => {
    blocks += 1;
    return "";
  });
  pattern.lastIndex = 0;
  return { text: next, blocks };
}

function stripClosed(text: string): { text: string; blocks: number } {
  let blocks = 0;
  let current = text;
  for (;;) {
    const memos = stripTag(current, CLOSED_MEMOS);
    const index = stripTag(memos.text, CLOSED_INDEX);
    const removed = memos.blocks + index.blocks;
    if (removed === 0) return { text: current, blocks };
    blocks += removed;
    current = index.text;
  }
}

function partText(part: unknown): string {
  if (typeof part === "string") return part;
  if (part && typeof part === "object") {
    const record = part as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
  }
  return "";
}

/** Strips a string, or joins content-part text/content fields and then strips. */
export function stripInjectedText(value: string | readonly unknown[]): StrippedInjection {
  const raw = typeof value === "string"
    ? value
    : value.map(partText).filter(Boolean).join("\n");
  const closed = stripClosed(raw);
  const text = closed.text.trim();
  const unclosedBlocks = text.match(UNCLOSED)?.length ?? 0;
  return { text, blocks: closed.blocks, unclosedBlocks };
}

/** Backward-compatible text-only strip used by M01 callers and older tests. */
export function stripInjectedContext(text: string): string {
  return stripInjectedText(text).text;
}

export function stripToolArgument(value: unknown): { value: unknown; blocks: number; unclosedBlocks: number } {
  if (typeof value !== "string") return { value, blocks: 0, unclosedBlocks: 0 };
  const stripped = stripInjectedText(value);
  return { value: stripped.text, blocks: stripped.blocks, unclosedBlocks: stripped.unclosedBlocks };
}

function stripContentValue(value: unknown): { value: unknown; blocks: number; unclosedBlocks: number } {
  if (typeof value === "string") {
    const stripped = stripInjectedText(value);
    return { value: stripped.text, blocks: stripped.blocks, unclosedBlocks: stripped.unclosedBlocks };
  }
  if (!Array.isArray(value)) return { value, blocks: 0, unclosedBlocks: 0 };
  let blocks = 0;
  let unclosedBlocks = 0;
  const next = value.map((part) => {
    if (typeof part === "string") {
      const stripped = stripInjectedText(part);
      blocks += stripped.blocks;
      unclosedBlocks += stripped.unclosedBlocks;
      return stripped.text;
    }
    if (!part || typeof part !== "object") return part;
    const record = { ...(part as Record<string, unknown>) };
    for (const key of ["text", "content"] as const) {
      if (typeof record[key] !== "string") continue;
      const stripped = stripInjectedText(record[key] as string);
      blocks += stripped.blocks;
      unclosedBlocks += stripped.unclosedBlocks;
      record[key] = stripped.text;
    }
    return record;
  });
  return { value: next, blocks, unclosedBlocks };
}

function stripToolCallList(value: unknown): { value: unknown; blocks: number; unclosedBlocks: number } {
  if (!Array.isArray(value)) return { value, blocks: 0, unclosedBlocks: 0 };
  let blocks = 0;
  let unclosedBlocks = 0;
  const next = value.map((call) => {
    if (!call || typeof call !== "object") return call;
    const record = { ...(call as Record<string, unknown>) };
    const fn = record.function && typeof record.function === "object"
      ? { ...(record.function as Record<string, unknown>) }
      : null;
    const target = fn ?? record;
    if (typeof target.arguments === "string") {
      const stripped = stripToolArgument(target.arguments);
      blocks += stripped.blocks;
      unclosedBlocks += stripped.unclosedBlocks;
      target.arguments = stripped.value;
    }
    if (fn) record.function = fn;
    return record;
  });
  return { value: next, blocks, unclosedBlocks };
}

/** Copies one add_message message with injected blocks removed from content and string tool arguments. */
export function stripInjectedMessage<T extends { content?: unknown; tool_calls?: unknown }>(message: T): {
  message: T;
  blocks: number;
  unclosedBlocks: number;
} {
  const content = stripContentValue(message.content);
  const calls = stripToolCallList(message.tool_calls);
  return {
    message: {
      ...message,
      ...(message.content !== undefined ? { content: content.value } : {}),
      ...(message.tool_calls !== undefined ? { tool_calls: calls.value } : {})
    },
    blocks: content.blocks + calls.blocks,
    unclosedBlocks: content.unclosedBlocks + calls.unclosedBlocks
  };
}

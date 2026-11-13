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

const UNCLOSED = /<\/?(?:memos_context|project_index)\b/gi;

function stripClosed(text: string): { text: string; blocks: number } {
  // Match balanced spans before removing anything. A non-greedy block regexp
  // stops at an inner closing tag and leaks the rest of a closed outer block.
  const tags = /<(memos_context|project_index)\b[^>]*>|<\/(memos_context|project_index)>/gi;
  const stacks = new Map<string, number[]>();
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(tags)) {
    const name = (match[1] ?? match[2])!.toLowerCase();
    const stack = stacks.get(name) ?? [];
    stacks.set(name, stack);
    if (match[1]) stack.push(match.index);
    else {
      const start = stack.pop();
      if (start !== undefined) spans.push({ start, end: match.index + match[0].length });
    }
  }
  spans.sort((left, right) => left.start - right.start || right.end - left.end);
  const removed: typeof spans = [];
  for (const span of spans) {
    const prior = removed.at(-1);
    if (prior && span.start < prior.end) prior.end = Math.max(prior.end, span.end);
    else removed.push({ ...span });
  }
  let end = 0;
  const kept: string[] = [];
  for (const span of removed) {
    kept.push(text.slice(end, span.start));
    end = span.end;
  }
  kept.push(text.slice(end));
  return { text: kept.join(""), blocks: removed.length };
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

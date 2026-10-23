export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface TodoTurn {
  turnId: string;
  toolCalls: readonly unknown[];
}

export interface CheckpointSpan {
  checkpointKey: string;
  text: string;
  status: "completed" | "cancelled" | "abandoned";
  summary: string;
  segmenter: "checkpoint";
  sourceTraceIds: string[];
  toolCallRanges: Array<{ traceId: string; start: number; end: number }>;
}

const TODO_TOOLS = new Set(["todo_write", "TodoWrite", "update_plan"]);

export function parseTodoItems(call: unknown): TodoItem[] | null {
  if (!call || typeof call !== "object") return null;
  const record = call as Record<string, unknown>;
  if (!TODO_TOOLS.has(String(record.name ?? ""))) return null;
  const input = record.input && typeof record.input === "object" ? record.input as Record<string, unknown> : {};
  const raw = input.todos ?? input.items ?? input.plan;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const text = String(row.content ?? row.text ?? row.step ?? "").trim();
    const status = normalizeStatus(row.status);
    if (!text || !status) return [];
    const id = String(row.id ?? row.step_id ?? hashText(text));
    return [{ id, text, status }];
  });
}

export function turnDefinesCheckpoint(toolCalls: readonly unknown[]): boolean {
  for (const call of toolCalls) {
    const items = parseTodoItems(call);
    if (!items?.some((item) => item.status === "in_progress" || item.status === "completed" || item.status === "cancelled")) {
      continue;
    }
    return true;
  }
  return false;
}

export function checkpointsFromHistory(turns: readonly TodoTurn[], sessionClosed = false): CheckpointSpan[] {
  const open = new Map<string, { text: string; turnId: string; index: number }>();
  const spans: CheckpointSpan[] = [];
  for (const turn of turns) {
    turn.toolCalls.forEach((call, toolIndex) => {
      const items = parseTodoItems(call);
      if (!items) return;
      for (const item of items) {
        if (item.status === "in_progress" && !open.has(item.id)) {
          open.set(item.id, { text: item.text, turnId: turn.turnId, index: toolIndex });
        }
        if ((item.status === "completed" || item.status === "cancelled") && open.has(item.id)) {
          const started = open.get(item.id)!;
          open.delete(item.id);
          spans.push(spanFor(item.id, item.text, item.status, started, turn.turnId, toolIndex, turns));
        }
      }
    });
  }
  if (sessionClosed) {
    const last = turns[turns.length - 1];
    for (const [id, started] of open) {
      const endTurnId = last?.turnId ?? started.turnId;
      const endIndex = last ? Math.max(started.turnId === last.turnId ? started.index : 0, last.toolCalls.length - 1) : started.index;
      spans.push(spanFor(id, started.text, "abandoned", started, endTurnId, endIndex, turns));
    }
  }
  return spans;
}

function spanFor(
  id: string,
  text: string,
  status: CheckpointSpan["status"],
  started: { turnId: string; index: number },
  endTurnId: string,
  endIndex: number,
  turns: readonly TodoTurn[]
): CheckpointSpan {
  const sourceTraceIds: string[] = [];
  const toolCallRanges: CheckpointSpan["toolCallRanges"] = [];
  let seen = false;
  for (const turn of turns) {
    if (turn.turnId === started.turnId) seen = true;
    if (!seen) continue;
    sourceTraceIds.push(turn.turnId);
    const start = turn.turnId === started.turnId ? started.index : 0;
    const end = turn.turnId === endTurnId ? endIndex : Math.max(0, turn.toolCalls.length - 1);
    toolCallRanges.push({ traceId: turn.turnId, start, end });
    if (turn.turnId === endTurnId) break;
  }
  return {
    checkpointKey: id,
    text,
    status,
    summary: checkpointSummary(text, stepsBetween(turns, started, endTurnId, endIndex)),
    segmenter: "checkpoint",
    sourceTraceIds,
    toolCallRanges
  };
}

function stepsBetween(
  turns: readonly TodoTurn[],
  started: { turnId: string; index: number },
  endTurnId: string,
  endIndex: number
): string[] {
  const steps: string[] = [];
  let seen = false;
  for (const turn of turns) {
    if (turn.turnId === started.turnId) seen = true;
    if (!seen) continue;
    turn.toolCalls.forEach((call, index) => {
      const afterStart = turn.turnId !== started.turnId || index > started.index;
      const beforeEnd = turn.turnId !== endTurnId || index < endIndex;
      if (!afterStart || !beforeEnd) return;
      const step = normalizedStep(call);
      if (step) steps.push(step);
    });
    if (turn.turnId === endTurnId) break;
  }
  return steps;
}

function checkpointSummary(text: string, steps: readonly string[]): string {
  return [text, ...steps].filter(Boolean).join("\n");
}

function normalizedStep(call: unknown): string | null {
  if (!call || typeof call !== "object") return null;
  const record = call as Record<string, unknown>;
  const name = String(record.name ?? "").trim();
  if (!name || TODO_TOOLS.has(name)) return null;
  const input = record.input && typeof record.input === "object" ? record.input as Record<string, unknown> : {};
  const path = String(input.file_path ?? input.path ?? input.filePath ?? "").trim();
  return path ? `${name} ${path}` : name;
}

function normalizeStatus(value: unknown): TodoItem["status"] | null {
  const status = String(value ?? "").toLowerCase();
  if (status === "in_progress" || status === "in-progress") return "in_progress";
  if (status === "completed" || status === "done") return "completed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "pending" || status === "todo") return "pending";
  return null;
}

function hashText(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(16);
}

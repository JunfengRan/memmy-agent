import { createHash } from "node:crypto";
import type { RawTurnRecord } from "../contract/types.js";
import type { DeferredSegmentInput } from "../organize/extract.js";
import type { AssignResult, DeferredSegment, ExtractResult } from "../organize/organizer.js";
import type { OpBasis } from "../merge/merge.js";
import type { PendingDeferred, ProjectPipelineState, TaskDetails } from "../store/state.js";
import { timeMs } from "../time.js";

export function batchHash(turns: RawTurnRecord[]): string {
  const hash = createHash("sha256");
  for (const turn of turns) hash.update(`${turn.role}\u0000${turn.chatTime}\u0000${turn.content}\u0001`);
  return hash.digest("hex").slice(0, 24);
}

interface BackfillInput {
  turns: RawTurnRecord[];
  segments: DeferredSegmentInput[];
  ids: number[];
}

export const EMPTY_BACKFILL: BackfillInput = { turns: [], segments: [], ids: [] };

/** Original turns of the producing tasks, deduped, with each segment pointing at that task's didx list. */
export function loadBackfill(local: ProjectPipelineState, rows: PendingDeferred[]): BackfillInput {
  const turns: RawTurnRecord[] = [];
  const turnIndex = new Map<string, number>();
  const taskDidx = new Map<string, number[]>();
  const segments: DeferredSegmentInput[] = [];
  for (const row of rows) {
    let didx = taskDidx.get(row.taskId);
    if (!didx) {
      didx = [];
      for (const turn of local.taskTurns(row.taskId)) {
        if (turn.role !== "user" && turn.role !== "assistant") continue;
        let index = turnIndex.get(turn.turnId);
        if (index === undefined) {
          index = turns.length;
          turns.push(turn);
          turnIndex.set(turn.turnId, index);
        }
        didx.push(index);
      }
      taskDidx.set(row.taskId, didx);
    }
    segments.push({ id: row.id, ref: `df${row.id}`, text: row.text, reason: row.reason, didx: [...didx] });
  }
  return { turns, segments, ids: rows.map((row) => row.id) };
}

/**
 * consumed deletes the row. kept leaves the same id. appended inserts only segments
 * this batch newly produced, including a topic_unavailable replacement.
 * A pending id the model neither claimed nor echoed is an explicit drop.
 */
export function planSettlement(
  pendingIds: readonly number[],
  deferred: readonly DeferredSegment[],
  resolvedBackfill: readonly number[]
): { consumed: number[]; kept: number[]; appended: Array<{ text: string; reason: string }> } {
  const pending = new Set(pendingIds);
  const consumed = new Set<number>();
  const kept = new Set<number>();
  const appended: Array<{ text: string; reason: string }> = [];
  for (const id of resolvedBackfill) {
    if (pending.has(id)) consumed.add(id);
  }
  for (const item of deferred) {
    if (item.backfillOf != null && pending.has(item.backfillOf)) {
      if (consumed.has(item.backfillOf)) continue;
      if (item.reason === "topic_unavailable") {
        consumed.add(item.backfillOf);
        appended.push({ text: item.text, reason: item.reason });
      } else {
        kept.add(item.backfillOf);
      }
      continue;
    }
    if (item.backfillOf == null) appended.push({ text: item.text, reason: item.reason });
  }
  for (const id of pendingIds) {
    if (!consumed.has(id) && !kept.has(id)) consumed.add(id);
  }
  for (const id of consumed) kept.delete(id);
  const ordered = (ids: Set<number>) => [...ids].sort((left, right) => left - right);
  return { consumed: ordered(consumed), kept: ordered(kept), appended };
}

export function taskDetails(
  extracted: ExtractResult,
  assigned: AssignResult | null,
  degraded: string[],
  opBases: OpBasis[],
  mergeDropped: Array<{ reason: string; text: string | null }> = [],
  injection: { strippedBlocks?: number; unclosedBlocks?: number } = {}
): TaskDetails {
  return {
    assignments: (assigned?.assignments ?? []).map((item) => ({ draftId: item.draftId, basis: item.basis })),
    dropped: [...extracted.dropped, ...mergeDropped],
    degraded,
    ops: opBases.map((basis) => ({ basis })),
    strippedBlocks: injection.strippedBlocks ?? 0,
    unclosedBlocks: injection.unclosedBlocks ?? 0
  };
}

export function chronological(turns: RawTurnRecord[]): RawTurnRecord[] {
  return [...turns].sort((left, right) => timeMs(left.chatTime) - timeMs(right.chatTime)
    || (left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0));
}


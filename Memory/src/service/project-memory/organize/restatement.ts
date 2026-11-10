import { clampText, normalizeForCompare, textTokens, tokenOverlap } from "../text.js";

/**
 * Pure restatement check for M02 (v3 §2.2.5, §3.4). No model calls.
 * The organize job calls this once, after extract, with the full recalled
 * texts. The model sees only the clamped copy.
 *
 * Source role is `draft.role`. `unknown` is a backfill placeholder with no
 * source message, so only an exact normalized match can drop it. `turns` is
 * part of the call shape the job passes; this function does not read it.
 * A `restates` ref that is not in the recalled list does not drop the draft.
 */
const OVERLAP_THRESHOLD = 0.5;

export const RESTATEMENT_RECALL_LIMIT = 40;
export const RESTATEMENT_TEXT_LIMIT = 200;

export interface RestatementDraft {
  content: string;
  role: "user" | "assistant" | "unknown";
  signals?: Array<{ type: string }>;
  restates?: string | null;
}

export interface RestatementTurn {
  role: string;
}

export interface RecalledEntry {
  ref: string;
  text: string;
}

export interface DroppedRestatement {
  content: string;
  reason: "restatement";
}

export interface RestatementFilterResult<T extends RestatementDraft> {
  kept: T[];
  dropped: DroppedRestatement[];
}

/** Keep at most 40 recalled entries and 200 characters of each text. */
export function clampRecalled(recalled: readonly RecalledEntry[]): RecalledEntry[] {
  return recalled.slice(0, RESTATEMENT_RECALL_LIMIT).map((entry) => ({
    ref: entry.ref,
    text: clampText(entry.text, RESTATEMENT_TEXT_LIMIT)
  }));
}

function hasApprovalOrResolve(draft: RestatementDraft): boolean {
  return (draft.signals ?? []).some((signal) => signal.type === "approval" || signal.type === "resolve");
}

function matchesRecalledText(content: string, recalled: readonly RecalledEntry[]): boolean {
  const normalized = normalizeForCompare(content);
  return recalled.some((entry) => normalizeForCompare(entry.text) === normalized);
}

/** Share of the draft's tokens that appear in one recalled entry with the same ref. */
function restatesWithOverlap(draft: RestatementDraft, recalled: readonly RecalledEntry[]): boolean {
  const ref = draft.restates;
  if (typeof ref !== "string" || ref.length === 0) return false;
  const query = textTokens(draft.content);
  return recalled.some((entry) => entry.ref === ref && tokenOverlap(query, entry.text) >= OVERLAP_THRESHOLD);
}

function dropsAsRestatement(draft: RestatementDraft, recalled: readonly RecalledEntry[]): boolean {
  if (hasApprovalOrResolve(draft) || draft.role === "user") return false;
  const exact = matchesRecalledText(draft.content, recalled);
  if (draft.role === "unknown") return exact;
  return draft.role === "assistant" && (exact || restatesWithOverlap(draft, recalled));
}

export function filterRestatements<T extends RestatementDraft>(
  drafts: readonly T[],
  turns: readonly RestatementTurn[],
  recalled: readonly RecalledEntry[]
): RestatementFilterResult<T> {
  void turns;
  if (recalled.length === 0) return { kept: [...drafts], dropped: [] };
  const kept: T[] = [];
  const dropped: DroppedRestatement[] = [];
  for (const draft of drafts) {
    if (dropsAsRestatement(draft, recalled)) dropped.push({ content: draft.content, reason: "restatement" });
    else kept.push(draft);
  }
  return { kept, dropped };
}

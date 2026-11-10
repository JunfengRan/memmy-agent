import type { LlmClient } from "../../../model/types.js";
import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { DecisionTarget, RawTurnRecord } from "../contract/types.js";

export type DraftTarget = { topicId: string } | { newTopicRef: string };

interface DraftBase {
  draftId: string;
  content: string;
  time: string;
  userIds: string[];
  messageIdx: number;
  target: DraftTarget;
  /** Pending pm_deferred_segments id this draft resolves. Absent for this batch's own turns. */
  backfillOf?: number;
}

export interface DecisionDraft extends DraftBase {
  kind: "decision";
  reason: string | null;
  sameQuestionAs: string | null;
  sameAs: DecisionTarget | null;
  approvedBy: string[];
  resolve: { pick: DecisionTarget | "new" } | null;
}

export interface ExperienceDraft extends DraftBase {
  kind: "experience";
  reason: string | null;
  sameExperienceAs: string | null;
  change: "same" | "new_version" | null;
}

export interface TimelineDraft extends DraftBase {
  kind: "timeline";
}

export type Draft = DecisionDraft | ExperienceDraft | TimelineDraft;

export interface NewTopicDraft {
  topicName: string;
  topicSummary: string;
  topicDescription: string;
}

/** A segment held back from this batch. `backfillOf` marks an existing row that must not be inserted again. */
export interface DeferredSegment {
  text: string;
  reason: string;
  backfillOf?: number;
}

export function deferredSegment(text: string, reason: string, backfillOf?: number): DeferredSegment {
  return backfillOf == null ? { text, reason } : { text, reason, backfillOf };
}

export interface OrganizeResult {
  promptVersion: string;
  drafts: Draft[];
  newTopics: Map<string, NewTopicDraft>;
  topicUpdates: Map<string, { topicSummary?: string; topicDescription?: string }>;
  informedDecisionIds: Set<string>;
  deferred: DeferredSegment[];
}

export type DraftSignal =
  | { type: "approval"; by: string }
  | { type: "informed"; decision: string }
  | { type: "resolve"; pick: string; by: string };

export interface ExtractedDraft {
  draftId: string;
  kind: "decision" | "experience" | "timeline";
  category: string | null;
  content: string;
  messageIdx: number;
  time: string;
  userIds: string[];
  reason: string | null;
  signals: DraftSignal[];
  backfillOf?: number;
}

export interface ExtractResult {
  promptVersion: string;
  drafts: ExtractedDraft[];
  stateHints: Array<{ type: string; content: string }>;
  dropped: Array<{ reason: string; text: string | null }>;
  deferred: DeferredSegment[];
}

export interface AssignmentBasis {
  independentDelivery: boolean;
  affectsExistingDecisions: boolean;
}

export interface Assignment {
  draftId: string;
  target: DraftTarget | { defer: true };
  basis: AssignmentBasis;
}

export interface AssignResult {
  promptVersion: string;
  assignments: Assignment[];
  newTopics: Map<string, NewTopicDraft>;
  deferred: DeferredSegment[];
}

export interface JudgeLabel {
  draftId: string;
  sameQuestionAs: string | null;
  sameAs: DecisionTarget | null;
  approvedBy: string[];
  resolve: { pick: DecisionTarget | "new" } | null;
  sameExperienceAs: string | null;
  change: "same" | "new_version" | null;
}

export interface JudgeResult {
  promptVersion: string;
  labels: Map<string, JudgeLabel>;
  topicUpdates: OrganizeResult["topicUpdates"];
  informedDecisionIds: Set<string>;
}

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
    : [];
}

export function participantsOf(turns: RawTurnRecord[]): Array<{ user_id: string; name: string | null }> {
  const seen = new Map<string, string | null>();
  for (const turn of turns) {
    if (turn.role !== "user" || !turn.roleId) continue;
    if (!seen.has(turn.roleId)) seen.set(turn.roleId, turn.roleName);
  }
  return [...seen].map(([user_id, name]) => ({ user_id, name }));
}

/**
 * Authors come from the transcript, never from an unchecked model claim: a user
 * message is authored by its speaker, and Agent output by the members who
 * delegated it in this batch.
 */
export function draftAuthors(
  message: RawTurnRecord,
  messageIdx: number,
  claimed: string[],
  messages: RawTurnRecord[],
  batchSpeakers: Set<string>,
  fallbackUser: string | null
): string[] {
  if (message.role === "user" && message.roleId) return [message.roleId];
  const delegators = claimed.filter((id) => batchSpeakers.has(id));
  if (delegators.length > 0) return [...new Set(delegators)];
  for (let idx = messageIdx - 1; idx >= 0; idx -= 1) {
    const earlier = messages[idx]!;
    if (earlier.role === "user" && earlier.roleId) return [earlier.roleId];
  }
  return fallbackUser ? [fallbackUser] : [];
}

export function isPlacedTarget(target: Assignment["target"]): target is DraftTarget {
  return "topicId" in target || "newTopicRef" in target;
}

/** One model call per attempt; malformed output is retried, then the task fails. */
export async function completeStage<T>(
  llm: LlmClient,
  messages: Array<{ role: "system" | "user"; content: string }>,
  operation: string,
  parse: (raw: Json) => T
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROJECT_MEMORY_LIMITS.modelAttempts; attempt += 1) {
    try {
      const raw = await llm.completeJson<Json>(messages, {
        operation,
        jsonMode: true,
        temperature: 0,
        thinkingMode: "disabled",
        maxTokens: 4000
      });
      return parse(raw);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Folds extraction, assignment and the optional judge labels into the draft
 * list deterministic merge already understands.
 */
export function assembleOrganizeResult(
  extracted: ExtractResult,
  assigned: AssignResult,
  judged: JudgeResult | null
): OrganizeResult {
  const assignments = new Map(assigned.assignments.map((item) => [item.draftId, item]));
  const deferred = [...extracted.deferred, ...assigned.deferred];
  const drafts: Draft[] = [];
  for (const draft of extracted.drafts) {
    const assignment = assignments.get(draft.draftId);
    if (!assignment || !isPlacedTarget(assignment.target)) {
      if (!assignment) deferred.push(deferredSegment(draft.content, "ambiguous_topic", draft.backfillOf));
      continue;
    }
    const label = assignment.target && "topicId" in assignment.target ? judged?.labels.get(draft.draftId) : undefined;
    const base = {
      draftId: draft.draftId,
      content: draft.content,
      time: draft.time,
      userIds: draft.userIds,
      messageIdx: draft.messageIdx,
      target: assignment.target,
      ...(draft.backfillOf == null ? {} : { backfillOf: draft.backfillOf })
    };
    if (draft.kind === "decision") {
      drafts.push({
        ...base,
        kind: "decision",
        reason: draft.reason,
        sameQuestionAs: label?.sameQuestionAs ?? null,
        sameAs: label?.sameAs ?? null,
        approvedBy: label?.approvedBy ?? [],
        resolve: label?.resolve ?? null
      });
    } else if (draft.kind === "experience") {
      drafts.push({
        ...base,
        kind: "experience",
        reason: draft.reason,
        sameExperienceAs: label?.sameExperienceAs ?? null,
        change: label?.change ?? null
      });
    } else {
      drafts.push({ ...base, kind: "timeline" });
    }
  }
  const versions = [extracted.promptVersion, assigned.promptVersion];
  if (judged) versions.push(judged.promptVersion);
  return {
    promptVersion: versions.join("+"),
    drafts,
    newTopics: assigned.newTopics,
    topicUpdates: judged?.topicUpdates ?? new Map(),
    informedDecisionIds: judged?.informedDecisionIds ?? new Set(),
    deferred
  };
}

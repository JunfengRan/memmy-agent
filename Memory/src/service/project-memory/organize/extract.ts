import type { LlmClient } from "../../../model/types.js";
import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { DomainRecord, RawTurnRecord } from "../contract/types.js";
import { EXTRACT_PROMPT_VERSION, EXTRACT_SYSTEM_PROMPT } from "../prompts/extract.js";
import { clampText } from "../text.js";
import {
  type DeferredSegment,
  type DraftSignal,
  type ExtractedDraft,
  type ExtractResult,
  type Json,
  ModelOutputError,
  asRecord,
  asString,
  asStringArray,
  completeStage,
  deferredSegment,
  draftAuthors,
  participantsOf
} from "./organizer.js";

/** One pending row fed back into M02. `didx` indexes `ExtractInput.deferredTurns`. */
export interface DeferredSegmentInput {
  id: number;
  ref: string;
  text: string;
  reason: string;
  didx: number[];
}

export interface ExtractInput {
  instructions: string | null;
  domains: DomainRecord[];
  requestDomains: string[];
  messages: RawTurnRecord[];
  context: RawTurnRecord[];
  /** Original turns of the tasks that produced the pending rows, indexed by didx. */
  deferredTurns?: RawTurnRecord[];
  deferredSegments?: DeferredSegmentInput[];
}

const DECISION_CATEGORIES = new Set(["范围", "对外约定", "共同约定"]);
const HINT_TYPES = new Set(["plan", "progress", "scope"]);
const DROP_REASONS = new Set([
  "local_implementation",
  "execution_step",
  "unadopted_proposal",
  "unresolved",
  "restatement",
  "process_material",
  "unrelated"
]);

const KIND_LIMIT = {
  decision: PROJECT_MEMORY_LIMITS.decision,
  experience: PROJECT_MEMORY_LIMITS.experience,
  timeline: PROJECT_MEMORY_LIMITS.timeline
} as const;

function turnView(turn: RawTurnRecord, idx?: number, key: "idx" | "didx" = "idx") {
  return {
    ...(idx === undefined ? {} : { [key]: idx }),
    role: turn.role,
    user_id: turn.roleId,
    name: turn.roleName,
    time: turn.chatTime,
    content: turn.content
  };
}

export function buildExtractMessages(input: ExtractInput): Array<{ role: "system" | "user"; content: string }> {
  const deferredTurns = input.deferredTurns ?? [];
  const deferredSegments = input.deferredSegments ?? [];
  const payload = {
    space: { instructions: input.instructions, domains: input.domains },
    request_domains: input.requestDomains,
    participants: participantsOf([...input.context, ...input.messages, ...deferredTurns]),
    context_turns: input.context.map((turn) => turnView(turn)),
    messages: input.messages.map((turn, idx) => turnView(turn, idx)),
    ...(deferredSegments.length === 0 ? {} : {
      deferred_turns: deferredTurns.map((turn, didx) => turnView(turn, didx, "didx")),
      deferred_segments: deferredSegments.map((segment) => ({
        ref: segment.ref,
        text: segment.text,
        reason: segment.reason,
        didx: segment.didx
      }))
    })
  };
  return [
    { role: "system", content: EXTRACT_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) }
  ];
}

function acceptDropReason(reason: string): boolean {
  if (DROP_REASONS.has(reason)) return true;
  const parts = reason.split("+").filter(Boolean);
  return parts.length > 1 && parts.every((part) => DROP_REASONS.has(part) || part === "background_knowledge");
}

function parseSignals(value: unknown): DraftSignal[] {
  if (!Array.isArray(value)) return [];
  const signals: DraftSignal[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    if (record.type === "approval") {
      const by = asString(record.by);
      if (by) signals.push({ type: "approval", by });
    } else if (record.type === "informed") {
      const decision = asString(record.decision);
      if (decision) signals.push({ type: "informed", decision });
    } else if (record.type === "resolve") {
      const pick = asString(record.pick);
      const by = asString(record.by);
      if (pick && by) signals.push({ type: "resolve", pick, by });
    }
  }
  return signals;
}

function integerIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Validates extraction output. Authors are taken from the transcript, not the model.
 * A draft may claim a pending segment with deferred_ref + deferred_idx instead of message_idx.
 */
export function parseExtractOutput(raw: Json, input: ExtractInput): ExtractResult {
  if (!Array.isArray(raw.drafts)) throw new ModelOutputError("drafts must be an array");
  const deferredTurns = input.deferredTurns ?? [];
  const deferredSegments = input.deferredSegments ?? [];
  const byRef = new Map(deferredSegments.map((segment) => [segment.ref, segment]));
  const participants = new Set(participantsOf([...input.context, ...input.messages, ...deferredTurns]).map((item) => item.user_id));
  const batchSpeakers = new Set(participantsOf(input.messages).map((item) => item.user_id));
  const fallbackUser = participantsOf(input.messages)[0]?.user_id ?? [...participants][0] ?? null;
  const deferredSpeakers = new Set(participantsOf(deferredTurns).map((item) => item.user_id));
  const deferredFallback = participantsOf(deferredTurns)[0]?.user_id ?? fallbackUser;
  const seen = new Set<string>();
  const occupied = new Set<number>();
  const echoed = new Set<number>();
  const rejected = new Set<number>();
  const drafts: ExtractedDraft[] = [];
  const deferred: DeferredSegment[] = [];

  for (const item of Array.isArray(raw.deferred) ? raw.deferred : []) {
    const record = asRecord(item);
    if (!record) continue;
    const ref = asString(record.ref);
    if (ref) {
      const segment = byRef.get(ref);
      if (segment) echoed.add(segment.id);
      continue;
    }
    const text = asString(record.text);
    if (text) deferred.push(deferredSegment(text, asString(record.reason) ?? "work_unresolved"));
  }

  raw.drafts.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) return;
    const kind = record.kind;
    if (kind !== "decision" && kind !== "experience" && kind !== "timeline") return;
    const content = asString(record.content);
    if (!content) return;
    const draftId = asString(record.draft_id) ?? `d${index}`;
    if (seen.has(draftId)) return;
    const ref = asString(record.deferred_ref);
    if (ref) {
      const segment = byRef.get(ref);
      if (!segment || echoed.has(segment.id) || occupied.has(segment.id)) return;
      occupied.add(segment.id);
      seen.add(draftId);
      const deferredIdx = integerIndex(record.deferred_idx);
      const turn = deferredIdx === null ? undefined : deferredTurns[deferredIdx];
      if (deferredIdx === null || !segment.didx.includes(deferredIdx) || !turn) {
        rejected.add(segment.id);
        return;
      }
      const userIds = draftAuthors(turn, deferredIdx, asStringArray(record.user_ids), deferredTurns, deferredSpeakers, deferredFallback);
      if (userIds.length === 0) {
        rejected.add(segment.id);
        return;
      }
      const category = kind === "decision" && DECISION_CATEGORIES.has(String(record.category)) ? String(record.category) : null;
      drafts.push({
        draftId,
        kind,
        category,
        content: clampText(content, KIND_LIMIT[kind]),
        messageIdx: deferredIdx,
        time: turn.chatTime,
        userIds,
        reason: asString(record.reason),
        signals: parseSignals(record.signals),
        backfillOf: segment.id
      });
      return;
    }
    const messageIdx = Number(record.message_idx);
    const message = Number.isInteger(messageIdx) ? input.messages[messageIdx] : undefined;
    if (!message) return;
    seen.add(draftId);
    const userIds = draftAuthors(message, messageIdx, asStringArray(record.user_ids), input.messages, batchSpeakers, fallbackUser);
    if (userIds.length === 0) return;
    const category = kind === "decision" && DECISION_CATEGORIES.has(String(record.category)) ? String(record.category) : null;
    drafts.push({
      draftId,
      kind,
      category,
      content: clampText(content, KIND_LIMIT[kind]),
      messageIdx,
      time: message.chatTime,
      userIds,
      reason: asString(record.reason),
      signals: parseSignals(record.signals)
    });
  });

  for (const segment of deferredSegments) {
    if (!echoed.has(segment.id) && !rejected.has(segment.id)) continue;
    if (drafts.some((draft) => draft.backfillOf === segment.id)) continue;
    deferred.push(deferredSegment(segment.text, segment.reason, segment.id));
  }

  const stateHints: ExtractResult["stateHints"] = [];
  for (const item of Array.isArray(raw.state_hints) ? raw.state_hints : []) {
    const record = asRecord(item);
    const type = asString(record?.type);
    const content = asString(record?.content);
    if (record && type && HINT_TYPES.has(type) && content) stateHints.push({ type, content });
  }

  const dropped: ExtractResult["dropped"] = [];
  for (const item of Array.isArray(raw.dropped) ? raw.dropped : []) {
    const record = asRecord(item);
    const reason = asString(record?.reason);
    if (!record || !reason || !acceptDropReason(reason)) continue;
    dropped.push({ reason, text: asString(record.text) });
  }

  return { promptVersion: EXTRACT_PROMPT_VERSION, drafts, stateHints, dropped, deferred };
}

export function extractBatch(llm: LlmClient, input: ExtractInput): Promise<ExtractResult> {
  return completeStage(llm, buildExtractMessages(input), "project_memory.extract", (raw) => parseExtractOutput(raw, input));
}

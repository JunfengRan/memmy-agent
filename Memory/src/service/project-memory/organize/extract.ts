import type { LlmClient } from "../../../model/types.js";
import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { DomainRecord, RawTurnRecord } from "../contract/types.js";
import { EXTRACT_PROMPT_VERSION, EXTRACT_SYSTEM_PROMPT } from "../prompts/extract.js";
import { clampText } from "../text.js";
import {
  type DraftSignal,
  type ExtractedDraft,
  type ExtractResult,
  type Json,
  ModelOutputError,
  asRecord,
  asString,
  asStringArray,
  completeStage,
  draftAuthors,
  participantsOf
} from "./organizer.js";

export interface ExtractInput {
  instructions: string | null;
  domains: DomainRecord[];
  requestDomains: string[];
  messages: RawTurnRecord[];
  context: RawTurnRecord[];
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

function turnView(turn: RawTurnRecord, idx?: number) {
  return {
    ...(idx === undefined ? {} : { idx }),
    role: turn.role,
    user_id: turn.roleId,
    name: turn.roleName,
    time: turn.chatTime,
    content: turn.content
  };
}

export function buildExtractMessages(input: ExtractInput): Array<{ role: "system" | "user"; content: string }> {
  const payload = {
    space: { instructions: input.instructions, domains: input.domains },
    request_domains: input.requestDomains,
    participants: participantsOf([...input.context, ...input.messages]),
    context_turns: input.context.map((turn) => turnView(turn)),
    messages: input.messages.map((turn, idx) => turnView(turn, idx))
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

/** Validates extraction output. Authors are taken from the transcript, not the model. */
export function parseExtractOutput(raw: Json, input: ExtractInput): ExtractResult {
  if (!Array.isArray(raw.drafts)) throw new ModelOutputError("drafts must be an array");
  const participants = new Set(participantsOf([...input.context, ...input.messages]).map((item) => item.user_id));
  const batchSpeakers = new Set(participantsOf(input.messages).map((item) => item.user_id));
  const fallbackUser = participantsOf(input.messages)[0]?.user_id ?? [...participants][0] ?? null;
  const seen = new Set<string>();
  const drafts: ExtractedDraft[] = [];

  raw.drafts.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) return;
    const kind = record.kind;
    if (kind !== "decision" && kind !== "experience" && kind !== "timeline") return;
    const content = asString(record.content);
    const messageIdx = Number(record.message_idx);
    const message = Number.isInteger(messageIdx) ? input.messages[messageIdx] : undefined;
    if (!content || !message) return;
    const draftId = asString(record.draft_id) ?? `d${index}`;
    if (seen.has(draftId)) return;
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

  const deferred: ExtractResult["deferred"] = [];
  for (const item of Array.isArray(raw.deferred) ? raw.deferred : []) {
    const record = asRecord(item);
    const text = asString(record?.text);
    if (text) deferred.push({ text, reason: asString(record?.reason) ?? "work_unresolved" });
  }

  return { promptVersion: EXTRACT_PROMPT_VERSION, drafts, stateHints, dropped, deferred };
}

export function extractBatch(llm: LlmClient, input: ExtractInput): Promise<ExtractResult> {
  return completeStage(llm, buildExtractMessages(input), "project_memory.extract", (raw) => parseExtractOutput(raw, input));
}

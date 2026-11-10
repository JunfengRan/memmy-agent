import type { LlmClient } from "../../../model/types.js";
import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { DomainRecord } from "../contract/types.js";
import { ASSIGN_PROMPT_VERSION, ASSIGN_SYSTEM_PROMPT } from "../prompts/assign.js";
import { clampText } from "../text.js";
import type { MergeCandidate } from "./candidates.js";
import {
  type Assignment,
  type AssignmentBasis,
  type AssignResult,
  type ExtractedDraft,
  type ExtractResult,
  type Json,
  type NewTopicDraft,
  ModelOutputError,
  asRecord,
  asString,
  completeStage,
  deferredSegment
} from "./organizer.js";

export interface AssignInput {
  instructions: string | null;
  domains: DomainRecord[];
  requestDomains: string[];
  drafts: ExtractedDraft[];
  stateHints: ExtractResult["stateHints"];
  candidates: MergeCandidate[];
  degraded: string[];
}

function parseBasis(value: unknown): AssignmentBasis {
  const record = asRecord(value);
  return {
    independentDelivery: record?.independent_delivery === true,
    affectsExistingDecisions: record?.affects_existing_decisions === true
  };
}

export function buildAssignMessages(input: AssignInput): Array<{ role: "system" | "user"; content: string }> {
  const payload = {
    space: { instructions: input.instructions, domains: input.domains },
    request_domains: input.requestDomains,
    drafts: input.drafts.map((draft) => ({
      draft_id: draft.draftId,
      kind: draft.kind,
      category: draft.category,
      content: draft.content,
      reason: draft.reason,
      message_idx: draft.messageIdx
    })),
    state_hints: input.stateHints,
    degraded: input.degraded,
    candidates: input.candidates.map((topic) => ({
      topic_id: topic.topicId,
      domain: topic.domain,
      topic_summary: topic.topicSummary,
      topic_description: topic.topicDescription
    }))
  };
  return [
    { role: "system", content: ASSIGN_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) }
  ];
}

/**
 * Unknown topic ids are deferred, never turned into a new topic (v3 §2.2.7).
 * Candidates carry summary and description only; names are not sent.
 */
export function parseAssignOutput(raw: Json, input: AssignInput): AssignResult {
  if (!Array.isArray(raw.assignments)) throw new ModelOutputError("assignments must be an array");
  const drafts = new Map(input.drafts.map((draft) => [draft.draftId, draft]));
  const candidates = new Set(input.candidates.map((topic) => topic.topicId));
  const newTopics = new Map<string, NewTopicDraft>();
  for (const item of Array.isArray(raw.new_topics) ? raw.new_topics : []) {
    const record = asRecord(item);
    const ref = asString(record?.ref);
    const summary = asString(record?.topic_summary) ?? "";
    const name = asString(record?.topic_name) ?? summary;
    if (!record || !ref || !name) continue;
    newTopics.set(ref, {
      topicName: clampText(name, PROJECT_MEMORY_LIMITS.topicName),
      topicSummary: clampText(summary, PROJECT_MEMORY_LIMITS.topicSummary),
      topicDescription: clampText(asString(record.topic_description) ?? "", PROJECT_MEMORY_LIMITS.topicDescription)
    });
  }

  const deferred: AssignResult["deferred"] = [];
  for (const item of Array.isArray(raw.deferred) ? raw.deferred : []) {
    const record = asRecord(item);
    const text = asString(record?.text);
    if (text) deferred.push(deferredSegment(text, asString(record?.reason) ?? "work_unresolved"));
  }

  const seen = new Set<string>();
  const assignments: Assignment[] = [];
  for (const item of raw.assignments) {
    const record = asRecord(item);
    const draftId = asString(record?.draft_id);
    const draft = draftId ? drafts.get(draftId) : undefined;
    if (!record || !draftId || !draft || seen.has(draftId)) continue;
    seen.add(draftId);
    const basis = parseBasis(record.basis);
    const target = asRecord(record.target);
    const topicId = asString(target?.topic_id);
    const newRef = asString(target?.new_topic);
    const defer = target?.defer === true || asString(target?.op) === "defer";
    if (topicId && candidates.has(topicId)) {
      assignments.push({ draftId, target: { topicId }, basis });
      continue;
    }
    if (topicId || defer || !newRef || !newTopics.has(newRef)) {
      deferred.push(deferredSegment(draft.content, topicId ? "unknown_topic" : "ambiguous_topic", draft.backfillOf));
      assignments.push({ draftId, target: { defer: true }, basis });
      continue;
    }
    assignments.push({ draftId, target: { newTopicRef: newRef }, basis });
  }

  return { promptVersion: ASSIGN_PROMPT_VERSION, assignments, newTopics, deferred };
}

export function assignBatch(llm: LlmClient, input: AssignInput): Promise<AssignResult> {
  return completeStage(llm, buildAssignMessages(input), "project_memory.assign", (raw) => parseAssignOutput(raw, input));
}

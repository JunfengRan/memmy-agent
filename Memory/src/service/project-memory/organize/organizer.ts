import type { LlmClient } from "../../../model/types.js";
import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { DecisionTarget, DomainRecord, RawTurnRecord, TopicSnapshot } from "../contract/types.js";
import { ORGANIZE_PROMPT_VERSION, ORGANIZE_SYSTEM_PROMPT } from "../prompts/organize.js";
import { clampText } from "../text.js";

export type DraftTarget = { topicId: string } | { newTopicRef: string };

interface DraftBase {
  draftId: string;
  content: string;
  time: string;
  userIds: string[];
  messageIdx: number;
  target: DraftTarget;
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

export interface OrganizeResult {
  promptVersion: string;
  drafts: Draft[];
  newTopics: Map<string, NewTopicDraft>;
  topicUpdates: Map<string, { topicSummary?: string; topicDescription?: string }>;
  informedDecisionIds: Set<string>;
  deferred: Array<{ text: string; reason: string }>;
}

export interface OrganizeInput {
  instructions: string | null;
  domains: DomainRecord[];
  requestDomains: string[];
  messages: RawTurnRecord[];
  context: RawTurnRecord[];
  candidates: TopicSnapshot[];
  conflictsShown: Set<string>;
}

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];
}

const KIND_LIMIT = {
  decision: PROJECT_MEMORY_LIMITS.decision,
  experience: PROJECT_MEMORY_LIMITS.experience,
  timeline: PROJECT_MEMORY_LIMITS.timeline
} as const;

function participantsOf(turns: RawTurnRecord[]): Array<{ user_id: string; name: string | null }> {
  const seen = new Map<string, string | null>();
  for (const turn of turns) {
    if (turn.role !== "user" || !turn.roleId) continue;
    if (!seen.has(turn.roleId)) seen.set(turn.roleId, turn.roleName);
  }
  return [...seen].map(([user_id, name]) => ({ user_id, name }));
}

export function buildOrganizeMessages(input: OrganizeInput): Array<{ role: "system" | "user"; content: string }> {
  const turnView = (turn: RawTurnRecord, idx?: number) => ({
    ...(idx === undefined ? {} : { idx }),
    role: turn.role,
    user_id: turn.roleId,
    name: turn.roleName,
    time: turn.chatTime,
    content: turn.content
  });
  const payload = {
    space: { instructions: input.instructions, domains: input.domains },
    request_domains: input.requestDomains,
    participants: participantsOf([...input.context, ...input.messages]),
    context_turns: input.context.map((turn) => turnView(turn)),
    messages: input.messages.map((turn, idx) => turnView(turn, idx)),
    candidate_topics: input.candidates.map((topic) => ({
      topic_id: topic.topicId,
      domain: topic.domain,
      topic_summary: topic.topicSummary,
      topic_description: topic.topicDescription,
      decisions: topic.decisions.map((decision) => ({
        id: decision.id,
        content: decision.content,
        time: decision.time,
        user_ids: decision.userIds,
        conflicts: decision.conflicts.map((item) => ({ ref: `conflict:${item.seq}`, content: item.content, user_ids: item.userIds }))
      })),
      experiences: topic.experiences.map((experience) => ({ id: experience.id, content: experience.content }))
    })),
    conflicts_shown: [...input.conflictsShown].filter((id) =>
      input.candidates.some((topic) => topic.decisions.some((decision) => decision.id === id && decision.conflicts.length > 0))
    )
  };
  return [
    { role: "system", content: ORGANIZE_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) }
  ];
}

function parseDecisionTarget(value: unknown, conflicts: number[]): DecisionTarget | null {
  if (value === "content") return "content";
  if (typeof value !== "string" || !value.startsWith("conflict:")) return null;
  const seq = Number(value.slice("conflict:".length));
  return conflicts.includes(seq) ? (`conflict:${seq}` as DecisionTarget) : null;
}

/**
 * Validates model output against the batch and the candidate set. Anything that
 * points at an unknown topic is deferred, never turned into a new topic (v3 §2.2.7).
 */
export function parseOrganizeOutput(raw: Json, input: OrganizeInput): OrganizeResult {
  if (!Array.isArray(raw.drafts)) throw new ModelOutputError("drafts must be an array");
  const candidates = new Map(input.candidates.map((topic) => [topic.topicId, topic]));
  // Authors are members who spoke in this conversation (v3 §2.2.9).
  const participants = new Set(participantsOf([...input.context, ...input.messages]).map((item) => item.user_id));
  const batchSpeakers = new Set(participantsOf(input.messages).map((item) => item.user_id));
  const fallbackUser = participantsOf(input.messages)[0]?.user_id ?? [...participants][0] ?? null;

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

  const deferred: OrganizeResult["deferred"] = [];
  for (const item of Array.isArray(raw.deferred) ? raw.deferred : []) {
    const record = asRecord(item);
    const text = asString(record?.text);
    if (text) deferred.push({ text, reason: asString(record?.reason) ?? "ambiguous_topic" });
  }

  const drafts: Draft[] = [];
  raw.drafts.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) return;
    const kind = record.kind;
    if (kind !== "decision" && kind !== "experience" && kind !== "timeline") return;
    const content = asString(record.content);
    const messageIdx = Number(record.message_idx);
    const message = Number.isInteger(messageIdx) ? input.messages[messageIdx] : undefined;
    if (!content || !message) return;

    const topic = asRecord(record.topic);
    const topicId = asString(topic?.topic_id);
    const newRef = asString(topic?.new_topic);
    let target: DraftTarget;
    if (topicId && candidates.has(topicId)) target = { topicId };
    else if (!topicId && newRef && newTopics.has(newRef)) target = { newTopicRef: newRef };
    else {
      deferred.push({ text: content, reason: topicId ? "unknown_topic" : "ambiguous_topic" });
      return;
    }

    const userIds = draftAuthors(message, messageIdx, asStringArray(record.user_ids), input.messages, batchSpeakers, fallbackUser);
    if (userIds.length === 0) return;
    const base = {
      draftId: `d${index}`,
      content: clampText(content, KIND_LIMIT[kind]),
      time: message.chatTime,
      userIds,
      messageIdx,
      target
    };
    const snapshot = "topicId" in target ? candidates.get(target.topicId) : undefined;

    if (kind === "decision") {
      const sameQuestion = asString(record.same_question_as);
      const decision = snapshot?.decisions.find((entry) => entry.id === sameQuestion);
      const seqs = decision?.conflicts.map((item) => item.seq) ?? [];
      const resolveRecord = asRecord(record.resolve);
      const pick = resolveRecord?.pick === "new" ? "new" : parseDecisionTarget(resolveRecord?.pick, seqs);
      drafts.push({
        ...base,
        kind,
        reason: asString(record.reason),
        sameQuestionAs: decision?.id ?? null,
        sameAs: decision ? parseDecisionTarget(record.same_as, seqs) : null,
        // Merge only honours an approver who holds the current conclusion. Whether a
        // second-hand approval ("已和用户B 确认") counts is open-questions Q-12.
        approvedBy: asStringArray(record.approved_by).filter((id) => !userIds.includes(id)),
        resolve: decision && pick ? { pick } : null
      });
    } else if (kind === "experience") {
      const sameExperience = asString(record.same_experience_as);
      const experience = snapshot?.experiences.find((entry) => entry.id === sameExperience);
      const change = record.experience_change === "same" || record.experience_change === "new_version" ? record.experience_change : null;
      drafts.push({
        ...base,
        kind,
        reason: asString(record.reason),
        sameExperienceAs: experience?.id ?? null,
        change: experience ? change ?? "new_version" : null
      });
    } else {
      drafts.push({ ...base, kind });
    }
  });

  const topicUpdates: OrganizeResult["topicUpdates"] = new Map();
  for (const item of Array.isArray(raw.topic_updates) ? raw.topic_updates : []) {
    const record = asRecord(item);
    const topicId = asString(record?.topic_id);
    if (!record || !topicId || !candidates.has(topicId)) continue;
    const summary = asString(record.topic_summary);
    const description = asString(record.topic_description);
    topicUpdates.set(topicId, {
      ...(summary ? { topicSummary: clampText(summary, PROJECT_MEMORY_LIMITS.topicSummary) } : {}),
      ...(description ? { topicDescription: clampText(description, PROJECT_MEMORY_LIMITS.topicDescription) } : {})
    });
  }

  return {
    promptVersion: ORGANIZE_PROMPT_VERSION,
    drafts,
    newTopics,
    topicUpdates,
    informedDecisionIds: new Set(asStringArray(raw.informed_decision_ids)),
    deferred
  };
}

/**
 * Authors are derived from the transcript, not trusted from the model: a user message is
 * authored by its speaker, and Agent output by the members who delegated it in this batch.
 * A model that names someone else would otherwise let a non-author rewrite a decision.
 */
function draftAuthors(
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

/** One model call per attempt; malformed output is retried, then the task fails. */
export async function organizeBatch(llm: LlmClient, input: OrganizeInput): Promise<OrganizeResult> {
  const messages = buildOrganizeMessages(input);
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROJECT_MEMORY_LIMITS.modelAttempts; attempt += 1) {
    try {
      const raw = await llm.completeJson<Json>(messages, {
        operation: "project_memory.organize",
        jsonMode: true,
        temperature: 0,
        thinkingMode: "disabled",
        maxTokens: 4000
      });
      return parseOrganizeOutput(raw, input);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

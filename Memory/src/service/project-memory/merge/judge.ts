import type { LlmClient } from "../../../model/types.js";
import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { DecisionTarget, TopicSnapshot } from "../contract/types.js";
import { JUDGE_PROMPT_VERSION, JUDGE_SYSTEM_PROMPT } from "../prompts/merge-judge.js";
import { clampText } from "../text.js";
import {
  type DecisionSplitLabel,
  type ExtractedDraft,
  type ExtractResult,
  type Json,
  type JudgeLabel,
  type JudgeResult,
  ModelOutputError,
  asRecord,
  asString,
  asStringArray,
  completeStage
} from "../organize/organizer.js";

export interface JudgeDraft extends ExtractedDraft {
  topicId: string;
}

export interface JudgeInput {
  drafts: JudgeDraft[];
  topics: TopicSnapshot[];
  conflictsShown: Set<string>;
  stateHints: ExtractResult["stateHints"];
}

function parseDecisionTarget(value: unknown, conflicts: number[]): DecisionTarget | null {
  if (value === "content") return "content";
  if (typeof value !== "string" || !value.startsWith("conflict:")) return null;
  const seq = Number(value.slice("conflict:".length));
  return conflicts.includes(seq) ? (`conflict:${seq}` as DecisionTarget) : null;
}

function parseSplit(value: unknown, conflicts: number[]): DecisionSplitLabel | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.parts)) return null;
  const parts: DecisionSplitLabel["parts"] = [];
  for (const item of record.parts) {
    const part = asRecord(item);
    const content = asString(part?.content);
    if (!part || !content) continue;
    const from: DecisionTarget[] = [];
    for (const ref of asStringArray(part.from)) {
      const target = parseDecisionTarget(ref, conflicts);
      if (target && !from.includes(target)) from.push(target);
    }
    parts.push({ content: clampText(content, PROJECT_MEMORY_LIMITS.decision), from });
  }
  return parts.length >= 2 ? { parts } : null;
}

export function buildJudgeMessages(input: JudgeInput): Array<{ role: "system" | "user"; content: string }> {
  const conflictsShown = [...input.conflictsShown].filter((id) =>
    input.topics.some((topic) => topic.decisions.some((decision) => decision.id === id && decision.conflicts.length > 0))
  );
  const payload = {
    drafts: input.drafts.map((draft) => ({
      draft_id: draft.draftId,
      kind: draft.kind,
      category: draft.category,
      content: draft.content,
      message_idx: draft.messageIdx,
      time: draft.time,
      user_ids: draft.userIds,
      reason: draft.reason,
      topic_id: draft.topicId,
      signals: draft.signals
    })),
    topics: input.topics.map((topic) => ({
      topic_id: topic.topicId,
      domain: topic.domain,
      topic_summary: topic.topicSummary,
      topic_description: topic.topicDescription,
      decisions: topic.decisions.map((decision) => ({
        id: decision.id,
        content: decision.content,
        time: decision.time,
        user_ids: decision.userIds,
        conflicts: decision.conflicts.map((item) => ({
          ref: `conflict:${item.seq}`,
          content: item.content,
          time: item.time,
          user_ids: item.userIds
        })),
        history: decision.history.map((item) => ({
          content: item.content,
          time: item.time,
          user_ids: item.userIds,
          reason: item.reason
        }))
      })),
      experiences: topic.experiences.map((experience) => ({
        id: experience.id,
        content: experience.content,
        time: experience.time,
        user_ids: experience.userIds,
        history: experience.history.map((item) => ({
          content: item.content,
          time: item.time,
          user_ids: item.userIds,
          reason: item.reason
        }))
      }))
    })),
    conflicts_shown: conflictsShown,
    state_hints: input.stateHints
  };
  return [
    { role: "system", content: JUDGE_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) }
  ];
}

/** Binds model labels to decisions and experiences that actually exist on the assigned topic. */
export function parseJudgeOutput(raw: Json, input: JudgeInput): JudgeResult {
  if (!Array.isArray(raw.drafts)) throw new ModelOutputError("drafts must be an array");
  const topics = new Map(input.topics.map((topic) => [topic.topicId, topic]));
  const drafts = new Map(input.drafts.map((draft) => [draft.draftId, draft]));
  const labels = new Map<string, JudgeLabel>();

  for (const item of raw.drafts) {
    const record = asRecord(item);
    const draftId = asString(record?.draft_id);
    const draft = draftId ? drafts.get(draftId) : undefined;
    if (!record || !draftId || !draft || labels.has(draftId)) continue;
    const snapshot = topics.get(draft.topicId);
    const sameQuestion = asString(record.same_question_as);
    const decision = snapshot?.decisions.find((entry) => entry.id === sameQuestion);
    const seqs = decision?.conflicts.map((entry) => entry.seq) ?? [];
    const resolveRecord = asRecord(record.resolve);
    const pick = resolveRecord?.pick === "new" ? "new" : parseDecisionTarget(resolveRecord?.pick, seqs);
    const resolve: JudgeLabel["resolve"] = decision && pick ? { pick } : null;
    const sameExperience = asString(record.same_experience_as);
    const experience = snapshot?.experiences.find((entry) => entry.id === sameExperience);
    const change = record.experience_change === "same" || record.experience_change === "new_version" ? record.experience_change : null;
    labels.set(draftId, {
      draftId,
      sameQuestionAs: decision?.id ?? null,
      sameAs: decision ? parseDecisionTarget(record.same_as, seqs) : null,
      approvedBy: asStringArray(record.approved_by).filter((id) => !draft.userIds.includes(id)),
      resolve,
      // A parsed resolve wins when the model sets both.
      split: decision && !resolve ? parseSplit(record.split, seqs) : null,
      sameExperienceAs: experience?.id ?? null,
      change: experience ? change ?? "new_version" : null
    });
  }

  const topicUpdates: JudgeResult["topicUpdates"] = new Map();
  for (const item of Array.isArray(raw.topic_updates) ? raw.topic_updates : []) {
    const record = asRecord(item);
    const topicId = asString(record?.topic_id);
    if (!record || !topicId || !topics.has(topicId)) continue;
    const summary = asString(record.topic_summary);
    const description = asString(record.topic_description);
    topicUpdates.set(topicId, {
      ...(summary ? { topicSummary: clampText(summary, PROJECT_MEMORY_LIMITS.topicSummary) } : {}),
      ...(description ? { topicDescription: clampText(description, PROJECT_MEMORY_LIMITS.topicDescription) } : {})
    });
  }

  return {
    promptVersion: JUDGE_PROMPT_VERSION,
    labels,
    topicUpdates,
    informedDecisionIds: new Set(asStringArray(raw.informed_decision_ids))
  };
}

export function judgeBatch(llm: LlmClient, input: JudgeInput): Promise<JudgeResult> {
  return completeStage(llm, buildJudgeMessages(input), "project_memory.judge", (raw) => parseJudgeOutput(raw, input));
}

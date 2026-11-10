import { randomUUID } from "node:crypto";
import type {
  ChangeSet,
  DecisionOp,
  DecisionTarget,
  ExperienceOp,
  TimelineAppend,
  TopicChange,
  TopicSnapshot
} from "../contract/types.js";
import {
  deferredSegment,
  type DecisionDraft,
  type DeferredSegment,
  type Draft,
  type ExperienceDraft,
  type OrganizeResult
} from "../organize/organizer.js";
import { applyDecisionEntries, applyExperienceOp, type MutableDecision, type MutableExperience } from "../store/sqlite/apply.js";
import { normalizeForCompare } from "../text.js";
import { isBefore } from "../time.js";

/**
 * Deterministic merge of validated drafts into a ChangeSet against the freshest
 * L02 snapshot (v3 §2.2.9). The judge call already answered "same question?" and
 * "same conclusion?"; everything here is rule-based, so re-running it after a
 * VERSION_CONFLICT re-merges against new data instead of replaying old ops.
 * Written-op basis is returned beside the ChangeSet and is not stored on the ops.
 */

export interface OpBasis {
  draftId: string;
  hit: string | null;
  checked: string[];
}
export interface MergeContext {
  spaceId: string;
  taskId: string;
  sourceBatchId: string;
  idempotencyKey: string;
  conversationId: string | null;
  agentId: string | null;
  /** Domain for new topics, or null when it cannot be resolved (v3 §2.2.8). */
  newTopicDomain: string | null;
  topicSeq: Record<string, number>;
  /** Decisions whose conflicts this conversation has already been shown. */
  conflictsShown: Set<string>;
  displayName(userId: string): string;
  newId?(prefix: "topic" | "dec" | "exp" | "tl"): string;
}

export interface MergeOutcome {
  changeSet: ChangeSet | null;
  deferred: DeferredSegment[];
  /** Pending rows whose drafts were written into the ChangeSet. */
  resolvedBackfill: number[];
  createdTopicIds: string[];
  updatedTopicIds: string[];
  opBases: OpBasis[];
}

function defaultId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function cloneDecision(decision: TopicSnapshot["decisions"][number]): MutableDecision {
  return {
    id: decision.id,
    content: decision.content,
    time: decision.time,
    userIds: [...decision.userIds],
    conflicts: decision.conflicts.map((item) => ({ ...item, userIds: [...item.userIds] })),
    newHistory: [],
    isNew: false
  };
}

function cloneExperience(experience: TopicSnapshot["experiences"][number]): MutableExperience & { pastContents: string[] } {
  return {
    id: experience.id,
    content: experience.content,
    time: experience.time,
    userIds: [...experience.userIds],
    newHistory: [],
    isNew: false,
    pastContents: experience.history.map((item) => normalizeForCompare(item.content))
  };
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  return left.some((value) => right.includes(value));
}

function itemFor(decision: MutableDecision, target: DecisionTarget): { userIds: string[]; content: string } | undefined {
  if (target === "content") return decision;
  const seq = Number(target.slice("conflict:".length));
  return decision.conflicts.find((item) => item.seq === seq);
}

function sameConclusion(decision: MutableDecision, content: string): DecisionTarget | null {
  const normalized = normalizeForCompare(content);
  if (normalizeForCompare(decision.content) === normalized) return "content";
  const conflict = decision.conflicts.find((item) => normalizeForCompare(item.content) === normalized);
  return conflict ? (`conflict:${conflict.seq}` as DecisionTarget) : null;
}

function ownedConflict(decision: MutableDecision, userIds: readonly string[]): `conflict:${number}` | null {
  const item = decision.conflicts.find((conflict) => intersects(conflict.userIds, userIds));
  return item ? `conflict:${item.seq}` : null;
}

function membersOf(decision: MutableDecision, from: readonly DecisionTarget[]): string[] {
  const ids: string[] = [];
  for (const target of from) {
    const item = itemFor(decision, target);
    if (!item) continue;
    for (const id of item.userIds) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The piece that cites `content` keeps the row. History is insert-only, so the
 * original id is rewritten instead of deleted. Other pieces are new ids.
 */
function splitDecision(
  draft: DecisionDraft,
  decision: MutableDecision,
  context: MergeContext,
  newId: (prefix: "dec") => string
): DecisionOp | null {
  const parts = draft.split?.parts;
  if (!parts || parts.length < 2) return null;
  const authors = draft.userIds;
  const resolver = authors[0] ? [authors[0]] : [];
  const citingContent = parts.findIndex((part) => part.from.includes("content"));
  const keptIndex = citingContent >= 0 ? citingContent : 0;
  return {
    op: "split",
    decisionId: decision.id,
    reason: `${context.displayName(authors[0]!)} 确定各项适用于不同情况`,
    splitInto: parts.map((part, index) => ({
      decisionId: index === keptIndex ? decision.id : newId("dec"),
      content: part.content,
      time: draft.time,
      userIds: part.from.length === 0 ? [...resolver] : membersOf(decision, part.from)
    }))
  };
}

function decideDecision(
  draft: DecisionDraft,
  decision: MutableDecision | undefined,
  informed: boolean,
  context: MergeContext,
  newId: (prefix: "dec") => string
): DecisionOp | null {
  if (!decision) {
    return { op: "add", decisionId: newId("dec"), content: draft.content, time: draft.time, userIds: draft.userIds, reason: draft.reason };
  }
  const authors = draft.userIds;
  const sameAs = sameConclusion(decision, draft.content) ?? draft.sameAs;
  const late = isBefore(draft.time, decision.time);

  // An informed member settling the disagreement wins over "same conclusion":
  // picking someone's conclusion is a resolution, not a vote for it.
  if (draft.resolve && informed && !late && decision.conflicts.length > 0) {
    const pick = draft.resolve.pick;
    const resolver = context.displayName(authors[0]!);
    if (pick === "new") {
      return {
        op: "resolve",
        decisionId: decision.id,
        target: "new",
        content: draft.content,
        time: draft.time,
        userIds: authors,
        reason: `${resolver} 确定了新的结论`
      };
    }
    const selected = itemFor(decision, pick);
    if (selected) {
      const owner = selected.userIds[0];
      return {
        op: "resolve",
        decisionId: decision.id,
        target: pick,
        reason: owner ? `${resolver} 确定以${context.displayName(owner)} 的结论为准` : `${resolver} 确定了结论`
      };
    }
  }

  // Same slot as resolve (Q-10): an informed split wins over "same conclusion".
  if (draft.split && informed && !late && decision.conflicts.length > 0) {
    const split = splitDecision(draft, decision, context, newId);
    if (split) return split;
  }

  if (sameAs) {
    const item = itemFor(decision, sameAs);
    if (!item) return null;
    if (authors.every((id) => item.userIds.includes(id))) return null;
    return { op: "join", decisionId: decision.id, target: sameAs, userIds: authors };
  }

  const inAnyItem = intersects(decision.userIds, authors) || decision.conflicts.some((item) => intersects(item.userIds, authors));
  if (late) {
    // A late draft never rewrites a newer decision (v3 §2.2.9).
    return inAnyItem ? null : { op: "conflict_append", decisionId: decision.id, content: draft.content, time: draft.time, userIds: authors };
  }
  if (intersects(decision.userIds, authors) || intersects(decision.userIds, draft.approvedBy)) {
    return { op: "rewrite", decisionId: decision.id, content: draft.content, time: draft.time, userIds: authors, reason: draft.reason };
  }
  const owned = ownedConflict(decision, authors);
  if (owned) {
    return { op: "conflict_update", decisionId: decision.id, target: owned, content: draft.content, time: draft.time, userIds: authors };
  }
  return { op: "conflict_append", decisionId: decision.id, content: draft.content, time: draft.time, userIds: authors };
}

function decideExperience(
  draft: ExperienceDraft,
  experience: (MutableExperience & { pastContents: string[] }) | undefined,
  newId: (prefix: "exp") => string
): ExperienceOp | null {
  if (!experience) {
    return { op: "add", experienceId: newId("exp"), content: draft.content, time: draft.time, userIds: draft.userIds };
  }
  const normalized = normalizeForCompare(draft.content);
  if (normalized === normalizeForCompare(experience.content) || draft.change === "same") {
    const time = isBefore(experience.time, draft.time) ? draft.time : experience.time;
    if (time === experience.time && draft.userIds.every((id) => experience.userIds.includes(id))) return null;
    return { op: "join", experienceId: experience.id, time, userIds: draft.userIds };
  }
  if (experience.pastContents.includes(normalized)) return null;
  if (isBefore(draft.time, experience.time)) {
    return { op: "history_backfill", experienceId: experience.id, content: draft.content, time: draft.time, userIds: draft.userIds };
  }
  return { op: "update", experienceId: experience.id, content: draft.content, time: draft.time, userIds: draft.userIds, reason: draft.reason };
}

export function mergeDrafts(
  organized: OrganizeResult,
  snapshots: Map<string, TopicSnapshot>,
  context: MergeContext,
  skipTopics: ReadonlySet<string> = new Set()
): MergeOutcome {
  const newId = context.newId ?? defaultId;
  const deferred = [...organized.deferred];
  const resolvedBackfill: number[] = [];
  const opBases: OpBasis[] = [];
  const changes = new Map<string, TopicChange>();
  const decisionState = new Map<string, MutableDecision>();
  const experienceState = new Map<string, MutableExperience & { pastContents: string[] }>();
  const newTopicIds = new Map<string, string>();

  const changeFor = (draft: Draft): TopicChange | null => {
    if ("topicId" in draft.target) {
      const snapshot = snapshots.get(draft.target.topicId);
      if (!snapshot || skipTopics.has(snapshot.topicId)) {
        deferred.push(deferredSegment(draft.content, "topic_unavailable", draft.backfillOf));
        return null;
      }
      let change = changes.get(snapshot.topicId);
      if (!change) {
        change = {
          op: "update",
          topicId: snapshot.topicId,
          domain: snapshot.domain,
          expectedRevision: snapshot.revision,
          decisions: [],
          experiences: [],
          timelineAppend: [],
          sourcesAppend: []
        };
        changes.set(snapshot.topicId, change);
        for (const decision of snapshot.decisions) decisionState.set(decision.id, cloneDecision(decision));
        for (const experience of snapshot.experiences) experienceState.set(experience.id, cloneExperience(experience));
      }
      return change;
    }
    const ref = draft.target.newTopicRef;
    const topic = organized.newTopics.get(ref);
    if (!topic || !context.newTopicDomain) {
      deferred.push(deferredSegment(
        draft.content,
        context.newTopicDomain ? "ambiguous_topic" : "domain_unresolved",
        draft.backfillOf
      ));
      return null;
    }
    let topicId = newTopicIds.get(ref);
    if (!topicId) {
      topicId = newId("topic");
      newTopicIds.set(ref, topicId);
      changes.set(topicId, {
        op: "create",
        topicId,
        domain: context.newTopicDomain,
        expectedTopicSeq: context.topicSeq[context.newTopicDomain] ?? 0,
        topicName: topic.topicName,
        topicSummary: topic.topicSummary,
        topicDescription: topic.topicDescription,
        decisions: [],
        experiences: [],
        timelineAppend: [],
        sourcesAppend: []
      });
    }
    return changes.get(topicId)!;
  };

  const touched = new Set<string>();
  const authorsByTopic = new Map<string, Set<string>>();
  for (const draft of organized.drafts) {
    const change = changeFor(draft);
    if (!change) continue;
    let wrote = false;
    if (draft.kind === "decision") {
      const current = change.op === "update" && draft.sameQuestionAs ? decisionState.get(draft.sameQuestionAs) : undefined;
      const informed = Boolean(current && context.conflictsShown.has(current.id) && organized.informedDecisionIds.has(current.id));
      const op = decideDecision(draft, current, informed, context, newId);
      if (op) {
        change.decisions.push(op);
        const applied = applyDecisionEntries(
          op.op === "add" ? undefined : decisionState.get(op.decisionId),
          op,
          { idExists: (id) => decisionState.has(id) }
        );
        for (const item of applied) decisionState.set(item.id, item);
        wrote = true;
      }
    } else if (draft.kind === "experience") {
      const current = change.op === "update" && draft.sameExperienceAs ? experienceState.get(draft.sameExperienceAs) : undefined;
      const op = decideExperience(draft, current, newId);
      if (op) {
        change.experiences.push(op);
        const applied = applyExperienceOp(op.op === "add" ? undefined : experienceState.get(op.experienceId), op);
        const past = experienceState.get(op.experienceId)?.pastContents ?? [];
        experienceState.set(op.experienceId, {
          ...applied,
          pastContents: [...past, ...applied.newHistory.map((item) => normalizeForCompare(item.content))]
        });
        wrote = true;
      }
    } else {
      const existing = change.op === "update" ? snapshots.get(change.topicId)?.timeline ?? [] : [];
      const key = `${normalizeForCompare(draft.content)}\u0000${draft.time}`;
      const seen = [...existing, ...change.timelineAppend].some((item) => `${normalizeForCompare(item.content)}\u0000${item.time}` === key);
      if (!seen) {
        const append: TimelineAppend = { timelineId: newId("tl"), content: draft.content, time: draft.time, userIds: draft.userIds };
        change.timelineAppend.push(append);
        wrote = true;
      }
    }
    if (wrote) {
      if (draft.backfillOf != null) resolvedBackfill.push(draft.backfillOf);
      const snapshot = snapshots.get(change.topicId);
      const checked = !snapshot
        ? []
        : draft.kind === "decision"
          ? snapshot.decisions.map((item) => item.id)
          : draft.kind === "experience"
            ? snapshot.experiences.map((item) => item.id)
            : [];
      opBases.push({
        draftId: draft.draftId,
        hit: draft.kind === "decision" ? draft.sameQuestionAs : draft.kind === "experience" ? draft.sameExperienceAs : null,
        checked
      });
      touched.add(change.topicId);
      const authors = authorsByTopic.get(change.topicId) ?? new Set<string>();
      for (const id of draft.userIds) authors.add(id);
      authorsByTopic.set(change.topicId, authors);
    }
  }

  const topics: TopicChange[] = [];
  for (const change of changes.values()) {
    if (!touched.has(change.topicId)) continue;
    if (change.op === "update") {
      const rewrite = organized.topicUpdates.get(change.topicId);
      const snapshot = snapshots.get(change.topicId)!;
      if (rewrite?.topicSummary && rewrite.topicSummary !== snapshot.topicSummary) change.topicSummary = rewrite.topicSummary;
      if (rewrite?.topicDescription && rewrite.topicDescription !== snapshot.topicDescription) change.topicDescription = rewrite.topicDescription;
    }
    change.sourcesAppend.push({
      userIds: [...(authorsByTopic.get(change.topicId) ?? [])].sort(),
      agentId: context.agentId,
      conversationId: context.conversationId
    });
    topics.push(change);
  }

  return {
    changeSet: topics.length === 0
      ? null
      : {
          spaceId: context.spaceId,
          taskId: context.taskId,
          sourceBatchId: context.sourceBatchId,
          idempotencyKey: context.idempotencyKey,
          topics
        },
    deferred,
    resolvedBackfill,
    createdTopicIds: topics.filter((topic) => topic.op === "create").map((topic) => topic.topicId),
    updatedTopicIds: topics.filter((topic) => topic.op === "update").map((topic) => topic.topicId),
    opBases
  };
}

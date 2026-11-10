import { createHash } from "node:crypto";
import type { LlmClient } from "../../../model/types.js";
import { createMemoryLogger, memoryErrorFields } from "../../../logging/logger.js";
import { ProjectMemoryError } from "../contract/errors.js";
import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { RawTurnRecord, TaskError, TopicSnapshot } from "../contract/types.js";
import type { DecisionTopicRouter } from "../decisions/client.js";
import { briefFromTopic, narrowAddCandidates } from "../decisions/topic-choice.js";
import type { JudgeDraft } from "../merge/judge.js";
import { judgeBatch } from "../merge/judge.js";
import { mergeDrafts, type OpBasis } from "../merge/merge.js";
import { resolveNewTopicDomain } from "../organize/collect.js";
import { assignBatch } from "../organize/assign.js";
import { type MergeCandidate, resolveMergeCandidates } from "../organize/candidates.js";
import { extractBatch, type DeferredSegmentInput } from "../organize/extract.js";
import { clampRecalled, filterRestatements, type RecalledEntry } from "../organize/restatement.js";
import {
  type AssignResult,
  type DeferredSegment,
  type ExtractResult,
  type JudgeResult,
  assembleOrganizeResult,
  isPlacedTarget
} from "../organize/organizer.js";
import type { PendingDeferred, ProjectLocalState, SpaceOutcome, TaskDetails } from "../store/sqlite/local-state.js";
import type { ProjectMemoryStore } from "../store/store.js";

const log = createMemoryLogger("project-memory.organize");

export interface OrganizeJobPayload {
  taskId: string;
  spaceId: string;
  domains: string[];
  agentId: string | null;
  /** Conversation as given by the caller; null when the batch was anonymous. */
  conversationId: string | null;
}

export interface OrganizeJobDeps {
  store: ProjectMemoryStore;
  local: ProjectLocalState;
  llm: LlmClient;
  /** Opt-in topic choice. Absent on the default path, which never calls the decision model. */
  decision?: DecisionTopicRouter | null;
}

class TaskFailure extends Error {
  constructor(readonly error: TaskError) {
    super(`${error.stage}: ${error.reason}`);
  }
}

function fail(stage: TaskError["stage"], reason: string, detail?: string): never {
  throw new TaskFailure({ stage, reason, ...(detail ? { detail } : {}) });
}

function batchHash(turns: RawTurnRecord[]): string {
  const hash = createHash("sha256");
  for (const turn of turns) hash.update(`${turn.role}\u0000${turn.chatTime}\u0000${turn.content}\u0001`);
  return hash.digest("hex").slice(0, 24);
}

interface BackfillInput {
  turns: RawTurnRecord[];
  segments: DeferredSegmentInput[];
  ids: number[];
}

const EMPTY_BACKFILL: BackfillInput = { turns: [], segments: [], ids: [] };

/** Original turns of the producing tasks, deduped, with each segment pointing at that task's didx list. */
function loadBackfill(local: ProjectLocalState, rows: PendingDeferred[]): BackfillInput {
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
function planSettlement(
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

function taskDetails(
  extracted: ExtractResult,
  assigned: AssignResult | null,
  degraded: string[],
  opBases: OpBasis[],
  mergeDropped: Array<{ reason: string; text: string | null }> = []
): TaskDetails {
  return {
    assignments: (assigned?.assignments ?? []).map((item) => ({ draftId: item.draftId, basis: item.basis })),
    dropped: [...extracted.dropped, ...mergeDropped],
    degraded,
    ops: opBases.map((basis) => ({ basis }))
  };
}

function chronological(turns: RawTurnRecord[]): RawTurnRecord[] {
  return [...turns].sort((left, right) => left.chatTime < right.chatTime ? -1 : left.chatTime > right.chatTime ? 1 : left.turnId < right.turnId ? -1 : 1);
}

/**
 * Decisions contribute current content, every conflict and every history row.
 * Experiences and timeline contribute current content only: recall_log has no
 * ids for those rows, so the topic snapshot is the source (ADR-0005).
 */
function recalledEntries(topics: readonly TopicSnapshot[], decisionIds: ReadonlySet<string>): RecalledEntry[] {
  const entries: RecalledEntry[] = [];
  for (const topic of [...topics].sort((left, right) => left.topicId.localeCompare(right.topicId))) {
    for (const decision of [...topic.decisions].sort((left, right) => left.id.localeCompare(right.id))) {
      if (!decisionIds.has(decision.id)) continue;
      entries.push({ ref: `dec:${decision.id}`, text: decision.content });
      for (const item of [...decision.history].sort((left, right) => left.seq - right.seq)) {
        entries.push({ ref: `dec:${decision.id}:h:${item.seq}`, text: item.content });
      }
      for (const item of [...decision.conflicts].sort((left, right) => left.seq - right.seq)) {
        entries.push({ ref: `conflict:${decision.id}:${item.seq}`, text: item.content });
      }
    }
    for (const experience of [...topic.experiences].sort((left, right) => left.id.localeCompare(right.id))) {
      entries.push({ ref: `exp:${experience.id}`, text: experience.content });
    }
    for (const item of [...topic.timeline].sort((left, right) => left.id.localeCompare(right.id))) {
      entries.push({ ref: `tl:${item.id}`, text: item.content });
    }
  }
  return entries;
}

async function loadRecalledEntries(
  store: ProjectMemoryStore,
  local: ProjectLocalState,
  conversationId: string | null
): Promise<RecalledEntry[]> {
  if (!conversationId) return [];
  const { decisionIds, topicIds } = local.recalledIds(conversationId);
  if (topicIds.length === 0) return [];
  const topics = await store.getTopicsFull(null, topicIds);
  return recalledEntries(topics, new Set(decisionIds));
}

/**
 * One Space of one add/message task (v3 §2.3.1).
 * Extract once, drop restatements against this conversation's recall, then
 * recall one query per kept draft, assign from summary and description,
 * full-read only the topics M04 kept, judge, then merge deterministically.
 * TOPIC_SET_CHANGED repeats recall and M04. VERSION_CONFLICT repeats the judge.
 * Neither re-runs extraction or the restatement filter. commitAttempts stays 3.
 */
export async function runOrganizeJob(payload: OrganizeJobPayload, deps: OrganizeJobDeps): Promise<SpaceOutcome> {
  const { store, local } = deps;
  const task = local.getTask(payload.taskId);
  const progress = task?.spaces[payload.spaceId];
  if (!task || !progress) return { status: "failed", memoryIds: [], added: 0, updated: 0, deferredCount: 0, error: { stage: "validate", reason: "TASK_NOT_FOUND" } };
  if (progress.status !== "running") return { ...progress, status: progress.status };

  let outcome: SpaceOutcome;
  try {
    outcome = await organizeSpace(payload, deps, task.acceptedAt);
  } catch (error) {
    const taskError: TaskError = error instanceof TaskFailure
      ? error.error
      : error instanceof ProjectMemoryError
        ? { stage: "commit", reason: error.errorName, detail: error.message }
        : { stage: "organize", reason: "INTERNAL", detail: error instanceof Error ? error.message : String(error) };
    log.warn("task.failed", { taskId: payload.taskId, spaceId: payload.spaceId, reason: taskError.reason, stage: taskError.stage });
    outcome = { status: "failed", memoryIds: [], added: 0, updated: 0, deferredCount: 0, error: taskError };
  }
  local.recordSpaceOutcome(payload.taskId, payload.spaceId, outcome, payload.domains);
  return outcome;
}

async function organizeSpace(payload: OrganizeJobPayload, deps: OrganizeJobDeps, acceptedAt: string): Promise<SpaceOutcome> {
  const { store, local, llm } = deps;
  const space = await store.getSpace(payload.spaceId);
  if (!space || acceptedAt < space.createTime) fail("validate", "SPACE_GONE");
  if (space.clearedAt && acceptedAt < space.clearedAt) fail("validate", "SPACE_CLEARED");
  const domains = await store.listDomains(payload.spaceId);
  if (domains.length === 0) fail("validate", "DOMAIN_NOT_CONFIGURED");
  const registered = new Set(domains.map((item) => item.domain));
  const unknown = payload.domains.filter((domain) => !registered.has(domain));
  if (unknown.length > 0) fail("validate", "DOMAIN_INVALID", unknown.join(","));

  const batchTurns = local.taskTurns(payload.taskId).filter((turn) => turn.role === "user" || turn.role === "assistant");
  if (batchTurns.length === 0) return { status: "completed", memoryIds: [], added: 0, updated: 0, deferredCount: 0 };
  // Q-27: a completed task for this Space and domain set already organized these
  // turns. They stay in the idempotency hash and become context, not a new extract.
  const organized = local.organizedTurnIds(payload.spaceId, payload.domains, batchTurns.map((turn) => turn.turnId), payload.taskId);
  const turns = batchTurns.filter((turn) => !organized.has(turn.turnId));
  const repeated = batchTurns.filter((turn) => organized.has(turn.turnId));
  const backfill = payload.conversationId
    ? loadBackfill(local, local.pendingDeferred(payload.conversationId, payload.spaceId, {
        clearedAt: space.clearedAt,
        limit: PROJECT_MEMORY_LIMITS.deferredBackfill
      }))
    : EMPTY_BACKFILL;
  if (turns.length === 0 && backfill.segments.length === 0) {
    return { status: "completed", memoryIds: [], added: 0, updated: 0, deferredCount: 0 };
  }
  const internalConversation = batchTurns[0]!.conversationId;
  const earlier = payload.conversationId
    ? local.contextTurns(internalConversation, payload.taskId, batchTurns[0]!.chatTime, PROJECT_MEMORY_LIMITS.contextTurns)
        .filter((turn) => turn.role === "user" || turn.role === "assistant")
    : [];
  const context = repeated.length === 0 ? earlier : chronological([...earlier, ...repeated]);
  const conflictsShown = payload.conversationId ? local.conflictedDecisionsShown(payload.conversationId) : new Set<string>();
  const names = new Map<string, string>();
  for (const turn of [...context, ...turns]) if (turn.roleId && turn.roleName) names.set(turn.roleId, turn.roleName);
  const newTopicDomain = resolveNewTopicDomain(payload.domains, domains.map((item) => item.domain));
  const idempotencyKey = `${payload.spaceId}:${payload.conversationId ?? internalConversation}:${batchHash(batchTurns)}`;
  const recallDomains = payload.domains.length > 0 ? payload.domains : undefined;
  const domainRecords = recallDomains ? domains.filter((item) => recallDomains.includes(item.domain)) : domains;
  const conversationKey = payload.conversationId ?? internalConversation;
  // Batch only. Pending deferred ids stay out of the key (PM-16). A replay after a crash
  // between commit and delete still matches, and settleDeferred removes the rows.
  const finish = (
    deferred: DeferredSegment[],
    resolvedBackfill: number[],
    outcome: Omit<SpaceOutcome, "deferredCount">
  ): SpaceOutcome => {
    const plan = planSettlement(backfill.ids, deferred, resolvedBackfill);
    local.settleDeferred({
      conversationId: conversationKey,
      spaceId: payload.spaceId,
      taskId: payload.taskId,
      consumed: plan.consumed,
      kept: plan.kept,
      appended: plan.appended
    });
    if (backfill.ids.length > 0) {
      log.info("deferred.backfill", {
        pending: backfill.ids.length,
        consumed: plan.consumed.length,
        kept: plan.kept.length
      });
    }
    return { ...outcome, deferredCount: plan.appended.length };
  };

  let extracted: ExtractResult | null = null;
  let assigned: AssignResult | null = null;
  let judged: JudgeResult | null = null;
  let judgeReady = false;
  let degraded: string[] = [];
  let topicSeq: Record<string, number> = {};
  const unavailable = new Set<string>();
  // Topics another writer created since our last recall (v3 §2.3.1). They must reach
  // M04 on the next attempt even when the union cap or lexical rank would drop them.
  const mustConsider = new Set<string>();
  const conflictKinds: string[] = [];
  const conflictTopicIds: string[] = [];

  const model = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      log.warn("model.failed", { taskId: payload.taskId, ...memoryErrorFields(error) });
      fail("organize", "MODEL_CALL_FAILED", error instanceof Error ? error.message : String(error));
    }
  };

  for (let attempt = 1; attempt <= PROJECT_MEMORY_LIMITS.commitAttempts; attempt += 1) {
    if (!extracted) {
      if (!llm.isConfigured()) fail("organize", "MODEL_NOT_CONFIGURED");
      const recalled = await loadRecalledEntries(store, local, payload.conversationId);
      const raw = await model(() => extractBatch(llm, {
        instructions: space.instructions,
        domains: domainRecords,
        requestDomains: payload.domains,
        messages: turns,
        context,
        deferredTurns: backfill.turns,
        deferredSegments: backfill.segments,
        recalled: clampRecalled(recalled)
      }));
      // Once, on the cached extract. TOPIC_SET_CHANGED and VERSION_CONFLICT must not
      // bring a dropped restatement back or call the extractor again.
      const filtered = filterRestatements(raw.drafts, turns.map((turn) => ({ role: turn.role })), recalled);
      extracted = {
        ...raw,
        drafts: filtered.kept,
        dropped: [
          ...raw.dropped,
          ...filtered.dropped.map((item) => ({ reason: item.reason, text: item.content }))
        ]
      };
      if (extracted.drafts.length === 0) {
        return finish(extracted.deferred, [], {
          status: "completed",
          memoryIds: [],
          added: 0,
          updated: 0,
          details: taskDetails(extracted, null, [], [])
        });
      }
    }
    if (!extracted) fail("organize", "INTERNAL");
    const extraction = extracted;

    if (!assigned) {
      const recall = await store.recall({
        spaceIds: [payload.spaceId],
        domains: recallDomains,
        queries: extracted.drafts.map((draft) => ({ qid: draft.draftId, text: draft.content })),
        purpose: "merge",
        preferConversationId: payload.conversationId ?? undefined,
        topicK: PROJECT_MEMORY_LIMITS.topicK,
        entryK: 0
      });
      degraded = recall.degraded;
      topicSeq = recall.topicSeq;
      const recalled = await resolveMergeCandidates(store, payload.spaceId, recall, mustConsider);
      const pool = new Map(recalled.map((topic) => [topic.topicId, topic]));
      const narrowed = await narrowCandidatesWithJev(deps.decision, payload.taskId, turns, recalled);
      const candidates = keepMustConsider(narrowed, pool, mustConsider);
      assigned = await model(() => assignBatch(llm, {
        instructions: space.instructions,
        domains: domainRecords,
        requestDomains: payload.domains,
        drafts: extraction.drafts,
        stateHints: extraction.stateHints,
        candidates,
        degraded
      }));
      judged = null;
      judgeReady = false;
    }
    if (!assigned) fail("organize", "INTERNAL");

    const byDraft = new Map(assigned.assignments.map((item) => [item.draftId, item]));
    const topicIds = [...new Set(assigned.assignments.flatMap((item) => "topicId" in item.target ? [item.target.topicId] : []))];
    const snapshots = new Map((topicIds.length > 0 ? await store.getTopicsFull(payload.spaceId, topicIds) : []).map((topic) => [topic.topicId, topic]));

    if (!judgeReady) {
      const judgeDrafts: JudgeDraft[] = [];
      for (const draft of extracted.drafts) {
        const assignment = byDraft.get(draft.draftId);
        if (!assignment || !isPlacedTarget(assignment.target) || !("topicId" in assignment.target)) continue;
        if (!snapshots.has(assignment.target.topicId)) continue;
        judgeDrafts.push({ ...draft, topicId: assignment.target.topicId });
      }
      const judgeTopics = [...new Set(judgeDrafts.map((draft) => draft.topicId))].flatMap((id) => {
        const topic = snapshots.get(id);
        return topic ? [topic] : [];
      });
      judged = judgeDrafts.length === 0
        ? null
        : await model(() => judgeBatch(llm, { drafts: judgeDrafts, topics: judgeTopics, conflictsShown, stateHints: extraction.stateHints }));
      judgeReady = true;
    }

    const organized = assembleOrganizeResult(extracted, assigned, judged);
    const merged = mergeDrafts(organized, snapshots, {
      spaceId: payload.spaceId,
      taskId: payload.taskId,
      sourceBatchId: payload.taskId,
      idempotencyKey,
      conversationId: payload.conversationId,
      agentId: payload.agentId,
      newTopicDomain,
      topicSeq,
      conflictsShown,
      displayName: (userId) => names.get(userId) ?? local.roleName(userId) ?? userId
    }, unavailable);
    const details = taskDetails(extracted, assigned, degraded, merged.opBases, merged.dropped);
    if (!merged.changeSet) {
      return finish(merged.deferred, merged.resolvedBackfill, {
        status: "completed",
        memoryIds: [],
        added: 0,
        updated: 0,
        details
      });
    }

    const result = await store.commitChangeSet(merged.changeSet, { acceptedAt });
    if (result.ok) {
      const memoryIds = result.topics.map((topic) => topic.topicId);
      await store.indexTopics(memoryIds).catch((error: unknown) => log.warn("index.failed", memoryErrorFields(error)));
      return finish(merged.deferred, merged.resolvedBackfill, {
        status: "completed",
        memoryIds,
        added: result.replayed ? 0 : merged.createdTopicIds.length,
        updated: result.replayed ? 0 : merged.updatedTopicIds.length,
        details
      });
    }
    conflictKinds.push(result.error);
    if (result.error === "VERSION_CONFLICT") {
      for (const topic of result.topics) conflictTopicIds.push(topic.topicId);
    } else if (result.error === "TOPIC_SET_CHANGED") {
      for (const topicId of result.newTopicIds) conflictTopicIds.push(topicId);
    } else if (result.error === "TOPIC_NOT_FOUND") {
      for (const topicId of result.topicIds) conflictTopicIds.push(topicId);
    }
    log.info("commit.retry", { taskId: payload.taskId, attempt, error: result.error });
    switch (result.error) {
      case "VERSION_CONFLICT":
        // Re-read and re-judge. Do not extract or assign again.
        judgeReady = false;
        break;
      case "TOPIC_SET_CHANGED":
        for (const topicId of result.newTopicIds) mustConsider.add(topicId);
        assigned = null;
        judgeReady = false;
        break;
      case "TOPIC_NOT_FOUND":
        for (const topicId of result.topicIds) unavailable.add(topicId);
        break;
      case "DOMAIN_INVALID":
        fail("commit", "DOMAIN_INVALID", result.domains.join(","));
      case "SPACE_GONE":
        fail("commit", "SPACE_GONE");
      case "SPACE_CLEARED":
        fail("commit", "SPACE_CLEARED");
    }
  }
  const kinds = conflictKinds.join(",");
  const detail = conflictTopicIds.length > 0 ? `${kinds}; topics=${conflictTopicIds.join(",")}` : kinds;
  fail("commit", "VERSION_CONFLICT_RETRY_EXHAUSTED", detail || undefined);
}

function keepMustConsider(
  candidates: MergeCandidate[],
  pool: ReadonlyMap<string, MergeCandidate>,
  mustConsider: ReadonlySet<string>
): MergeCandidate[] {
  const seen = new Set(candidates.map((topic) => topic.topicId));
  const extra: MergeCandidate[] = [];
  for (const topicId of mustConsider) {
    if (seen.has(topicId)) continue;
    const topic = pool.get(topicId);
    if (!topic) continue;
    extra.push(topic);
    seen.add(topicId);
  }
  return [...candidates, ...extra];
}

/**
 * When the experiment is on, the decision model may keep a single candidate or
 * clear the list (`new`). `none` and any call failure leave the recalled candidates in place,
 * so a bad call cannot drop the batch. This runs on the merge candidate list, before M04.
 */
async function narrowCandidatesWithJev(
  decision: DecisionTopicRouter | null | undefined,
  taskId: string,
  turns: RawTurnRecord[],
  candidates: MergeCandidate[]
): Promise<MergeCandidate[]> {
  if (!decision) return candidates;
  try {
    const query = turns.filter((turn) => turn.role === "user").map((turn) => turn.content).join("\n");
    const answer = turns.filter((turn) => turn.role === "assistant").map((turn) => turn.content).join("\n");
    const choice = await decision.chooseAdd({
      query,
      answer,
      topics: candidates.map((topic) => briefFromTopic(topic, { includeEntries: true }))
    });
    const narrowed = narrowAddCandidates(candidates, choice, (topic) => topic.topicId);
    log.info("decision.add", { taskId, choice: choice.choice, confidence: choice.confidence, candidates: candidates.length, kept: narrowed.length });
    return narrowed;
  } catch (error) {
    log.warn("decision.add.failed", { taskId, ...memoryErrorFields(error) });
    return candidates;
  }
}

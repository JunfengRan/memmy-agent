import type { LlmClient } from "../../../model/types.js";
import { createMemoryLogger, memoryErrorFields } from "../../../logging/logger.js";
import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { RawTurnRecord } from "../contract/types.js";
import type { DecisionTopicRouter } from "../decisions/client.js";
import { briefFromTopic, narrowAddCandidates } from "../decisions/topic-choice.js";
import type { JudgeDraft } from "../merge/judge.js";
import { judgeBatch } from "../merge/judge.js";
import { mergeDrafts } from "../merge/merge.js";
import { resolveNewTopicDomain } from "../organize/collect.js";
import { assignBatch } from "../organize/assign.js";
import { type MergeCandidate, resolveMergeCandidates } from "../organize/candidates.js";
import { extractBatch } from "../organize/extract.js";
import {
  type AssignResult,
  type DeferredSegment,
  type ExtractResult,
  type JudgeResult,
  assembleOrganizeResult,
  isPlacedTarget
} from "../organize/organizer.js";
import type { SpaceOutcome } from "../store/state.js";
import type { ProjectMemoryStore } from "../store/store.js";
import { fail, type OrganizeJobPayload, type OrganizeJobDeps } from "./types.js";
import { batchHash, loadBackfill, EMPTY_BACKFILL, chronological, planSettlement, taskDetails } from "./prepare.js";

const log = createMemoryLogger("project-memory.organize");

export async function organizeSpace(payload: OrganizeJobPayload, deps: OrganizeJobDeps, acceptedAt: string): Promise<SpaceOutcome> {
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
      const raw = await model(() => extractBatch(llm, {
        instructions: space.instructions,
        domains: domainRecords,
        requestDomains: payload.domains,
        messages: turns,
        context,
        deferredTurns: backfill.turns,
        deferredSegments: backfill.segments
      }));
      extracted = raw;
      if (extracted.drafts.length === 0) {
        return finish(extracted.deferred, [], {
          status: "completed",
          memoryIds: [],
          added: 0,
          updated: 0,
          details: taskDetails(extracted, null, [], [], [], payload)
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
        : await model(() => judgeBatch(llm, { drafts: judgeDrafts, topics: judgeTopics, disclosures: payload.conversationId ? extraction.disclosures : [], stateHints: extraction.stateHints }));
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
      displayName: (userId) => names.get(userId) ?? local.roleName(userId) ?? userId
    }, unavailable);
    const details = taskDetails(extracted, assigned, degraded, merged.opBases, merged.dropped, payload);
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

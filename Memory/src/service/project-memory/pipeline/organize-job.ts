import { createHash } from "node:crypto";
import type { LlmClient } from "../../../model/types.js";
import { createMemoryLogger, memoryErrorFields } from "../../../logging/logger.js";
import { ProjectMemoryError } from "../contract/errors.js";
import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { CommitResult, RawTurnRecord, TaskError, TopicSnapshot } from "../contract/types.js";
import type { DecisionTopicRouter } from "../decisions/client.js";
import { briefFromTopic, narrowAddCandidates } from "../decisions/topic-choice.js";
import { mergeDrafts } from "../merge/merge.js";
import { resolveNewTopicDomain } from "../organize/collect.js";
import { organizeBatch, type OrganizeResult } from "../organize/organizer.js";
import type { ProjectLocalState, SpaceOutcome } from "../store/sqlite/local-state.js";
import type { ProjectMemoryStore } from "../store/store.js";
import { clampText } from "../text.js";

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

function recallQuery(turns: RawTurnRecord[]): string {
  return clampText(turns.map((turn) => turn.content).join("\n"), 4000);
}

/**
 * One Space of one add/message task (v3 §2.3.1): recall candidates, organize
 * with the model, merge deterministically, commit with optimistic concurrency.
 * Errors settle the task instead of bubbling to the worker, so a failed batch
 * never blocks later batches of the same Space.
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
  local.recordSpaceOutcome(payload.taskId, payload.spaceId, outcome);
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

  const turns = local.taskTurns(payload.taskId).filter((turn) => turn.role === "user" || turn.role === "assistant");
  if (turns.length === 0) return { status: "completed", memoryIds: [], added: 0, updated: 0, deferredCount: 0 };
  const internalConversation = turns[0]!.conversationId;
  const context = payload.conversationId
    ? local.contextTurns(internalConversation, payload.taskId, turns[0]!.chatTime, PROJECT_MEMORY_LIMITS.contextTurns)
        .filter((turn) => turn.role === "user" || turn.role === "assistant")
    : [];
  const conflictsShown = payload.conversationId ? local.conflictedDecisionsShown(payload.conversationId) : new Set<string>();
  const names = new Map<string, string>();
  for (const turn of [...context, ...turns]) if (turn.roleId && turn.roleName) names.set(turn.roleId, turn.roleName);
  const newTopicDomain = resolveNewTopicDomain(payload.domains, domains.map((item) => item.domain));
  const idempotencyKey = `${payload.spaceId}:${payload.conversationId ?? internalConversation}:${batchHash(turns)}`;
  const recallDomains = payload.domains.length > 0 ? payload.domains : undefined;

  let organized: OrganizeResult | null = null;
  let candidates: TopicSnapshot[] = [];
  let topicSeq: Record<string, number> = {};
  const unavailable = new Set<string>();
  // Topics another writer created since our last recall (v3 §2.3.1). They must reach the
  // model on the next attempt even when lexical recall would rank them outside topic_k.
  const mustConsider = new Set<string>();
  let lastConflict: CommitResult | null = null;

  for (let attempt = 1; attempt <= PROJECT_MEMORY_LIMITS.commitAttempts; attempt += 1) {
    if (!organized) {
      const recall = await store.recall({
        spaceIds: [payload.spaceId],
        domains: recallDomains,
        queries: [{ qid: "batch", text: recallQuery(turns) }],
        purpose: "merge",
        preferConversationId: payload.conversationId ?? undefined,
        topicK: PROJECT_MEMORY_LIMITS.topicK,
        entryK: 0
      });
      topicSeq = recall.topicSeq;
      const recalled = recall.results[0]?.topics.map((topic) => topic.topicId) ?? [];
      candidates = await store.getTopicsFull(payload.spaceId, [...new Set([...mustConsider, ...recalled])]);
      candidates = await narrowCandidatesWithJev(deps.decision, payload.taskId, turns, candidates);
      if (!llm.isConfigured()) fail("organize", "MODEL_NOT_CONFIGURED");
      try {
        organized = await organizeBatch(llm, {
          instructions: space.instructions,
          domains: recallDomains ? domains.filter((item) => recallDomains.includes(item.domain)) : domains,
          requestDomains: payload.domains,
          messages: turns,
          context,
          candidates,
          conflictsShown
        });
      } catch (error) {
        log.warn("model.failed", { taskId: payload.taskId, ...memoryErrorFields(error) });
        fail("organize", "MODEL_CALL_FAILED", error instanceof Error ? error.message : String(error));
      }
    } else {
      // Re-read and re-merge against fresh data; never replay the old ChangeSet.
      candidates = await store.getTopicsFull(payload.spaceId, candidates.map((topic) => topic.topicId));
    }

    const merged = mergeDrafts(organized, new Map(candidates.map((topic) => [topic.topicId, topic])), {
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
    const conversationKey = payload.conversationId ?? internalConversation;
    if (!merged.changeSet) {
      local.appendDeferred({ conversationId: conversationKey, spaceId: payload.spaceId, taskId: payload.taskId, segments: merged.deferred });
      return { status: "completed", memoryIds: [], added: 0, updated: 0, deferredCount: merged.deferred.length };
    }

    const result = await store.commitChangeSet(merged.changeSet, { acceptedAt });
    if (result.ok) {
      local.appendDeferred({ conversationId: conversationKey, spaceId: payload.spaceId, taskId: payload.taskId, segments: merged.deferred });
      const memoryIds = result.topics.map((topic) => topic.topicId);
      await store.indexTopics(memoryIds).catch((error: unknown) => log.warn("index.failed", memoryErrorFields(error)));
      return {
        status: "completed",
        memoryIds,
        added: result.replayed ? 0 : merged.createdTopicIds.length,
        updated: result.replayed ? 0 : merged.updatedTopicIds.length,
        deferredCount: merged.deferred.length
      };
    }
    lastConflict = result;
    log.info("commit.retry", { taskId: payload.taskId, attempt, error: result.error });
    switch (result.error) {
      case "VERSION_CONFLICT":
        break;
      case "TOPIC_SET_CHANGED":
        for (const topicId of result.newTopicIds) mustConsider.add(topicId);
        organized = null;
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
  fail("commit", "VERSION_CONFLICT_RETRY_EXHAUSTED", lastConflict && !lastConflict.ok ? lastConflict.error : undefined);
}

/**
 * When the experiment is on, the decision model may keep a single candidate or
 * clear the list (`new`). `none` and any call failure leave the recalled candidates in place,
 * so a bad call cannot drop the batch.
 */
async function narrowCandidatesWithJev(
  decision: DecisionTopicRouter | null | undefined,
  taskId: string,
  turns: RawTurnRecord[],
  candidates: TopicSnapshot[]
): Promise<TopicSnapshot[]> {
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

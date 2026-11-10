import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type {
  RawTurnInput,
  RawTurnRecord,
  RecallLogInput,
  TaskError,
  TaskRecord,
  TaskStatus
} from "../../contract/types.js";

type Db = Database.Database;

interface TaskRow {
  task_id: string;
  space_ids_json: string;
  conversation_id: string;
  batch_key: string;
  source_batch_id: string;
  accepted_at: string;
  status: TaskStatus;
  memory_ids_json: string;
  deferred_count: number;
  error_json: string | null;
  progress_json: string;
  updated_at: string;
}

interface TurnRow {
  turn_id: string;
  task_id: string;
  conversation_id: string;
  role: RawTurnInput["role"];
  role_id: string | null;
  role_name: string | null;
  chat_time: string;
  chat_time_inferred: number;
  content: string;
  tool_calls_json: string;
}

type SpaceProgress = TaskRecord["spaces"][string] & {
  error?: TaskError | null;
  details?: TaskDetails;
  /** Set on spaces copied from a completed attempt. Omitted from get/status. */
  resubmitOf?: string;
  /** Domain set this Space was organized with. Omitted from get/status. */
  domains?: string[];
};

/**
 * Failures a caller may submit again as a new task (Q-16).
 * If any failed space has another reason, the original task is returned (Q-25).
 */
export const RESUBMITTABLE_REASONS: ReadonlySet<string> = new Set([
  "VERSION_CONFLICT_RETRY_EXHAUSTED",
  "MODEL_CALL_FAILED"
]);

/** Audit fields kept in pm_tasks.progress_json. get/status does not return them. */
export interface TaskDetails {
  assignments: Array<{
    draftId: string;
    basis: { independentDelivery: boolean; affectsExistingDecisions: boolean };
  }>;
  dropped: Array<{ reason: string; text: string | null }>;
  degraded: string[];
  ops: Array<{ basis: { draftId: string; hit: string | null; checked: string[] } }>;
  /** Closed `<memos_context>` / `<project_index>` blocks removed before M02. */
  strippedBlocks?: number;
  /** Unclosed tags left in the text (Q-34). Not part of the M02 acceptance count. */
  unclosedBlocks?: number;
}

export interface SpaceOutcome {
  status: Exclude<TaskStatus, "running">;
  memoryIds: string[];
  added: number;
  updated: number;
  deferredCount: number;
  error?: TaskError | null;
  details?: TaskDetails;
}

function taskFromRow(row: TaskRow): TaskRecord {
  const progress = JSON.parse(row.progress_json) as Record<string, SpaceProgress>;
  const spaces: TaskRecord["spaces"] = {};
  let added = 0;
  let updated = 0;
  for (const [spaceId, item] of Object.entries(progress)) {
    spaces[spaceId] = {
      status: item.status,
      memoryIds: item.memoryIds,
      added: item.added,
      updated: item.updated,
      deferredCount: item.deferredCount
    };
    added += item.added;
    updated += item.updated;
  }
  return {
    taskId: row.task_id,
    spaceIds: JSON.parse(row.space_ids_json) as string[],
    conversationId: row.conversation_id,
    batchKey: row.batch_key,
    acceptedAt: row.accepted_at,
    status: row.status,
    memoryIds: JSON.parse(row.memory_ids_json) as string[],
    added,
    updated,
    deferredCount: Number(row.deferred_count),
    error: row.error_json ? (JSON.parse(row.error_json) as TaskError) : null,
    spaces
  };
}

function retryableFailure(row: TaskRow): { failed: Set<string> } | null {
  if (row.status !== "failed") return null;
  const progress = JSON.parse(row.progress_json) as Record<string, SpaceProgress>;
  const failed = Object.entries(progress).filter(([, item]) => item.status === "failed");
  if (failed.length === 0) return null;
  const retryable = failed.every(([, item]) => item.error != null && RESUBMITTABLE_REASONS.has(item.error.reason));
  if (!retryable) return null;
  return { failed: new Set(failed.map(([spaceId]) => spaceId)) };
}

function domainSetKey(domains: readonly string[]): string {
  return JSON.stringify([...domains].sort());
}

function turnFromRow(row: TurnRow): RawTurnRecord {
  return {
    turnId: row.turn_id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    role: row.role,
    roleId: row.role_id,
    roleName: row.role_name,
    chatTime: row.chat_time,
    chatTimeInferred: row.chat_time_inferred === 1,
    content: row.content,
    toolCalls: JSON.parse(row.tool_calls_json) as RawTurnRecord["toolCalls"]
  };
}

/**
 * Device-local pipeline state (v3 §5.3 "仅本地"): tasks, raw turns, recall log
 * and deferred segments. These stay in SQLite whatever store backs the topics.
 */
export class ProjectLocalState {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  createTask(
    input: { taskId: string; spaceIds: string[]; conversationId: string; batchKey: string; sourceBatchId: string; acceptedAt: string },
    turns: RawTurnInput[]
  ): { task: TaskRecord; created: boolean; pendingSpaceIds: string[] } {
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM pm_tasks WHERE batch_key = ?`).get(input.batchKey) as TaskRow | undefined;
      let pendingSpaceIds = [...input.spaceIds];
      let resubmitOf: string | null = null;
      if (existing) {
        const retry = retryableFailure(existing);
        if (!retry) return { task: taskFromRow(existing), created: false, pendingSpaceIds: [] };
        this.db.prepare(`UPDATE pm_tasks SET batch_key = batch_key || '#' || task_id WHERE task_id = ?`).run(existing.task_id);
        pendingSpaceIds = input.spaceIds.filter((spaceId) => retry.failed.has(spaceId));
        resubmitOf = existing.task_id;
      }
      const retrying = new Set(pendingSpaceIds);
      const progress: Record<string, SpaceProgress> = {};
      for (const spaceId of input.spaceIds) {
        progress[spaceId] = resubmitOf && !retrying.has(spaceId)
          ? { status: "completed", memoryIds: [], added: 0, updated: 0, deferredCount: 0, resubmitOf }
          : { status: "running", memoryIds: [], added: 0, updated: 0, deferredCount: 0 };
      }
      const now = this.now().toISOString();
      this.db.prepare(
        `INSERT INTO pm_tasks (
           task_id, space_ids_json, conversation_id, batch_key, source_batch_id, accepted_at,
           status, memory_ids_json, deferred_count, error_json, progress_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'running', '[]', 0, NULL, ?, ?)`
      ).run(
        input.taskId,
        JSON.stringify(input.spaceIds),
        input.conversationId,
        input.batchKey,
        input.sourceBatchId,
        input.acceptedAt,
        JSON.stringify(progress),
        now
      );
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO pm_raw_turns (
           turn_id, task_id, conversation_id, role, role_id, role_name, chat_time, chat_time_inferred,
           content, content_hash, tool_calls_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const storedTurn = this.db.prepare(
        `SELECT turn_id FROM pm_raw_turns
         WHERE conversation_id = ? AND role = ? AND chat_time = ? AND content_hash = ?`
      );
      const link = this.db.prepare(`INSERT OR IGNORE INTO pm_task_turns (task_id, turn_id) VALUES (?, ?)`);
      for (const turn of turns) {
        const contentHash = createHash("sha256").update(turn.content).digest("hex");
        insert.run(
          `turn_${randomUUID()}`,
          input.taskId,
          turn.conversationId,
          turn.role,
          turn.roleId,
          turn.roleName,
          turn.chatTime,
          turn.chatTimeInferred ? 1 : 0,
          turn.content,
          contentHash,
          JSON.stringify(turn.toolCalls),
          now
        );
        const stored = storedTurn.get(turn.conversationId, turn.role, turn.chatTime, contentHash) as { turn_id: string };
        link.run(input.taskId, stored.turn_id);
      }
      return { task: this.getTask(input.taskId)!, created: true, pendingSpaceIds };
    })();
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM pm_tasks WHERE task_id = ?`).get(taskId) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  /** Records the result of one Space; the task settles once every Space has one. */
  recordSpaceOutcome(taskId: string, spaceId: string, outcome: SpaceOutcome, domains?: readonly string[]): TaskRecord | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM pm_tasks WHERE task_id = ?`).get(taskId) as TaskRow | undefined;
      if (!row) return undefined;
      const progress = JSON.parse(row.progress_json) as Record<string, SpaceProgress>;
      if (progress[spaceId] && progress[spaceId]!.status !== "running") return taskFromRow(row);
      const storedDomains = domains !== undefined ? [...domains].sort() : progress[spaceId]?.domains;
      progress[spaceId] = {
        status: outcome.status,
        memoryIds: outcome.memoryIds,
        added: outcome.added,
        updated: outcome.updated,
        deferredCount: outcome.deferredCount,
        error: outcome.error ?? null,
        ...(outcome.details ? { details: outcome.details } : {}),
        ...(storedDomains !== undefined ? { domains: storedDomains } : {})
      };
      const items = Object.values(progress);
      const settled = items.every((item) => item.status !== "running");
      const failed = items.find((item) => item.status === "failed");
      const status: TaskStatus = !settled ? "running" : failed ? "failed" : "completed";
      const memoryIds = [...new Set(items.flatMap((item) => item.memoryIds))];
      const deferred = items.reduce((sum, item) => sum + item.deferredCount, 0);
      this.db.prepare(
        `UPDATE pm_tasks
         SET status = ?, memory_ids_json = ?, deferred_count = ?, error_json = ?, progress_json = ?, updated_at = ?
         WHERE task_id = ?`
      ).run(
        status,
        JSON.stringify(memoryIds),
        deferred,
        failed?.error ? JSON.stringify(failed.error) : null,
        JSON.stringify(progress),
        this.now().toISOString(),
        taskId
      );
      return this.getTask(taskId);
    })();
  }

  /** Tasks that still wait on a Space; used by the local-queue teardown fence. */
  runningTaskIdsForSpace(spaceId: string): string[] {
    const rows = this.db.prepare(
      `SELECT task_id, progress_json FROM pm_tasks WHERE status = 'running' ORDER BY accepted_at, task_id`
    ).all() as Array<{ task_id: string; progress_json: string }>;
    return rows
      .filter((row) => (JSON.parse(row.progress_json) as Record<string, SpaceProgress>)[spaceId]?.status === "running")
      .map((row) => row.task_id);
  }

  taskTurns(taskId: string): RawTurnRecord[] {
    return (this.db.prepare(
      `SELECT t.* FROM pm_raw_turns t
       JOIN pm_task_turns l ON l.turn_id = t.turn_id
       WHERE l.task_id = ?
       ORDER BY t.chat_time, t.rowid`
    ).all(taskId) as TurnRow[]).map(turnFromRow);
  }

  /** The turns just before a batch, for M02 context (v3 §2.2.4). */
  contextTurns(conversationId: string, taskId: string, before: string, limit: number): RawTurnRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM pm_raw_turns
       WHERE conversation_id = ? AND chat_time <= ?
         AND turn_id NOT IN (SELECT turn_id FROM pm_task_turns WHERE task_id = ?)
       ORDER BY chat_time DESC, rowid DESC
       LIMIT ?`
    ).all(conversationId, before, taskId, limit) as TurnRow[];
    return rows.map(turnFromRow).reverse();
  }

  /** Latest role_name each member was submitted with, for reasons that name members. */
  roleName(roleId: string): string | null {
    const value = this.db.prepare(
      `SELECT role_name FROM pm_raw_turns
       WHERE role_id = ? AND role_name IS NOT NULL
       ORDER BY chat_time DESC, rowid DESC
       LIMIT 1`
    ).pluck().get(roleId);
    return typeof value === "string" ? value : null;
  }

  appendRecallLog(entries: RecallLogInput[]): void {
    if (entries.length === 0) return;
    this.db.transaction(() => {
      const nextSeq = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 FROM pm_recall_log WHERE conversation_id = ?`).pluck();
      const insert = this.db.prepare(
        `INSERT INTO pm_recall_log (conversation_id, seq, via, topic_id, decision_id, had_conflicts, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const ts = this.now().toISOString();
      for (const entry of entries) {
        const seq = Number(nextSeq.get(entry.conversationId));
        insert.run(entry.conversationId, seq, entry.via, entry.topicId, entry.decisionId, entry.hadConflicts ? 1 : 0, ts);
      }
    })();
  }

  /** Decisions whose conflicts were shown to this conversation (first half of the "informed" test). */
  conflictedDecisionsShown(conversationId: string): Set<string> {
    return new Set(this.db.prepare(
      `SELECT DISTINCT decision_id FROM pm_recall_log
       WHERE conversation_id = ? AND had_conflicts = 1 AND decision_id IS NOT NULL`
    ).pluck().all(conversationId) as string[]);
  }

  /** Decision ids and topic ids this conversation has been shown, in first-seen order. */
  recalledIds(conversationId: string): { decisionIds: string[]; topicIds: string[] } {
    const rows = this.db.prepare(
      `SELECT topic_id, decision_id FROM pm_recall_log WHERE conversation_id = ? ORDER BY seq`
    ).all(conversationId) as Array<{ topic_id: string; decision_id: string | null }>;
    const topicIds: string[] = [];
    const decisionIds: string[] = [];
    const seenTopics = new Set<string>();
    const seenDecisions = new Set<string>();
    for (const row of rows) {
      if (row.topic_id && !seenTopics.has(row.topic_id)) {
        seenTopics.add(row.topic_id);
        topicIds.push(row.topic_id);
      }
      if (row.decision_id && !seenDecisions.has(row.decision_id)) {
        seenDecisions.add(row.decision_id);
        decisionIds.push(row.decision_id);
      }
    }
    return { decisionIds, topicIds };
  }

  /**
   * Turns a completed task already organized for this Space and domain set (Q-27).
   * A failed task, another Space, or a different domain set does not qualify.
   * `exceptTaskId` is the batch currently running.
   */
  organizedTurnIds(spaceId: string, domains: readonly string[], turnIds: readonly string[], exceptTaskId: string): Set<string> {
    if (turnIds.length === 0) return new Set();
    const wanted = domainSetKey(domains);
    const rows = this.db.prepare(
      `SELECT l.turn_id AS turn_id, t.progress_json AS progress_json
       FROM pm_task_turns l
       JOIN pm_tasks t ON t.task_id = l.task_id
       WHERE l.turn_id IN (SELECT value FROM json_each(?))
         AND t.task_id != ?`
    ).all(JSON.stringify(turnIds), exceptTaskId) as Array<{ turn_id: string; progress_json: string }>;
    const organized = new Set<string>();
    for (const row of rows) {
      const progress = JSON.parse(row.progress_json) as Record<string, SpaceProgress>;
      const space = progress[spaceId];
      if (!space || space.status !== "completed") continue;
      if (domainSetKey(space.domains ?? []) !== wanted) continue;
      organized.add(row.turn_id);
    }
    return organized;
  }

  /**
   * Pending rows for one conversation and Space, oldest id first among the most recent `limit`.
   * `topic_unavailable` never comes back. When `clearedAt` is set, the producing task must have
   * been accepted at or after that fence.
   */
  pendingDeferred(
    conversationId: string,
    spaceId: string,
    options: { clearedAt: string | null; limit: number }
  ): PendingDeferred[] {
    const rows = this.db.prepare(
      `SELECT id, task_id, segment, reason FROM (
         SELECT d.id, d.task_id, d.segment, d.reason
         FROM pm_deferred_segments d
         JOIN pm_tasks t ON t.task_id = d.task_id
         WHERE d.conversation_id = ?
           AND d.space_id = ?
           AND d.reason != 'topic_unavailable'
           AND (? IS NULL OR t.accepted_at >= ?)
         ORDER BY d.id DESC
         LIMIT ?
       ) ORDER BY id ASC`
    ).all(
      conversationId,
      spaceId,
      options.clearedAt,
      options.clearedAt,
      options.limit
    ) as Array<{ id: number; task_id: string; segment: string; reason: string }>;
    return rows.map((row) => ({
      id: Number(row.id),
      taskId: row.task_id,
      text: row.segment,
      reason: row.reason
    }));
  }

  /**
   * Deletes consumed rows, leaves kept rows, and inserts new segments in one transaction.
   * A topic_unavailable replacement is a consumed id plus an appended row.
   */
  settleDeferred(input: {
    conversationId: string;
    spaceId: string;
    taskId: string;
    consumed: number[];
    kept: number[];
    appended: Array<{ text: string; reason: string }>;
  }): void {
    const kept = new Set(input.kept);
    const consumed = input.consumed.filter((id) => !kept.has(id));
    if (consumed.length === 0 && input.appended.length === 0) return;
    const now = this.now().toISOString();
    this.db.transaction(() => {
      if (consumed.length > 0) {
        this.db.prepare(
          `DELETE FROM pm_deferred_segments
           WHERE conversation_id = ? AND space_id = ? AND id IN (SELECT value FROM json_each(?))`
        ).run(input.conversationId, input.spaceId, JSON.stringify(consumed));
      }
      const insert = this.db.prepare(
        `INSERT INTO pm_deferred_segments (conversation_id, space_id, task_id, segment, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const segment of input.appended) {
        insert.run(input.conversationId, input.spaceId, input.taskId, segment.text, segment.reason, now);
      }
    })();
  }

  appendDeferred(input: { conversationId: string; spaceId: string; taskId: string; segments: Array<{ text: string; reason: string }> }): void {
    if (input.segments.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO pm_deferred_segments (conversation_id, space_id, task_id, segment, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const now = this.now().toISOString();
    this.db.transaction(() => {
      for (const segment of input.segments) insert.run(input.conversationId, input.spaceId, input.taskId, segment.text, segment.reason, now);
    })();
  }

  deferredSegments(conversationId: string, spaceId: string): Array<{ text: string; reason: string }> {
    return (this.db.prepare(
      `SELECT segment, reason FROM pm_deferred_segments WHERE conversation_id = ? AND space_id = ? ORDER BY id`
    ).all(conversationId, spaceId) as Array<{ segment: string; reason: string }>).map((row) => ({ text: row.segment, reason: row.reason }));
  }

  /** Drops every deferred row for one Space. Clear and delete both go through here. */
  forgetDeferred(spaceId: string): void {
    this.db.prepare(`DELETE FROM pm_deferred_segments WHERE space_id = ?`).run(spaceId);
  }

  forgetSpace(spaceId: string): void {
    this.forgetDeferred(spaceId);
  }
}

export interface PendingDeferred {
  id: number;
  taskId: string;
  text: string;
  reason: string;
}

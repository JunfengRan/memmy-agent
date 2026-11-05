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

type SpaceProgress = TaskRecord["spaces"][string] & { error?: TaskError | null };

export interface SpaceOutcome {
  status: Exclude<TaskStatus, "running">;
  memoryIds: string[];
  added: number;
  updated: number;
  deferredCount: number;
  error?: TaskError | null;
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
  ): { task: TaskRecord; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM pm_tasks WHERE batch_key = ?`).get(input.batchKey) as TaskRow | undefined;
      if (existing) return { task: taskFromRow(existing), created: false };
      const progress: Record<string, SpaceProgress> = {};
      for (const spaceId of input.spaceIds) {
        progress[spaceId] = { status: "running", memoryIds: [], added: 0, updated: 0, deferredCount: 0 };
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
      return { task: this.getTask(input.taskId)!, created: true };
    })();
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM pm_tasks WHERE task_id = ?`).get(taskId) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  /** Records the result of one Space; the task settles once every Space has one. */
  recordSpaceOutcome(taskId: string, spaceId: string, outcome: SpaceOutcome): TaskRecord | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM pm_tasks WHERE task_id = ?`).get(taskId) as TaskRow | undefined;
      if (!row) return undefined;
      const progress = JSON.parse(row.progress_json) as Record<string, SpaceProgress>;
      if (progress[spaceId] && progress[spaceId]!.status !== "running") return taskFromRow(row);
      progress[spaceId] = {
        status: outcome.status,
        memoryIds: outcome.memoryIds,
        added: outcome.added,
        updated: outcome.updated,
        deferredCount: outcome.deferredCount,
        error: outcome.error ?? null
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

  forgetSpace(spaceId: string): void {
    this.db.prepare(`DELETE FROM pm_deferred_segments WHERE space_id = ?`).run(spaceId);
  }
}

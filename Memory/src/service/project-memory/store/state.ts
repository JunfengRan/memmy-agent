import type { RawTurnInput, RawTurnRecord, TaskError, TaskRecord, TaskStatus } from "../contract/types.js";

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

export interface PendingDeferred {
  id: number;
  taskId: string;
  text: string;
  reason: string;
}

export interface CreateTaskInput {
  taskId: string;
  spaceIds: string[];
  conversationId: string;
  batchKey: string;
  sourceBatchId: string;
  acceptedAt: string;
}

export interface DeferredSettlement {
  conversationId: string;
  spaceId: string;
  taskId: string;
  consumed: number[];
  kept: number[];
  appended: Array<{ text: string; reason: string }>;
}

/** Durable pipeline state; neither callers nor this contract depend on SQLite. */
export interface ProjectPipelineState {
  createTask(input: CreateTaskInput, turns: RawTurnInput[]): { task: TaskRecord; created: boolean; pendingSpaceIds: string[] };
  getTask(taskId: string): TaskRecord | undefined;
  recordSpaceOutcome(taskId: string, spaceId: string, outcome: SpaceOutcome, domains?: readonly string[]): TaskRecord | undefined;
  runningTaskIdsForSpace(spaceId: string): string[];
  taskTurns(taskId: string): RawTurnRecord[];
  contextTurns(conversationId: string, taskId: string, before: string, limit: number): RawTurnRecord[];
  roleName(roleId: string): string | null;
  organizedTurnIds(spaceId: string, domains: readonly string[], turnIds: readonly string[], exceptTaskId: string): Set<string>;
  pendingDeferred(conversationId: string, spaceId: string, options: { clearedAt: string | null; limit: number }): PendingDeferred[];
  settleDeferred(input: DeferredSettlement): void;
  appendDeferred(input: { conversationId: string; spaceId: string; taskId: string; segments: Array<{ text: string; reason: string }> }): void;
  deferredSegments(conversationId: string, spaceId: string): Array<{ text: string; reason: string }>;
  forgetDeferred(spaceId: string): void;
  forgetSpace(spaceId: string): void;
}

export interface OrganizeTaskPayload {
  taskId: string;
  spaceId: string;
  domains: string[];
  agentId: string | null;
  conversationId: string | null;
  strippedBlocks?: number;
  unclosedBlocks?: number;
}

/** State and runtime must share a transaction domain; never await inside it. */
export interface ProjectTaskRuntime {
  transaction<T>(run: () => T): T;
  enqueue(spaceId: string, userId: string, payload: OrganizeTaskPayload, acceptedAt: string): void;
}

import { createMemoryLogger } from "../../../logging/logger.js";
import { ProjectMemoryError } from "../contract/errors.js";
import type { TaskError } from "../contract/types.js";
import type { SpaceOutcome } from "../store/state.js";
import { organizeSpace } from "./organize.js";
import { TaskFailure, type OrganizeJobPayload, type OrganizeJobDeps } from "./types.js";
export type { OrganizeJobPayload, OrganizeJobDeps } from "./types.js";

const log = createMemoryLogger("project-memory.organize");

/**
 * One Space of one add/message task (v3 §2.3.1).
 * Extract once from transcript evidence, then
 * recall one query per kept draft, assign from summary and description,
 * full-read only the topics M04 kept, judge, then merge deterministically.
 * TOPIC_SET_CHANGED repeats recall and M04. VERSION_CONFLICT repeats the judge.
 * Neither re-runs extraction. commitAttempts stays 3.
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

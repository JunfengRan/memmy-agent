import type { Repositories } from "../../../../storage/repositories.js";
import { newId } from "../../../../utils/id.js";
import { PROJECT_MEMORY_JOB_TYPE } from "../../pipeline/accept.js";
import type { ProjectTaskRuntime } from "../state.js";

/** Local host adapter: task state and scheduler jobs use the same SQLite transaction. */
export function createSqliteProjectTaskRuntime(repos: Repositories): ProjectTaskRuntime {
  return {
    transaction: (run) => repos.transaction(run),
    enqueue(spaceId, userId, payload, at) {
      const runtime = repos.runtime;
      const scopeKey = `project_memory:${spaceId}`;
      runtime.enqueueJobInTransaction({
        id: newId("job"),
        jobType: PROJECT_MEMORY_JOB_TYPE,
        status: "queued",
        dedupeKey: `${PROJECT_MEMORY_JOB_TYPE}:${payload.taskId}:${spaceId}`,
        userId,
        scopeKey,
        scopeSeq: runtime.nextScopeSeq(PROJECT_MEMORY_JOB_TYPE, scopeKey),
        payload: { ...payload },
        attempts: 0,
        maxAttempts: 3,
        leasedUntil: null,
        lastError: null,
        createdAt: at,
        updatedAt: at
      });
    }
  };
}

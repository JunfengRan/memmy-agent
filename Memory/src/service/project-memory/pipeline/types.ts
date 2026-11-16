import type { LlmClient } from "../../../model/types.js";
import type { TaskError } from "../contract/types.js";
import type { DecisionTopicRouter } from "../decisions/client.js";
import type { ProjectMemoryStore } from "../store/store.js";
import type { ProjectPipelineState, OrganizeTaskPayload } from "../store/state.js";

export type OrganizeJobPayload = OrganizeTaskPayload;

export interface OrganizeJobDeps {
  store: ProjectMemoryStore;
  local: ProjectPipelineState;
  llm: LlmClient;
  /** Opt-in topic choice. Absent on the default path, which never calls the decision model. */
  decision?: DecisionTopicRouter | null;
}

export class TaskFailure extends Error {
  constructor(readonly error: TaskError) {
    super(`${error.stage}: ${error.reason}`);
  }
}

export function fail(stage: TaskError["stage"], reason: string, detail?: string): never {
  throw new TaskFailure({ stage, reason, ...(detail ? { detail } : {}) });
}

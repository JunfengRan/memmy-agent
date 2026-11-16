import type { RawTurnInput, TaskRecord } from "../contract/types.js";
import type { CreateTaskInput, ProjectPipelineState, ProjectTaskRuntime } from "../store/state.js";

export const PROJECT_MEMORY_JOB_TYPE = "project_memory_organize" as const;

export interface AcceptProjectTaskInput {
  task: CreateTaskInput;
  turns: RawTurnInput[];
  userId: string;
  domains: string[];
  agentId: string | null;
  conversationId: string | null;
  strippedBlocks?: number;
  unclosedBlocks?: number;
}

/** Persist raw messages and every Space job together, or accept none of them. */
export function acceptProjectTask(
  input: AcceptProjectTaskInput,
  deps: { state: ProjectPipelineState; runtime: ProjectTaskRuntime }
): TaskRecord {
  return deps.runtime.transaction(() => {
    const { task, created, pendingSpaceIds } = deps.state.createTask(input.task, input.turns);
    if (!created) return task;
    for (const spaceId of pendingSpaceIds) {
      deps.runtime.enqueue(spaceId, input.userId, {
        taskId: input.task.taskId,
        spaceId,
        domains: input.domains,
        agentId: input.agentId,
        conversationId: input.conversationId,
        strippedBlocks: input.strippedBlocks,
        unclosedBlocks: input.unclosedBlocks
      }, input.task.acceptedAt);
    }
    return task;
  });
}

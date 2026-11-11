import { createHash, randomBytes } from "node:crypto";
import type { Embedder, LlmClient } from "../../model/types.js";
import type { EvolutionJobRecord, Repositories } from "../../storage/repositories.js";
import { newId } from "../../utils/id.js";
import { ProjectMemoryError } from "./contract/errors.js";
import type { DomainRecord, RawTurnInput, SpaceRecord, TaskRecord, TopicSnapshot } from "./contract/types.js";
import { collectTurns } from "./organize/collect.js";
import { runOrganizeJob, type OrganizeJobPayload } from "./pipeline/organize-job.js";
import { searchProjectMemory, type SearchInput, type SearchOutput } from "./retrieve/search.js";
import { ProjectLocalState } from "./store/sqlite/local-state.js";
import { SqliteProjectMemoryStore } from "./store/sqlite/sqlite-store.js";
import type { DomainUpdate, ProjectMemoryStore } from "./store/store.js";

export const PROJECT_MEMORY_JOB_TYPE = "project_memory_organize" as const;

export interface ProjectMemoryServiceDeps {
  repos: Repositories;
  llm: LlmClient;
  embedder?: Embedder | null;
  now?: () => Date;
  store?: ProjectMemoryStore;
}

export interface AddMessageInput {
  userId: string;
  agentId: string | null;
  conversationId: string | null;
  spaceIds: string[];
  domains: string[];
  messages: unknown;
  timezone: string | null;
}

/**
 * Facade over the project-memory modules. `memory-service.ts` and the HTTP
 * layer only delegate here.
 */
export class ProjectMemoryService {
  readonly store: ProjectMemoryStore;
  readonly local: ProjectLocalState;
  private readonly now: () => Date;

  constructor(private readonly deps: ProjectMemoryServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.store = deps.store ?? new SqliteProjectMemoryStore({ db: deps.repos.db, embedder: () => deps.embedder ?? null, now: this.now });
    this.local = new ProjectLocalState(deps.repos.db, this.now);
  }

  // ---------------------------------------------------------------- spaces

  async createSpace(input: { spaceName: string; instructions?: string | null; domains: DomainRecord[] }): Promise<SpaceRecord> {
    const spaceId = `space_${randomBytes(8).toString("hex")}`;
    const { space } = await this.store.createSpace({ ...input, spaceId });
    return space;
  }

  async getSpace(spaceId: string): Promise<SpaceRecord> {
    return this.requireSpace(spaceId);
  }

  async updateSpace(spaceId: string, input: { instructions?: string | null; spaceName?: string | null }): Promise<SpaceRecord> {
    await this.requireSpace(spaceId);
    return this.store.updateSpace(spaceId, input);
  }

  async deleteSpace(spaceId: string): Promise<void> {
    if (this.store.capabilities().teardownFence === "local_queue") {
      // Queued organize jobs for this Space settle now; when they run they find
      // the Space progress closed and write nothing.
      for (const taskId of this.local.runningTaskIdsForSpace(spaceId)) {
        this.local.recordSpaceOutcome(taskId, spaceId, {
          status: "failed",
          memoryIds: [],
          added: 0,
          updated: 0,
          deferredCount: 0,
          error: { stage: "validate", reason: "SPACE_GONE" }
        });
      }
    }
    await this.store.deleteSpace(spaceId);
    this.local.forgetSpace(spaceId);
  }

  // ---------------------------------------------------------------- domains

  async listDomains(spaceId: string): Promise<DomainRecord[]> {
    await this.requireSpace(spaceId);
    return this.store.listDomains(spaceId);
  }

  async createDomains(spaceId: string, domains: DomainRecord[]): Promise<DomainRecord[]> {
    await this.requireSpace(spaceId);
    return this.store.createDomains(spaceId, domains);
  }

  async updateDomains(spaceId: string, updates: DomainUpdate[]): Promise<DomainRecord[]> {
    await this.requireSpace(spaceId);
    return this.store.updateDomains(spaceId, updates);
  }

  async deleteDomains(spaceId: string, domains: string[]): Promise<DomainRecord[]> {
    await this.requireSpace(spaceId);
    return this.store.deleteDomains(spaceId, domains);
  }

  // ---------------------------------------------------------------- add / status

  async addMessage(input: AddMessageInput): Promise<TaskRecord> {
    await this.validateScope(input.spaceIds, input.domains, true);
    const now = this.now();
    const taskId = newId("task");
    const conversationKey = input.conversationId ?? `anon:${taskId}`;
    const turns = collectTurns(input.messages, {
      conversationId: conversationKey,
      userId: input.userId,
      timezone: input.timezone,
      now
    });
    const batchKey = input.conversationId ? this.batchKey(input, turns) : `anon:${taskId}`;
    const acceptedAt = now.toISOString();
    return this.deps.repos.transaction(() => {
      const { task, created } = this.local.createTask(
        { taskId, spaceIds: input.spaceIds, conversationId: conversationKey, batchKey, sourceBatchId: taskId, acceptedAt },
        turns
      );
      if (!created) return task;
      for (const spaceId of input.spaceIds) {
        const payload: OrganizeJobPayload = {
          taskId,
          spaceId,
          domains: input.domains,
          agentId: input.agentId,
          conversationId: input.conversationId
        };
        this.enqueue(spaceId, input.userId, payload, acceptedAt);
      }
      return task;
    });
  }

  getTask(taskId: string): TaskRecord {
    const task = this.local.getTask(taskId);
    if (!task) throw new ProjectMemoryError("TASK_NOT_FOUND", `task ${taskId} does not exist`, { task_id: taskId });
    return task;
  }

  /** Worker entry point for `project_memory_organize` jobs. */
  async processOrganizeJob(job: EvolutionJobRecord): Promise<void> {
    await runOrganizeJob(job.payload as unknown as OrganizeJobPayload, {
      store: this.store,
      local: this.local,
      llm: this.deps.llm
    });
  }

  // ---------------------------------------------------------------- read / search / delete

  async search(input: SearchInput): Promise<SearchOutput> {
    await this.validateScope(input.spaceIds, input.domains ?? [], false);
    return searchProjectMemory(input, { store: this.store, local: this.local, llm: this.deps.llm });
  }

  async listTopics(spaceId: string, page: number, size: number, relatedId?: string): Promise<{ topics: TopicSnapshot[]; total: number }> {
    await this.requireSpace(spaceId);
    return this.store.listTopics(spaceId, page, size, { relatedId });
  }

  async getTopic(topicId: string): Promise<TopicSnapshot> {
    const [topic] = await this.store.getTopicsFull(null, [topicId]);
    if (!topic) throw new ProjectMemoryError("TOPIC_NOT_FOUND", `topic ${topicId} does not exist`, { memory_id: topicId });
    return topic;
  }

  async clearSpace(spaceId: string): Promise<void> {
    await this.requireSpace(spaceId);
    await this.store.clearSpace(spaceId);
  }

  async deleteTopics(topicIds: string[]): Promise<string[]> {
    return this.store.deleteTopics(topicIds);
  }

  // ---------------------------------------------------------------- internals

  private async requireSpace(spaceId: string): Promise<SpaceRecord> {
    const space = await this.store.getSpace(spaceId);
    if (!space) throw new ProjectMemoryError("SPACE_NOT_FOUND", `space ${spaceId} does not exist`, { space_ids: [spaceId] });
    return space;
  }

  /** SDK spec: every listed Space must exist, and named domains must be registered in each of them. */
  private async validateScope(spaceIds: string[], domains: string[], forWrite: boolean): Promise<void> {
    const missing: string[] = [];
    const unregistered = new Set<string>();
    const unconfigured: string[] = [];
    for (const spaceId of spaceIds) {
      const space = await this.store.getSpace(spaceId);
      if (!space) {
        missing.push(spaceId);
        continue;
      }
      const registered = new Set((await this.store.listDomains(spaceId)).map((item) => item.domain));
      if (forWrite && registered.size === 0) unconfigured.push(spaceId);
      for (const domain of domains) if (!registered.has(domain)) unregistered.add(domain);
    }
    if (missing.length > 0) throw new ProjectMemoryError("SPACE_NOT_FOUND", "spaces do not exist", { space_ids: missing });
    if (unconfigured.length > 0) {
      throw new ProjectMemoryError("DOMAIN_NOT_CONFIGURED", "spaces have no registered domains", { space_ids: unconfigured });
    }
    if (unregistered.size > 0) {
      throw new ProjectMemoryError("DOMAIN_INVALID", "domains are not registered in every space", { domains: [...unregistered] });
    }
  }

  private batchKey(input: AddMessageInput, turns: RawTurnInput[]): string {
    const hash = createHash("sha256");
    hash.update(JSON.stringify([
      [...input.spaceIds].sort(),
      [...input.domains].sort(),
      input.conversationId,
      input.userId,
      input.agentId,
      turns.map((turn) => [turn.role, turn.roleId, turn.chatTimeInferred ? null : turn.chatTime, turn.content])
    ]));
    return hash.digest("hex");
  }

  private enqueue(spaceId: string, userId: string, payload: OrganizeJobPayload, at: string): void {
    const runtime = this.deps.repos.runtime;
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
}

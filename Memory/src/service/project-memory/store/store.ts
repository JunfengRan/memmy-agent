import type {
  ChangeSet,
  CommitResult,
  DomainRecord,
  RecallRequest,
  RecallResult,
  SpaceRecord,
  StoreCapabilities,
  TopicSnapshot
} from "../contract/types.js";

export interface DomainUpdate {
  domain: string;
  newDomain?: string;
  description?: string;
}

export interface ListTopicsFilter {
  relatedId?: string;
}

export interface CommitContext {
  /** Acceptance time of the message batch, compared with the Space create / clear time. */
  acceptedAt: string;
}

/**
 * v3 §5.1.2: everything that touches project data goes through this interface.
 * Callers branch on `capabilities()`, never on the deployment mode.
 */
export interface ProjectMemoryStore {
  capabilities(): StoreCapabilities;

  createSpace(input: {
    spaceId: string;
    spaceName?: string | null;
    instructions?: string | null;
    domains: DomainRecord[];
  }): Promise<{ space: SpaceRecord; created: boolean }>;
  getSpace(spaceId: string): Promise<SpaceRecord | undefined>;
  updateSpace(spaceId: string, input: { instructions?: string | null; spaceName?: string | null }): Promise<SpaceRecord>;
  deleteSpace(spaceId: string): Promise<void>;

  listDomains(spaceId: string): Promise<DomainRecord[]>;
  createDomains(spaceId: string, domains: DomainRecord[]): Promise<DomainRecord[]>;
  updateDomains(spaceId: string, updates: DomainUpdate[]): Promise<DomainRecord[]>;
  deleteDomains(spaceId: string, domains: string[]): Promise<DomainRecord[]>;

  recall(request: RecallRequest): Promise<RecallResult>;
  getTopicsFull(spaceId: string | null, topicIds: string[]): Promise<TopicSnapshot[]>;
  listTopics(spaceId: string, page: number, size: number, filter?: ListTopicsFilter): Promise<{ topics: TopicSnapshot[]; total: number }>;

  commitChangeSet(changeSet: ChangeSet, context: CommitContext): Promise<CommitResult>;
  /** L05: refresh topic vectors after a commit. Failures leave the topic lexical-only. */
  indexTopics(topicIds: string[]): Promise<void>;

  clearSpace(spaceId: string): Promise<void>;
  deleteTopics(topicIds: string[]): Promise<string[]>;
}

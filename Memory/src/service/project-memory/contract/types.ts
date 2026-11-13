/** Entities, ChangeSet and recall contracts (v3 §2.2.6, §2.2.8, §2.2.10, §5.1.2). */

export interface SpaceRecord {
  spaceId: string;
  spaceName: string | null;
  instructions: string | null;
  createTime: string;
  updateTime: string;
  clearedAt: string | null;
}

export interface DomainRecord {
  domain: string;
  description: string;
}

export interface EntryAuthorship {
  content: string;
  time: string;
  userIds: string[];
}

export interface DecisionConflict extends EntryAuthorship {
  seq: number;
}

export interface HistoryItem extends EntryAuthorship {
  seq: number;
  reason: string | null;
}

export interface DecisionSnapshot extends EntryAuthorship {
  id: string;
  conflicts: DecisionConflict[];
  history: HistoryItem[];
}

export interface ExperienceSnapshot extends EntryAuthorship {
  id: string;
  history: HistoryItem[];
}

export interface TimelineSnapshot extends EntryAuthorship {
  id: string;
}

export interface SourceRef {
  userId: string;
  agentId: string | null;
  conversationId: string | null;
}

/** L02 full read: every decision, experience and timeline entry of one topic. */
export interface TopicSnapshot {
  topicId: string;
  spaceId: string;
  domain: string;
  topicName: string;
  topicSummary: string;
  topicDescription: string;
  revision: number;
  createTime: string;
  updateTime: string;
  decisions: DecisionSnapshot[];
  experiences: ExperienceSnapshot[];
  timeline: TimelineSnapshot[];
  sources: SourceRef[];
}

export type DecisionTarget = "content" | `conflict:${number}`;

export type DecisionOp =
  | { op: "add"; decisionId: string; content: string; time: string; userIds: string[]; reason?: string | null }
  | { op: "join"; decisionId: string; target: DecisionTarget; userIds: string[] }
  | { op: "rewrite"; decisionId: string; content: string; time: string; userIds: string[]; reason?: string | null }
  | { op: "conflict_append"; decisionId: string; content: string; time: string; userIds: string[] }
  | { op: "conflict_update"; decisionId: string; target: `conflict:${number}`; content: string; time: string; userIds: string[] }
  | {
      op: "resolve";
      decisionId: string;
      target: DecisionTarget | "new";
      content?: string;
      time?: string;
      userIds?: string[];
      reason: string;
    }
  /** PM-14 proposal: one piece keeps `decisionId`; each piece archives the current content and every conflict. */
  | {
      op: "split";
      decisionId: string;
      reason: string;
      splitInto: Array<{ decisionId: string; content: string; time: string; userIds: string[] }>;
    };

export type ExperienceOp =
  | { op: "add"; experienceId: string; content: string; time: string; userIds: string[] }
  | { op: "join"; experienceId: string; time: string; userIds: string[] }
  | { op: "update"; experienceId: string; content: string; time: string; userIds: string[]; reason?: string | null }
  | { op: "history_backfill"; experienceId: string; content: string; time: string; userIds: string[] };

export interface TimelineAppend {
  timelineId: string;
  content: string;
  time: string;
  userIds: string[];
}

export interface TopicChange {
  op: "create" | "update";
  topicId: string;
  domain: string;
  expectedRevision?: number;
  expectedTopicSeq?: number;
  topicName?: string;
  topicSummary?: string;
  topicDescription?: string;
  decisions: DecisionOp[];
  experiences: ExperienceOp[];
  timelineAppend: TimelineAppend[];
  sourcesAppend: Array<{ userIds: string[]; agentId: string | null; conversationId: string | null }>;
}

/** The single unit written back by L03 / C04. */
export interface ChangeSet {
  spaceId: string;
  taskId: string;
  sourceBatchId: string;
  idempotencyKey: string;
  topics: TopicChange[];
}

export type CommitResult =
  | { ok: true; replayed: boolean; topics: Array<{ topicId: string; revision: number; updateTime: string }> }
  | {
      ok: false;
      error: "VERSION_CONFLICT";
      topics: Array<{ topicId: string; expectedRevision: number; currentRevision: number }>;
    }
  | {
      ok: false;
      error: "TOPIC_SET_CHANGED";
      domain: string;
      expectedTopicSeq: number;
      currentTopicSeq: number;
      newTopicIds: string[];
    }
  | { ok: false; error: "TOPIC_NOT_FOUND"; topicIds: string[] }
  | { ok: false; error: "DOMAIN_INVALID"; domains: string[] }
  | { ok: false; error: "SPACE_GONE" }
  | { ok: false; error: "SPACE_CLEARED"; clearedAt: string };

export interface RecallQuery {
  qid: string;
  text: string;
}

export interface RecallRequest {
  spaceIds: string[];
  domains?: string[];
  queries: RecallQuery[];
  purpose: "search" | "merge";
  preferConversationId?: string;
  topicK: number;
  entryK: number;
}

export interface RecallScores {
  lexical: number | null;
  vector: number | null;
}

export interface RecallEntry {
  kind: "decision" | "experience" | "timeline";
  id: string;
  scores: RecallScores;
}

export interface RecallTopic {
  topicId: string;
  spaceId: string;
  revision: number;
  domain: string;
  topicName: string;
  topicSummary: string;
  topicDescription: string;
  updateTime: string;
  hasConversation: boolean;
  scores: RecallScores;
  entries: RecallEntry[];
}

export interface RecallResult {
  results: Array<{ qid: string; topics: RecallTopic[] }>;
  topicSeq: Record<string, number>;
  degraded: string[];
}

export interface StoreCapabilities {
  fullText: "fts5" | "remote";
  vector: "sqlite-vec" | "remote" | "none";
  conditionalWrite: true;
  teardownFence: "server_clock" | "local_queue";
  embeddingModel: string | null;
  embeddingDim: number | null;
}

export type TaskStatus = "running" | "completed" | "failed";

export interface TaskError {
  stage: "validate" | "organize" | "merge" | "commit";
  reason: string;
  detail?: string;
}

export interface TaskRecord {
  taskId: string;
  spaceIds: string[];
  conversationId: string;
  batchKey: string;
  acceptedAt: string;
  status: TaskStatus;
  memoryIds: string[];
  added: number;
  updated: number;
  deferredCount: number;
  error: TaskError | null;
  /** Per-space progress; the task completes when every space is done. */
  spaces: Record<string, { status: TaskStatus; memoryIds: string[]; added: number; updated: number; deferredCount: number }>;
}

export interface RawTurnInput {
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  roleId: string | null;
  roleName: string | null;
  chatTime: string;
  chatTimeInferred: boolean;
  content: string;
  toolCalls: Array<{ name: string; arguments: unknown }>;
}

export interface RawTurnRecord extends RawTurnInput {
  turnId: string;
  taskId: string;
}

export interface RecallLogInput {
  conversationId: string;
  via: "session_start" | "turn_start" | "tool";
  topicId: string;
  decisionId: string | null;
  hadConflicts: boolean;
}

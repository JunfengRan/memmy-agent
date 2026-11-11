import { priorityFor } from "../../../algorithm/plugin-algorithms.js";
import { createMemoryLogger, memoryErrorFields } from "../../../logging/logger.js";
import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { RecallEntry, RecallTopic, TopicSnapshot } from "../contract/types.js";
import type { DecisionTopicRouter } from "../decisions/client.js";
import { briefFromTopic, orderSearchByJev } from "../decisions/topic-choice.js";
import type { ProjectMemoryStore } from "../store/store.js";
import { uniqueTokens } from "../text.js";
import { timeMs } from "../time.js";
import { RRF_K } from "./fuse.js";

export { assignRelativity } from "./fuse.js";

/**
 * Project-path ranking for M09. Lexical and vector ranks are fused with RRF,
 * then recency (against the newest candidate, not the wall clock) and a
 * same-conversation boost. There is no MMR on this path. An opt-in OpenAI
 * Decisions selector may move one topic to rank 1 and is absent unless
 * MEMMY_DECISION_TOPIC=1 (ADR-0006). Cross-path fusion lives in fuse.ts.
 * A topic with no snapshot is dropped here, before fusion.
 */
/** Which local recall paths M08 should run. Omitted HTTP views become user memory plus L1 and Skill. */
export interface MemoryViewSelection {
  userMemory: boolean;
  /** `detail_factual` is L1, `skill` is Skill. Empty means path ② was not requested. */
  agentLayers: Array<"L1" | "Skill">;
  project: boolean;
}

export interface SearchInput {
  userId: string;
  spaceIds: string[];
  domains?: string[];
  query: string;
  conversationId?: string;
  memoryLimit: number;
  relativity?: number;
  views: MemoryViewSelection;
  /** Recall-log entry. HTTP `recall_via` maps here; omitted means turn_start (ADR-0008). */
  via?: "turn_start" | "tool";
}

export interface SearchEntryView {
  content: string;
  time: string;
  user_ids: string[];
  history?: Array<{ content: string; time: string; user_ids: string[]; reason: string | null }>;
  conflicts?: Array<{ content: string; time: string; user_ids: string[] }>;
}

export interface SearchTopicView {
  id: string;
  space_id: string;
  domain: string;
  topic_name: string;
  topic_summary: string;
  topic_description: string;
  decisions: SearchEntryView[];
  experiences: SearchEntryView[];
  timeline: SearchEntryView[];
  relativity: number;
  update_time: string;
}

export interface RankedProjectCandidate {
  id: string;
  rank: number;
  text: string;
  entries: RecallEntry[];
  snapshot: TopicSnapshot;
}

const log = createMemoryLogger("project-memory.search");

const RECENCY_HALF_LIFE_DAYS = 14;
const RECENCY_WEIGHT = 0.15;
const CONVERSATION_WEIGHT = 0.1;

export interface ScoredEntry {
  entry: RecallEntry;
  lexical: number | null;
  kept: boolean;
}

export interface ScoredProjectTopic {
  topic: RecallTopic;
  entries: RecallEntry[];
  entryScores: ScoredEntry[];
  lexicalRank: number | null;
  vectorRank: number | null;
  rrf: number;
  recency: number;
  conversationBoost: number;
  fused: number;
  minEntryHits: number;
  queryTokenCount: number;
}

function rankMap(topics: readonly RecallTopic[], channel: "lexical" | "vector"): Map<string, number> {
  const scored = topics
    .filter((topic) => topic.scores[channel] !== null)
    .sort((left, right) => (right.scores[channel]! - left.scores[channel]!) || left.topicId.localeCompare(right.topicId));
  return new Map(scored.map((topic, index) => [topic.topicId, index + 1]));
}

function compareTopicId(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function topicText(topic: RecallTopic): string {
  return `${topic.topicName}\n${topic.topicSummary}\n${topic.topicDescription}`;
}

function entryView(entry: { content: string; time: string; userIds: string[] }): SearchEntryView {
  return { content: entry.content, time: entry.time, user_ids: entry.userIds };
}

function topicView(snapshot: TopicSnapshot, entries: RecallEntry[], relativity: number): SearchTopicView {
  const wanted = new Set(entries.map((entry) => entry.id));
  return {
    id: snapshot.topicId,
    space_id: snapshot.spaceId,
    domain: snapshot.domain,
    topic_name: snapshot.topicName,
    topic_summary: snapshot.topicSummary,
    topic_description: snapshot.topicDescription,
    decisions: snapshot.decisions.filter((decision) => wanted.has(decision.id)).map((decision) => ({
      ...entryView(decision),
      ...(decision.history.length > 0
        ? { history: decision.history.map((item) => ({ ...entryView(item), reason: item.reason })) }
        : {}),
      ...(decision.conflicts.length > 0 ? { conflicts: decision.conflicts.map(entryView) } : {})
    })),
    experiences: snapshot.experiences.filter((experience) => wanted.has(experience.id)).map(entryView),
    timeline: snapshot.timeline.filter((item) => wanted.has(item.id)).map(entryView),
    relativity,
    update_time: snapshot.updateTime
  };
}

export function projectTopicView(candidate: RankedProjectCandidate, relativity: number): SearchTopicView {
  return topicView(candidate.snapshot, candidate.entries, relativity);
}

/** Same ordering rankProjectCandidates uses before the optional Decisions move. */
export function scoreProjectTopics(query: string, topics: readonly RecallTopic[], options?: { keepZero?: boolean }): ScoredProjectTopic[] {
  const queryTokens = uniqueTokens(query);
  const lexicalRanks = rankMap(topics, "lexical");
  const vectorRanks = rankMap(topics, "vector");
  const newest = topics.length ? Math.max(...topics.map((topic) => timeMs(topic.updateTime))) : 0;
  const minEntryHits = Math.max(1, Math.ceil(queryTokens.length * 0.2));
  const scored = topics.map((topic) => {
    const lexicalRank = lexicalRanks.get(topic.topicId) ?? null;
    const vectorRank = vectorRanks.get(topic.topicId) ?? null;
    const rrf = (lexicalRank ? 1 / (RRF_K + lexicalRank) : 0) + (vectorRank ? 1 / (RRF_K + vectorRank) : 0);
    const recency = priorityFor(1, timeMs(topic.updateTime), RECENCY_HALF_LIFE_DAYS, newest);
    const conversationBoost = topic.hasConversation ? CONVERSATION_WEIGHT : 0;
    const fused = rrf * (1 + RECENCY_WEIGHT * recency + conversationBoost);
    const entryScores = topic.entries.map((entry) => {
      const lexical = entry.scores.lexical;
      const kept = (lexical ?? 0) * queryTokens.length >= minEntryHits - 1e-9;
      return { entry, lexical, kept };
    });
    return {
      topic,
      entries: entryScores.filter((item) => item.kept).map((item) => item.entry),
      entryScores,
      lexicalRank,
      vectorRank,
      rrf,
      recency,
      conversationBoost,
      fused,
      minEntryHits,
      queryTokenCount: queryTokens.length
    };
  });
  const visible = options?.keepZero ? scored : scored.filter((candidate) => candidate.fused > 0);
  return visible.sort((left, right) => right.fused - left.fused || compareTopicId(left.topic.topicId, right.topic.topicId));
}

export async function rankProjectCandidates(
  input: SearchInput,
  deps: { store: ProjectMemoryStore; decision?: DecisionTopicRouter | null }
): Promise<{ candidates: RankedProjectCandidate[]; degraded: string[] }> {
  const recall = await deps.store.recall({
    spaceIds: input.spaceIds,
    domains: input.domains,
    queries: [{ qid: "q", text: input.query }],
    purpose: "search",
    preferConversationId: input.conversationId,
    topicK: Math.max(PROJECT_MEMORY_LIMITS.topicK, input.memoryLimit * 2),
    entryK: PROJECT_MEMORY_LIMITS.entryK
  });
  const topics = recall.results[0]?.topics ?? [];
  if (topics.length === 0) return { candidates: [], degraded: recall.degraded };

  const scored = scoreProjectTopics(input.query, topics);
  const ordered = await moveOptionalJev(input.query, scored, deps);
  if (ordered.length === 0) return { candidates: [], degraded: recall.degraded };
  const snapshots = new Map((await deps.store.getTopicsFull(null, ordered.map((item) => item.topic.topicId)))
    .map((snapshot) => [snapshot.topicId, snapshot]));
  const available = ordered.flatMap((item) => {
    const snapshot = snapshots.get(item.topic.topicId);
    return snapshot ? [{ item, snapshot }] : [];
  });
  return {
    degraded: recall.degraded,
    candidates: available.map(({ item, snapshot }, index) => ({
      id: snapshot.topicId,
      rank: index + 1,
      text: topicText(item.topic),
      entries: item.entries,
      snapshot
    }))
  };
}

async function moveOptionalJev(
  query: string,
  ordered: ScoredProjectTopic[],
  deps: { decision?: DecisionTopicRouter | null }
): Promise<ScoredProjectTopic[]> {
  if (!deps.decision || ordered.length === 0) return ordered;
  try {
    const choice = await deps.decision.chooseSearch({
      query,
      topics: ordered.map((candidate) => briefFromTopic(candidate.topic))
    });
    const moved = orderSearchByJev(ordered, ordered, choice, ordered.length, (candidate) => candidate.topic.topicId);
    log.info("decision.search", { choice: choice.choice, confidence: choice.confidence, pool: ordered.length });
    return moved;
  } catch (error) {
    log.warn("decision.search.failed", memoryErrorFields(error));
    return ordered;
  }
}

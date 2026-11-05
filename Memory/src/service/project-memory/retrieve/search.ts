import { priorityFor } from "../../../algorithm/plugin-algorithms.js";
import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { RecallEntry, RecallLogInput, RecallTopic, TopicSnapshot } from "../contract/types.js";
import type { ProjectLocalState } from "../store/sqlite/local-state.js";
import type { ProjectMemoryStore } from "../store/store.js";
import { textTokens, tokenOverlap, uniqueTokens } from "../text.js";
import { timeMs } from "../time.js";

/**
 * M09 (local): fuse lexical and vector ranks with RRF, boost recent and
 * same-conversation topics, de-duplicate with MMR, trim entries, attach the full
 * decision history and conflicts. No model rerank: equal input, equal output.
 */
export interface SearchInput {
  spaceIds: string[];
  domains?: string[];
  query: string;
  conversationId?: string;
  memoryLimit: number;
  relativity?: number;
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

export interface SearchOutput {
  topics: SearchTopicView[];
  degraded: string[];
}

const RRF_K = 60;
const RECENCY_HALF_LIFE_DAYS = 14;
const RECENCY_WEIGHT = 0.15;
const CONVERSATION_WEIGHT = 0.1;
const MMR_LAMBDA = 0.7;

interface Candidate {
  topic: RecallTopic;
  entries: RecallEntry[];
  fused: number;
  relevance: number;
  tokens: Set<string>;
}

function rankMap(topics: RecallTopic[], channel: "lexical" | "vector"): Map<string, number> {
  const scored = topics
    .filter((topic) => topic.scores[channel] !== null)
    .sort((left, right) => (right.scores[channel]! - left.scores[channel]!) || left.topicId.localeCompare(right.topicId));
  return new Map(scored.map((topic, index) => [topic.topicId, index + 1]));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function mmr(candidates: Candidate[], limit: number): Candidate[] {
  const pool = [...candidates];
  const chosen: Candidate[] = [];
  const top = Math.max(...pool.map((item) => item.fused), Number.EPSILON);
  while (chosen.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    pool.forEach((candidate, index) => {
      const redundancy = chosen.length === 0 ? 0 : Math.max(...chosen.map((item) => jaccard(item.tokens, candidate.tokens)));
      const score = MMR_LAMBDA * (candidate.fused / top) - (1 - MMR_LAMBDA) * redundancy;
      const best = pool[bestIndex]!;
      if (score > bestScore || (score === bestScore && candidate.topic.topicId < best.topic.topicId)) {
        bestScore = score;
        bestIndex = index;
      }
    });
    chosen.push(pool.splice(bestIndex, 1)[0]!);
  }
  return chosen;
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

export async function searchProjectMemory(
  input: SearchInput,
  deps: { store: ProjectMemoryStore; local: ProjectLocalState }
): Promise<SearchOutput> {
  const queryTokens = uniqueTokens(input.query);
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
  if (topics.length === 0) return { topics: [], degraded: recall.degraded };

  const lexicalRanks = rankMap(topics, "lexical");
  const vectorRanks = rankMap(topics, "vector");
  const newest = Math.max(...topics.map((topic) => timeMs(topic.updateTime)));
  const minEntryHits = Math.max(1, Math.ceil(queryTokens.length * 0.2));

  const candidates: Candidate[] = topics.map((topic) => {
    const lexicalRank = lexicalRanks.get(topic.topicId);
    const vectorRank = vectorRanks.get(topic.topicId);
    const rrf = (lexicalRank ? 1 / (RRF_K + lexicalRank) : 0) + (vectorRank ? 1 / (RRF_K + vectorRank) : 0);
    // Recency is measured against the newest candidate, not the wall clock, so the
    // same data ranks the same way whenever it is queried.
    const recency = priorityFor(1, timeMs(topic.updateTime), RECENCY_HALF_LIFE_DAYS, newest);
    const fused = rrf * (1 + RECENCY_WEIGHT * recency + (topic.hasConversation ? CONVERSATION_WEIGHT : 0));
    const entries = topic.entries.filter((entry) => (entry.scores.lexical ?? 0) * queryTokens.length >= minEntryHits - 1e-9);
    const lexicalRelevance = Math.max(tokenOverlap(queryTokens, topicText(topic)), ...entries.map((entry) => entry.scores.lexical ?? 0));
    const vectorRelevance = topic.scores.vector === null ? 0 : Math.max(0, Math.min(1, topic.scores.vector));
    return {
      topic,
      entries,
      fused,
      relevance: Math.max(lexicalRelevance, vectorRelevance),
      tokens: new Set(textTokens(topicText(topic)))
    };
  }).filter((candidate) => candidate.fused > 0);

  const selected = mmr(candidates, Math.min(input.memoryLimit, PROJECT_MEMORY_LIMITS.memoryLimitMax));
  let ceiling = 1;
  const scored = selected.map((candidate) => {
    ceiling = Math.min(ceiling, candidate.relevance);
    return { candidate, relativity: Math.round(ceiling * 10_000) / 10_000 };
  }).filter((item) => input.relativity === undefined || item.relativity >= input.relativity);

  const snapshots = new Map((await deps.store.getTopicsFull(null, scored.map((item) => item.candidate.topic.topicId)))
    .map((snapshot) => [snapshot.topicId, snapshot]));
  const views: SearchTopicView[] = [];
  const log: RecallLogInput[] = [];
  for (const { candidate, relativity } of scored) {
    const snapshot = snapshots.get(candidate.topic.topicId);
    if (!snapshot) continue;
    const view = topicView(snapshot, candidate.entries, relativity);
    views.push(view);
    if (input.conversationId) {
      log.push({ conversationId: input.conversationId, via: "turn_start", topicId: snapshot.topicId, decisionId: null, hadConflicts: false });
      for (const decision of snapshot.decisions) {
        if (!candidate.entries.some((entry) => entry.id === decision.id)) continue;
        log.push({
          conversationId: input.conversationId,
          via: "turn_start",
          topicId: snapshot.topicId,
          decisionId: decision.id,
          hadConflicts: decision.conflicts.length > 0
        });
      }
    }
  }
  deps.local.appendRecallLog(log);
  return { topics: views, degraded: recall.degraded };
}

import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { RecallResult, RecallTopic, TopicSnapshot } from "../contract/types.js";
import type { ProjectMemoryStore } from "../store/store.js";

/** Summary and description of one merge candidate. The name stays local so M04 never sees it. */
export interface MergeCandidate {
  topicId: string;
  domain: string;
  topicName: string;
  topicSummary: string;
  topicDescription: string;
}

export interface RankedHit {
  topicId: string;
  rank: number;
}

/**
 * Union per-draft recall lists by the best (lowest) rank. The cap drops the
 * worst ranks. mustConsider ids stay even when they lose the cap or never
 * appeared in a query (v3 §2.3.1, ADR-0007).
 */
export function unionCandidates(
  queries: readonly (readonly RankedHit[])[],
  mustConsider: ReadonlySet<string>,
  cap: number = PROJECT_MEMORY_LIMITS.mergeCandidateCap
): string[] {
  const best = new Map<string, number>();
  for (const query of queries) {
    for (const hit of query) {
      if (!hit.topicId) continue;
      const prior = best.get(hit.topicId);
      if (prior === undefined || hit.rank < prior) best.set(hit.topicId, hit.rank);
    }
  }
  const ranked = [...best.entries()].sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]));
  const limit = Math.max(0, cap);
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const [topicId] of ranked) {
    if (kept.length >= limit) break;
    kept.push(topicId);
    seen.add(topicId);
  }
  for (const topicId of mustConsider) {
    if (!topicId || seen.has(topicId)) continue;
    kept.push(topicId);
    seen.add(topicId);
  }
  return kept;
}

export function candidateFromRecall(topic: RecallTopic): MergeCandidate {
  return {
    topicId: topic.topicId,
    domain: topic.domain,
    topicName: topic.topicName,
    topicSummary: topic.topicSummary,
    topicDescription: topic.topicDescription
  };
}

export function candidateFromSnapshot(topic: TopicSnapshot): MergeCandidate {
  return {
    topicId: topic.topicId,
    domain: topic.domain,
    topicName: topic.topicName,
    topicSummary: topic.topicSummary,
    topicDescription: topic.topicDescription
  };
}

/**
 * One recall row per query, unioned and capped. Topics that must be reconsidered
 * but lost the rank (or were created after the recall) are loaded for their
 * summary and description only; M04 is not given their entries.
 */
export async function resolveMergeCandidates(
  store: ProjectMemoryStore,
  spaceId: string,
  recall: RecallResult,
  mustConsider: ReadonlySet<string>
): Promise<MergeCandidate[]> {
  const ids = unionCandidates(
    recall.results.map((result) => result.topics.map((topic, rank) => ({ topicId: topic.topicId, rank }))),
    mustConsider
  );
  const pool = new Map<string, MergeCandidate>();
  for (const result of recall.results) {
    for (const topic of result.topics) {
      if (!pool.has(topic.topicId)) pool.set(topic.topicId, candidateFromRecall(topic));
    }
  }
  const missing = ids.filter((id) => !pool.has(id));
  if (missing.length > 0) {
    const snapshots = await store.getTopicsFull(spaceId, missing);
    for (const snapshot of snapshots) pool.set(snapshot.topicId, candidateFromSnapshot(snapshot));
  }
  return ids.flatMap((id) => {
    const topic = pool.get(id);
    return topic ? [topic] : [];
  });
}

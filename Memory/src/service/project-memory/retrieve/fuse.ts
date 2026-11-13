import { textTokens } from "../text.js";

/**
 * M09 cross-path fusion (v3 §3.2.5, §3.5). Rank only: `1/(k+rank)`.
 * No raw scores, no clock, and no model. Project-path lexical/vector RRF
 * imports this same `k` so the constant lives in one place (Q-01).
 */
export const RRF_K = 60;

const MMR_OWN_WEIGHT = 0.7;
const MMR_REDUNDANCY_WEIGHT = 0.3;

const PATH_ORDER = { user_memory: 0, agent_memory: 1, project: 2 } as const;

export type FusePath = keyof typeof PATH_ORDER;

export interface FuseCandidate {
  id: string;
  path: FusePath;
  /** 1-based rank inside the path. User and agent ranks are recall order. */
  rank: number;
  /** Project topics use topic text; the other paths use content. */
  text: string;
}

export interface FusedHit {
  id: string;
  path: FusePath;
  relativity: number;
}

/**
 * Round each item's own relevance to 4 decimals, optionally drop those below
 * `threshold`, then show the running minimum so a returned list never rises.
 * Search filters on own relevance before MMR and calls this without a threshold.
 */
export function assignRelativity<T extends { relevance: number }>(
  selected: readonly T[],
  threshold?: number
): Array<{ item: T; relativity: number }> {
  let ceiling = 1;
  return selected
    .map((item) => ({ item, own: Math.round(item.relevance * 10_000) / 10_000 }))
    .filter(({ own }) => threshold === undefined || own >= threshold)
    .map(({ item, own }) => {
      ceiling = Math.min(ceiling, own);
      return { item, relativity: ceiling };
    });
}

interface Scored {
  id: string;
  path: FusePath;
  rank: number;
  own: number;
  fused: number;
  order: number;
  tokens: Set<string>;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function compareId(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Fuse already-ranked paths. `limit` is the combined cap; each project topic
 * is one item. Own relativity is `fused / maxFused` in the whole pool, rounded
 * to 4 decimals, and the threshold drops items before MMR.
 */
export function fuseRanked(candidates: readonly FuseCandidate[], options: { limit: number; relativity?: number }): FusedHit[] {
  if (candidates.length === 0 || options.limit <= 0) return [];
  const scored: Scored[] = candidates.map((candidate) => ({
    id: candidate.id,
    path: candidate.path,
    rank: candidate.rank,
    fused: 1 / (RRF_K + candidate.rank),
    own: 0,
    order: 0,
    tokens: new Set(textTokens(candidate.text))
  }));
  scored.sort((left, right) => (
    right.fused - left.fused
    || PATH_ORDER[left.path] - PATH_ORDER[right.path]
    || left.rank - right.rank
    || compareId(left.id, right.id)
  ));
  const maxFused = Math.max(...scored.map((item) => item.fused));
  for (const [index, item] of scored.entries()) {
    item.own = round4(item.fused / maxFused);
    item.order = index;
  }
  const threshold = options.relativity;
  const pool = scored.filter((item) => threshold === undefined || item.own >= threshold);
  const chosen = mmr(pool, options.limit);
  return assignRelativity(chosen.map((item) => ({ id: item.id, path: item.path, relevance: item.own })))
    .map(({ item, relativity }) => ({ id: item.id, path: item.path, relativity }));
}

function mmr(pool: Scored[], limit: number): Scored[] {
  const remaining = [...pool];
  const chosen: Scored[] = [];
  while (chosen.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    let bestOrder = Infinity;
    remaining.forEach((candidate, index) => {
      const redundancy = chosen.length === 0
        ? 0
        : Math.max(...chosen.map((item) => jaccard(item.tokens, candidate.tokens)));
      const score = MMR_OWN_WEIGHT * candidate.own - MMR_REDUNDANCY_WEIGHT * redundancy;
      if (score > bestScore || (score === bestScore && candidate.order < bestOrder)) {
        bestScore = score;
        bestOrder = candidate.order;
        bestIndex = index;
      }
    });
    chosen.push(remaining.splice(bestIndex, 1)[0]!);
  }
  return chosen;
}

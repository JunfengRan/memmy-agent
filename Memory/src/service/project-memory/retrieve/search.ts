import type { LlmClient } from "../../../model/types.js";
import { ProjectMemoryError } from "../contract/errors.js";
import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { RecallLogInput, TopicSnapshot } from "../contract/types.js";
import { loadSessionCards, routeRetrieve } from "../route/router.js";
import type { ProjectLocalState } from "../store/sqlite/local-state.js";
import type { ProjectMemoryStore } from "../store/store.js";

/**
 * Search returns the sessions the router selects, in that order, with every
 * entry. Topic choice is the router's retrieve decision; entry text is not reranked.
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

function entryView(entry: { content: string; time: string; userIds: string[] }): SearchEntryView {
  return { content: entry.content, time: entry.time, user_ids: entry.userIds };
}

function topicView(snapshot: TopicSnapshot, relativity: number): SearchTopicView {
  return {
    id: snapshot.topicId,
    space_id: snapshot.spaceId,
    domain: snapshot.domain,
    topic_name: snapshot.topicName,
    topic_summary: snapshot.topicSummary,
    topic_description: snapshot.topicDescription,
    decisions: snapshot.decisions.map((decision) => ({
      ...entryView(decision),
      ...(decision.history.length > 0
        ? { history: decision.history.map((item) => ({ ...entryView(item), reason: item.reason })) }
        : {}),
      ...(decision.conflicts.length > 0 ? { conflicts: decision.conflicts.map(entryView) } : {})
    })),
    experiences: snapshot.experiences.map((experience) => ({
      ...entryView(experience),
      ...(experience.history.length > 0
        ? { history: experience.history.map((item) => ({ ...entryView(item), reason: item.reason })) }
        : {})
    })),
    timeline: snapshot.timeline.map(entryView),
    relativity,
    update_time: snapshot.updateTime
  };
}

function relativityAt(index: number, count: number): number {
  if (count <= 1) return 1;
  return Math.round((1 - index / (count - 1)) * 10_000) / 10_000;
}

export async function searchProjectMemory(
  input: SearchInput,
  deps: { store: ProjectMemoryStore; local: ProjectLocalState; llm: LlmClient }
): Promise<SearchOutput> {
  const sessions = await loadSessionCards(deps.store, input.spaceIds, input.domains);
  if (sessions.length === 0) return { topics: [], degraded: [] };
  if (!deps.llm.isConfigured()) {
    throw new ProjectMemoryError("STORE_UNAVAILABLE", "project memory router model is not configured");
  }
  let topicIds: string[];
  try {
    topicIds = (await routeRetrieve(deps.llm, { query: input.query, sessions })).topicIds;
  } catch (error) {
    throw new ProjectMemoryError("STORE_UNAVAILABLE", error instanceof Error ? error.message : String(error));
  }
  const ids = topicIds.slice(0, Math.min(input.memoryLimit, PROJECT_MEMORY_LIMITS.memoryLimitMax));
  const snapshots = new Map((await deps.store.getTopicsFull(null, ids)).map((snapshot) => [snapshot.topicId, snapshot]));
  const views: SearchTopicView[] = [];
  const log: RecallLogInput[] = [];
  ids.forEach((id, index) => {
    const snapshot = snapshots.get(id);
    if (!snapshot) return;
    const relativity = relativityAt(index, ids.length);
    if (input.relativity !== undefined && relativity < input.relativity) return;
    views.push(topicView(snapshot, relativity));
    if (!input.conversationId) return;
    log.push({ conversationId: input.conversationId, via: "turn_start", topicId: snapshot.topicId, decisionId: null, hadConflicts: false });
    for (const decision of snapshot.decisions) {
      log.push({
        conversationId: input.conversationId,
        via: "turn_start",
        topicId: snapshot.topicId,
        decisionId: decision.id,
        hadConflicts: decision.conflicts.length > 0
      });
    }
  });
  deps.local.appendRecallLog(log);
  return { topics: views, degraded: [] };
}

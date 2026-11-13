/**
 * Typed topic questions for a decision model. The model does not write memories.
 * It only picks a topic id, `new`, or `none`.
 * Decision text version: openai-chat-choice-1. The gateway has no /v1/decisions
 * route, so the client asks gpt-6-luna through chat completions.
 */

export const JEV_TOPIC_DECISION_VERSION = "openai-chat-choice-1";
export const JEV_NEW_TOPIC = "new";
export const JEV_NO_TOPIC = "none";

const TOPIC_ID = /^[A-Za-z0-9_.:-]+$/;

export interface TopicBrief {
  id: string;
  name: string;
  summary: string;
  description: string;
  domain?: string;
}

export interface TopicCardSource {
  topicId: string;
  topicName: string;
  topicSummary: string;
  topicDescription: string;
  domain?: string;
  decisions?: Array<{ content: string }>;
  experiences?: Array<{ content: string }>;
  timeline?: Array<{ content: string }>;
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface JevTopicRequest {
  state: string;
  questions: { topic: JevChoiceQuestion };
}

export interface ParsedTopicChoice {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}

function clip(text: string, limit: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

export function briefFromTopic(topic: TopicCardSource, options?: { includeEntries?: boolean }): TopicBrief {
  const entries = options?.includeEntries
    ? [
      ...(topic.decisions ?? []).map((item) => item.content),
      ...(topic.experiences ?? []).map((item) => item.content),
      ...(topic.timeline ?? []).map((item) => item.content)
    ]
    : [];
  return {
    id: topic.topicId,
    name: clip(topic.topicName, 80),
    summary: clip(topic.topicSummary, 300),
    description: clip([topic.topicDescription, ...entries].filter(Boolean).join("\n"), 800),
    ...(topic.domain ? { domain: topic.domain } : {})
  };
}

function criteriaFor(topics: TopicBrief[], extra: Record<string, string>): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const topic of topics) {
    if (topic.id === JEV_NEW_TOPIC || topic.id === JEV_NO_TOPIC || !TOPIC_ID.test(topic.id)) {
      throw new Error(`topic id ${topic.id} cannot be a Jev choice`);
    }
    const label = [topic.domain, topic.name].filter(Boolean).join(" / ");
    criteria[topic.id] = clip(`${label}. ${topic.summary} ${topic.description}`, 800);
  }
  return { ...criteria, ...extra };
}

export function buildAddTopicRequest(input: { query: string; answer: string; topics: TopicBrief[] }): JevTopicRequest {
  const listed = input.topics.map((topic) => `- ${topic.id}: ${topic.name}`).join("\n");
  return {
    state: [
      "USER QUERY:",
      clip(input.query, 2000),
      "",
      "ASSISTANT ANSWER:",
      clip(input.answer, 2000),
      "",
      "CANDIDATE TOPICS:",
      listed || "(none yet)"
    ].join("\n"),
    questions: {
      topic: {
        type: "choice",
        instructions: "Which topic do this user query and assistant answer belong to? Choose a listed topic only when the query and answer are about that topic. Choose new when they belong to project work that none of the listed topics cover. Choose none when they are not a durable project topic.",
        criteria: criteriaFor(input.topics, {
          [JEV_NEW_TOPIC]: "Project work that matches none of the listed topics, so it starts a new topic.",
          [JEV_NO_TOPIC]: "Not a durable project topic: formatting preferences, unrelated chat, or no project work."
        })
      }
    }
  };
}

export function buildSearchTopicRequest(input: { query: string; topics: TopicBrief[] }): JevTopicRequest {
  const listed = input.topics.map((topic) => `- ${topic.id}: ${topic.name}`).join("\n");
  return {
    state: [
      "QUERY:",
      clip(input.query, 2000),
      "",
      "CANDIDATE TOPICS:",
      listed || "(none)"
    ].join("\n"),
    questions: {
      topic: {
        type: "choice",
        instructions: "Which listed topic should be retrieved for this query? Choose the one topic that answers it. Choose none when no listed topic answers it.",
        criteria: criteriaFor(input.topics, {
          [JEV_NO_TOPIC]: "No listed topic answers the query."
        })
      }
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function topicAnswer(body: Record<string, unknown>): Record<string, unknown> | null {
  if (Array.isArray(body.answers)) {
    return body.answers.map(asRecord).find((item) => item?.name === "topic") ?? null;
  }
  return asRecord(asRecord(body.answers)?.topic);
}

function probabilitiesOf(topic: Record<string, unknown>): Record<string, number> {
  const probabilities: Record<string, number> = {};
  if (Array.isArray(topic.probabilities)) {
    for (const item of topic.probabilities) {
      const row = asRecord(item);
      if (row && typeof row.value === "string" && typeof row.probability === "number" && Number.isFinite(row.probability)) {
        probabilities[row.value] = row.probability;
      }
    }
    return probabilities;
  }
  const raw = asRecord(topic.probabilities);
  if (!raw) return probabilities;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) probabilities[key] = value;
  }
  return probabilities;
}

/** Accepts an OpenAI Decisions response (`answers` is a list) or the same fields nested under `answers.topic`. */
export function parseTopicChoice(payload: unknown, allowed: readonly string[]): ParsedTopicChoice {
  const body = asRecord(payload);
  const topic = body ? topicAnswer(body) : null;
  const probabilities = topic ? probabilitiesOf(topic) : {};
  const explicit = typeof topic?.choice === "string" ? topic.choice : null;
  const ranked = Object.entries(probabilities).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const choice = explicit ?? ranked[0]?.[0] ?? null;
  if (!body || !topic || !choice || !allowed.includes(choice)) {
    throw new Error("Decision answer is missing a listed choice");
  }
  const usage = asRecord(body.usage);
  return {
    choice,
    confidence: typeof topic.confidence === "number" && Number.isFinite(topic.confidence) ? topic.confidence : probabilities[choice] ?? 0,
    probabilities,
    model: typeof body.model === "string" ? body.model : null,
    inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : 0
  };
}

/** Keep the chosen topic, drop candidates when Jev says new, and leave the list alone on none or an unknown id. */
export function narrowAddCandidates<T>(candidates: readonly T[], choice: ParsedTopicChoice | null, idOf: (item: T) => string): T[] {
  if (!choice || choice.choice === JEV_NO_TOPIC) return [...candidates];
  if (choice.choice === JEV_NEW_TOPIC) return [];
  const matched = candidates.filter((item) => idOf(item) === choice.choice);
  return matched.length > 0 ? matched : [...candidates];
}

/**
 * Move Jev's topic to the front of an already ranked list. A topic Jev names that
 * deterministic truncation dropped is pulled back from the pool. `none` and `new`
 * leave the deterministic order unchanged.
 */
export function orderSearchByJev<T>(
  selected: readonly T[],
  pool: readonly T[],
  choice: ParsedTopicChoice | null,
  limit: number,
  idOf: (item: T) => string
): T[] {
  if (!choice || choice.choice === JEV_NEW_TOPIC || choice.choice === JEV_NO_TOPIC) return [...selected];
  const picked = pool.find((item) => idOf(item) === choice.choice);
  if (!picked) return [...selected];
  const rest = selected.filter((item) => idOf(item) !== choice.choice);
  return [picked, ...rest].slice(0, Math.max(0, limit));
}

/** Topic ids sorted by Jev probability. `new` and `none` are not retrieval hits. */
export function rankTopicIds(choice: ParsedTopicChoice): string[] {
  const ranked = Object.entries(choice.probabilities)
    .filter(([id]) => id !== JEV_NEW_TOPIC && id !== JEV_NO_TOPIC)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([id]) => id);
  if (ranked.length > 0) return ranked;
  return choice.choice === JEV_NEW_TOPIC || choice.choice === JEV_NO_TOPIC ? [] : [choice.choice];
}

/** Same definition as the v2 scorer: expected topics found in the top k, divided by min(k, expected). */
export function topicRecallAt(ranked: readonly string[], expected: readonly string[], k: number): number {
  if (expected.length === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  const hits = expected.filter((id) => top.has(id)).length;
  return hits / Math.min(k, expected.length);
}

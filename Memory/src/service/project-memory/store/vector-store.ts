import { createHash } from "node:crypto";
import type { RecallRequest, RecallResult, TopicSnapshot } from "../contract/types.js";

export interface IndexQuery {
  model: string | null;
  vectors: readonly (number[] | null)[];
}

export interface TopicVectorInput {
  topicId: string;
  text: string;
  sourceHash: string;
}

export interface TopicVectorWrite extends TopicVectorInput {
  vector: number[];
}

/** Storage primitives: no model calls, retries, or background work. */
export interface ProjectVectorStore {
  queryIndex(request: RecallRequest, index: IndexQuery): Promise<RecallResult>;
  staleVectorTopicIds(request: RecallRequest, model: string): string[];
  pendingVectorInputs(topicIds: string[], model: string): TopicVectorInput[];
  writeTopicVectors(model: string, inputs: TopicVectorWrite[]): void;
}

export function topicIndexText(topic: TopicSnapshot): string {
  const parts = [topic.topicName, topic.topicSummary, topic.topicDescription,
    ...topic.decisions.map((decision) => decision.content),
    ...topic.experiences.map((experience) => experience.content)];
  return [...parts.join("\n")].slice(0, 2000).join("");
}

export function topicIndexHash(topic: TopicSnapshot, model: string): string {
  return createHash("sha256").update(`${model}\u0000${topicIndexText(topic)}`).digest("hex");
}

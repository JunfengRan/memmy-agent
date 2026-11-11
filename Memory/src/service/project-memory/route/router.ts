import type { LlmClient } from "../../../model/types.js";
import { PROJECT_MEMORY_LIMITS } from "../contract/limits.js";
import type { RawTurnRecord } from "../contract/types.js";
import { ROUTE_SYSTEM_PROMPT } from "../prompts/route.js";
import type { ProjectMemoryStore } from "../store/store.js";
import { clampText } from "../text.js";

/** One existing topic shown to the router. The topic id is the session id. */
export interface SessionCard {
  topicId: string;
  spaceId: string;
  domain: string;
  topicName: string;
  topicSummary: string;
  topicDescription: string;
  decisions: string[];
  updateTime?: string;
}

export type WriteRoute =
  | { kind: "accept"; title: string; summary: string }
  | { kind: "attach"; topicId: string }
  | { kind: "ignore"; reason: string }
  | { kind: "stop"; topicId: string; reason: string };

export type RetrieveRoute = { kind: "retrieve"; topicIds: string[] };

export class RouteOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteOutputError";
  }
}

const SESSION_LIMIT = 30;
const DECISION_CARDS = 8;
const PAGE_SIZE = 50;

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function knownIds(sessions: SessionCard[]): Set<string> {
  return new Set(sessions.map((session) => session.topicId));
}

/** Lists the sessions a router call may attach to or retrieve, newest first, capped. */
export async function loadSessionCards(store: ProjectMemoryStore, spaceIds: string[], domains?: string[]): Promise<SessionCard[]> {
  const cards: SessionCard[] = [];
  for (const spaceId of spaceIds) {
    for (let page = 1; ; page += 1) {
      const { topics, total } = await store.listTopics(spaceId, page, PAGE_SIZE);
      for (const topic of topics) {
        if (domains && domains.length > 0 && !domains.includes(topic.domain)) continue;
        cards.push({
          topicId: topic.topicId,
          spaceId: topic.spaceId,
          domain: topic.domain,
          topicName: topic.topicName,
          topicSummary: topic.topicSummary,
          topicDescription: clampText(topic.topicDescription, 200),
          decisions: topic.decisions.slice(0, DECISION_CARDS).map((decision) => decision.content),
          updateTime: topic.updateTime
        });
      }
      if (topics.length === 0 || page * PAGE_SIZE >= total) break;
    }
  }
  cards.sort((left, right) => (right.updateTime ?? "").localeCompare(left.updateTime ?? "") || left.topicId.localeCompare(right.topicId));
  return cards.slice(0, SESSION_LIMIT);
}

export function parseWriteRoute(raw: unknown, sessions: SessionCard[]): WriteRoute {
  const record = asRecord(raw);
  if (!record) throw new RouteOutputError("route output must be an object");
  const known = knownIds(sessions);
  switch (record.kind) {
    case "accept": {
      const title = clampText(asString(record.title) ?? "", PROJECT_MEMORY_LIMITS.topicName);
      const summary = clampText(asString(record.summary) ?? "", PROJECT_MEMORY_LIMITS.topicSummary);
      if (!title) throw new RouteOutputError("accept needs a title");
      return { kind: "accept", title, summary };
    }
    case "attach": {
      const topicId = asString(record.topic_id);
      if (!topicId || !known.has(topicId)) throw new RouteOutputError("attach needs a listed session");
      return { kind: "attach", topicId };
    }
    case "ignore": {
      const reason = clampText(asString(record.reason) ?? "", 200);
      if (!reason) throw new RouteOutputError("ignore needs a reason");
      return { kind: "ignore", reason };
    }
    case "stop": {
      const topicId = asString(record.topic_id);
      const reason = clampText(asString(record.reason) ?? "", 200);
      if (!topicId || !known.has(topicId)) throw new RouteOutputError("stop needs a listed session");
      if (!reason) throw new RouteOutputError("stop needs a reason");
      return { kind: "stop", topicId, reason };
    }
    default:
      throw new RouteOutputError("write route kind must be accept, attach, ignore or stop");
  }
}

export function parseRetrieveRoute(raw: unknown, sessions: SessionCard[]): RetrieveRoute {
  const record = asRecord(raw);
  if (!record || record.kind !== "retrieve" || !Array.isArray(record.topic_ids)) {
    throw new RouteOutputError("retrieve needs topic_ids");
  }
  const known = knownIds(sessions);
  const topicIds: string[] = [];
  let unknown = 0;
  for (const item of record.topic_ids) {
    if (typeof item !== "string" || !known.has(item)) {
      unknown += 1;
      continue;
    }
    if (!topicIds.includes(item)) topicIds.push(item);
  }
  if (topicIds.length === 0 && unknown > 0) throw new RouteOutputError("retrieve ids are not sessions");
  return { kind: "retrieve", topicIds };
}

function turnView(turn: RawTurnRecord): { role: string; name: string | null; time: string; content: string } {
  return { role: turn.role, name: turn.roleName, time: turn.chatTime, content: turn.content };
}

function sessionView(session: SessionCard): Record<string, unknown> {
  return {
    topic_id: session.topicId,
    space_id: session.spaceId,
    domain: session.domain,
    topic_name: session.topicName,
    topic_summary: session.topicSummary,
    topic_description: session.topicDescription,
    decisions: session.decisions,
    update_time: session.updateTime
  };
}

async function completeRoute<T>(llm: LlmClient, payload: Record<string, unknown>, parse: (raw: Json) => T): Promise<T> {
  const messages = [
    { role: "system" as const, content: ROUTE_SYSTEM_PROMPT },
    { role: "user" as const, content: JSON.stringify(payload) }
  ];
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROJECT_MEMORY_LIMITS.modelAttempts; attempt += 1) {
    try {
      const raw = await llm.completeJson<Json>(messages, {
        operation: "project_memory.route",
        jsonMode: true,
        temperature: 0,
        thinkingMode: "disabled",
        maxTokens: 800
      });
      return parse(raw);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function routeWrite(llm: LlmClient, input: {
  instructions: string | null;
  messages: RawTurnRecord[];
  context: RawTurnRecord[];
  sessions: SessionCard[];
}): Promise<WriteRoute> {
  return completeRoute(llm, {
    route: "write",
    instructions: input.instructions,
    context_turns: input.context.map(turnView),
    messages: input.messages.map(turnView),
    sessions: input.sessions.map(sessionView)
  }, (raw) => parseWriteRoute(raw, input.sessions));
}

export function routeRetrieve(llm: LlmClient, input: { query: string; sessions: SessionCard[] }): Promise<RetrieveRoute> {
  return completeRoute(llm, {
    route: "retrieve",
    query: input.query,
    sessions: input.sessions.map(sessionView)
  }, (raw) => parseRetrieveRoute(raw, input.sessions));
}

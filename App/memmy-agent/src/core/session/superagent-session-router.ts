/**
 * Session router adapted from dsh-superagent's orchestrator.
 *
 * The source of the rules is the research prototype's dispatch prompt and
 * `orchestrator_route` (`prompts/dispatch.md`, `src/app/tools/main.ts`):
 * each message is accepted as a new session, attached to an existing session,
 * ignored, or used to stop a session. Attach is only for a message that points
 * at that session. A similar subject is a new request. A session a person
 * stopped cannot be attached.
 *
 * Memmy's flat inbox has no source-defined thread id. The session this router
 * assigns is the thread the message belongs to. Summaries replace transcripts:
 * a card keeps the title and the latest turn only.
 */

export const SUPERAGENT_ROUTER_PROMPT_VERSION = "2026-11-06.1";
export const SESSION_TITLE_MAX = 200;
export const ROUTE_REASON_MAX = 500;
export const SUMMARY_CHARS = 240;

export const ROUTE_KINDS = ["accept", "attach", "ignore", "stop"] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

export type RouteDecision = {
  kind: RouteKind;
  sessionId?: string;
  title?: string;
  reason?: string;
};

export type RouterTurn = {
  query: string;
  answer: string;
};

export type RouterSession = {
  id: string;
  title: string;
  /** A person's stop. Attach must not resume it. */
  stopped: boolean;
  turns: RouterTurn[];
};

export type RouterState = {
  sessions: RouterSession[];
  nextId: number;
};

export type SessionSummary = {
  id: string;
  title: string;
  stopped: boolean;
  turns: number;
  lastQuery: string;
  lastAnswer: string;
};

export type AppliedRoute = {
  kind: RouteKind;
  sessionId: string | null;
  title: string | null;
  reason: string;
};

export type ApplyResult = AppliedRoute | { refused: string };

export function createRouterState(): RouterState {
  return { sessions: [], nextId: 1 };
}

export function clipText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function summarizeSession(session: RouterSession): SessionSummary {
  const last = session.turns.at(-1);
  return {
    id: session.id,
    title: session.title,
    stopped: session.stopped,
    turns: session.turns.length,
    lastQuery: clipText(last?.query ?? "", SUMMARY_CHARS),
    lastAnswer: clipText(last?.answer ?? "", SUMMARY_CHARS),
  };
}

export function routerSystemPrompt(): string {
  return [
    "You are the session router for one inbox. Route the single new user message.",
    "Use the session summaries only. Do not invent a transcript, a requirement, or a work plan.",
    "These are the dsh-superagent dispatch rules, with a session standing in for a ticket.",
    "Decide exactly one kind:",
    "- accept: the message is new work. Return a title of at most 200 characters that describes the original request and adds nothing.",
    "- attach: the message points at exactly one open session. It quotes that session, names its title, quotes its last message or last answer, or refers to the change just made and exactly one open session fits. Return that session id.",
    "- ignore: ordinary discussion that asks for no work. Return a reason.",
    "- stop: the user explicitly stops one open session. Return that session id and a reason.",
    "A message on a similar subject is a new request: accept or ignore it, never attach it.",
    "When no open session fits, accept or ignore. Never attach a message that does not point at that session.",
    "A stopped session cannot be attached.",
    'Return one JSON object and nothing else: {"kind":"accept"|"attach"|"ignore"|"stop","sessionId":"s1","title":"...","reason":"..."}.',
    "accept requires title. attach and stop require sessionId. ignore and stop require reason. Omit fields the kind does not use.",
  ].join("\n");
}

export function routerUserPrompt(summaries: readonly SessionSummary[], query: string): string {
  const sessions = summaries.length ? JSON.stringify(summaries, null, 2) : "[]";
  return `Open sessions (summaries only):\n${sessions}\n\nNew message:\n${query}`;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

/** Parse a model reply into a route decision. Extra prose is ignored; the JSON object is not. */
export function parseRouteDecision(text: string): RouteDecision {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("model did not return a JSON object");
  let value: unknown;
  try {
    value = JSON.parse(stripped.slice(start, end + 1));
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("route decision must be an object");
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !ROUTE_KINDS.includes(kind as RouteKind)) {
    throw new Error("kind must be accept, attach, ignore, or stop");
  }
  const decision: RouteDecision = { kind: kind as RouteKind };
  const sessionId = readString(record.sessionId);
  const title = readString(record.title);
  const reason = readString(record.reason);
  if (sessionId) decision.sessionId = sessionId;
  if (title) decision.title = title;
  if (reason) decision.reason = reason;
  return decision;
}

function requireField(decision: RouteDecision, field: "sessionId" | "title" | "reason"): string | { refused: string } {
  const value = decision[field];
  if (!value) return { refused: `${decision.kind} needs ${field}` };
  const max = field === "title" ? SESSION_TITLE_MAX : field === "reason" ? ROUTE_REASON_MAX : 80;
  if (value.length > max) return { refused: `${field} exceeds ${max} characters` };
  return value;
}

/**
 * Apply one routing decision. A refused decision leaves the state unchanged,
 * matching `orchestrator_route`, where a refused item does not undo the others.
 */
export function applyRouteDecision(
  state: RouterState,
  query: string,
  answer: string,
  decision: RouteDecision,
): ApplyResult {
  if (decision.kind === "accept") {
    const title = requireField(decision, "title");
    if (typeof title !== "string") return title;
    const session: RouterSession = {
      id: `s${state.nextId}`,
      title,
      stopped: false,
      turns: [{ query, answer }],
    };
    state.nextId += 1;
    state.sessions.push(session);
    return { kind: "accept", sessionId: session.id, title, reason: "Accepted as a new session" };
  }

  if (decision.kind === "attach" || decision.kind === "stop") {
    const sessionId = requireField(decision, "sessionId");
    if (typeof sessionId !== "string") return sessionId;
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) return { refused: `Unknown session ${sessionId}` };
    if (decision.kind === "stop") {
      const reason = requireField(decision, "reason");
      if (typeof reason !== "string") return reason;
      session.stopped = true;
      return { kind: "stop", sessionId, title: session.title, reason };
    }
    if (session.stopped) {
      return { refused: `A person stopped ${sessionId}; new work needs an accept` };
    }
    session.turns.push({ query, answer });
    return { kind: "attach", sessionId, title: session.title, reason: "Attached to the session the message points at" };
  }

  const reason = requireField(decision, "reason");
  if (typeof reason !== "string") return reason;
  return { kind: "ignore", sessionId: null, title: null, reason };
}

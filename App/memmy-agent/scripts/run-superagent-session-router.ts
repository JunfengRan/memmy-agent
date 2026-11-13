/**
 * Replay the session router over eval/session-router/runs/dataset.json.
 * The model is memmy's DeepSeek config in ~/.deepseek.env (deepseek-v4.1-flash-1017).
 * One refused decision is retried once, as orchestrator_route tells the caller to retry that item.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyRouteDecision,
  createRouterState,
  parseRouteDecision,
  routerSystemPrompt,
  routerUserPrompt,
  summarizeSession,
  SUPERAGENT_ROUTER_PROMPT_VERSION,
  type ApplyResult,
  type RouteDecision,
} from "../src/core/session/superagent-session-router.ts";

type DatasetTurn = {
  id: string;
  gold: string;
  project: string;
  at: string;
  query: string;
  answer: string;
};

type Prediction = {
  id: string;
  gold: string;
  project: string;
  query: string;
  answer: string;
  kind: string;
  sessionId: string | null;
  title: string | null;
  reason: string;
  attempts: number;
  model: string | null;
};

function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const split = trimmed.indexOf("=");
    if (split < 0) continue;
    env[trimmed.slice(0, split)] = trimmed.slice(split + 1).replace(/^["']|["']$/g, "");
  }
  return env;
}

async function complete(baseUrl: string, apiKey: string, model: string, system: string, user: string): Promise<{ text: string; model: string | null }> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(90_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 800,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const body = await response.json().catch(() => ({})) as {
    model?: string;
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
  };
  if (!response.ok) throw new Error(`${model} ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const message = body.choices?.[0]?.message;
  const text = message?.content?.trim() || message?.reasoning_content?.trim() || "";
  return { text, model: body.model ?? null };
}

async function routeOnce(
  call: (system: string, user: string) => Promise<{ text: string; model: string | null }>,
  state: ReturnType<typeof createRouterState>,
  turn: DatasetTurn,
): Promise<{ result: ApplyResult; raw: string; model: string | null; attempts: number }> {
  const system = routerSystemPrompt();
  let feedback = "";
  let lastRaw = "";
  let lastModel: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const user = `${routerUserPrompt(state.sessions.map(summarizeSession), turn.query)}${feedback}`;
    const reply = await call(system, user);
    lastRaw = reply.text;
    lastModel = reply.model;
    let decision: RouteDecision;
    try {
      decision = parseRouteDecision(reply.text);
    } catch (error) {
      feedback = `\n\nThe previous output was refused: ${error instanceof Error ? error.message : String(error)}. Return one JSON object.`;
      continue;
    }
    const result = applyRouteDecision(state, turn.query, turn.answer, decision);
    if ("refused" in result) {
      feedback = `\n\nThe previous decision was refused: ${result.refused}. Decide this message again.`;
      continue;
    }
    return { result, raw: lastRaw, model: lastModel, attempts: attempt };
  }
  return {
    result: { refused: "still refused after one retry" },
    raw: lastRaw,
    model: lastModel,
    attempts: 2,
  };
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "../../..");
const datasetPath = join(repoRoot, "eval/session-router/runs/dataset.json");
const outPath = join(repoRoot, "eval/session-router/runs/predictions.json");
const env = loadEnv(join(homedir(), ".deepseek.env"));
const model = env.MODEL;
const baseUrl = env.OPENAI_API_BASE;
const apiKey = env.OPENAI_API_KEY;
if (!model || !baseUrl || !apiKey) throw new Error("~/.deepseek.env must set MODEL, OPENAI_API_BASE, and OPENAI_API_KEY");

const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as { turns: DatasetTurn[] };
const state = createRouterState();
const predictions: Prediction[] = [];
let servedModel: string | null = null;

for (const turn of dataset.turns) {
  const routed = await routeOnce(
    (system, user) => complete(baseUrl, apiKey, model, system, user),
    state,
    turn,
  );
  servedModel = routed.model ?? servedModel;
  if ("refused" in routed.result) {
    predictions.push({
      id: turn.id,
      gold: turn.gold,
      project: turn.project,
      query: turn.query,
      answer: turn.answer,
      kind: "refused",
      sessionId: null,
      title: null,
      reason: routed.result.refused,
      attempts: routed.attempts,
      model: routed.model,
    });
    console.error(`${turn.id} refused ${routed.result.refused}`);
    continue;
  }
  predictions.push({
    id: turn.id,
    gold: turn.gold,
    project: turn.project,
    query: turn.query,
    answer: turn.answer,
    kind: routed.result.kind,
    sessionId: routed.result.sessionId,
    title: routed.result.title,
    reason: routed.result.reason,
    attempts: routed.attempts,
    model: routed.model,
  });
  console.error(`${turn.id} ${routed.result.kind} ${routed.result.sessionId ?? "-"} ${turn.project}`);
}

writeFileSync(outPath, `${JSON.stringify({
  promptVersion: SUPERAGENT_ROUTER_PROMPT_VERSION,
  requestedModel: model,
  servedModel,
  sessions: state.sessions.map((session) => ({
    id: session.id,
    title: session.title,
    stopped: session.stopped,
    turnIds: predictions.filter((item) => item.sessionId === session.id).map((item) => item.id),
    projects: [...new Set(predictions.filter((item) => item.sessionId === session.id).map((item) => item.project))],
  })),
  predictions,
}, null, 2)}\n`);
console.error(`wrote ${predictions.length} predictions to ${outPath}`);

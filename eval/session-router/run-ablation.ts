/**
 * Ablation over the session-routing dataset (eval/session-router/runs/dataset.json).
 *
 * Two factors, one baseline:
 *   protocol  jev  = typed choice question over session cards (topic-choice.ts, copied from the decisions/ experiment)
 *             sa   = Super Agent router (accept / attach / ignore / stop, superagent-session-router.ts)
 *   model     luna = gpt-6-luna from ~/.openai.env (the Jev decision model)
 *             ds   = DeepSeek from ~/.deepseek.env (the model of the earlier Super Agent run)
 *
 * Cells: baseline (lexical, no model), jev = luna+jev, sa = ds+sa, both = luna+sa, jev-ds = ds+jev.
 *
 *   node eval/session-router/run-ablation.ts run [--cells jev,sa,both,jev-ds] [--runs 3]
 *   node eval/session-router/run-ablation.ts summarize
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  type RouteDecision,
} from "../../App/memmy-agent/src/core/session/superagent-session-router.ts";
import {
  buildAddTopicRequest,
  parseTopicChoice,
  JEV_NEW_TOPIC,
  JEV_NO_TOPIC,
  type JevTopicRequest,
  type TopicBrief,
} from "./jev-topic-choice.ts";

type Turn = { id: string; gold: string; project: string; query: string; answer: string };
type Cred = { model: string; baseUrl: string; apiKey: string; isLuna: boolean };
type Pred = { id: string; gold: string; project: string; kind: string; sessionId: string | null; reason: string; attempts: number };
type Cell = { protocol: "jev" | "sa" | "lexical"; model: "luna" | "ds" | null };

const CELLS: Record<string, Cell> = {
  baseline: { protocol: "lexical", model: null },
  jev: { protocol: "jev", model: "luna" },
  sa: { protocol: "sa", model: "ds" },
  both: { protocol: "sa", model: "luna" },
  "jev-ds": { protocol: "jev", model: "ds" },
};

const here = dirname(fileURLToPath(import.meta.url));
const runsDir = join(here, "runs");
const outDir = join(runsDir, "ablation");
const dataset = JSON.parse(readFileSync(join(here, "../session-router-ablation/results/dataset.json"), "utf8")) as { turns: Turn[] };

function parseEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

function cred(which: "luna" | "ds"): Cred {
  const env = parseEnv(join(homedir(), which === "luna" ? ".openai.env" : ".deepseek.env"));
  const model = env.MODEL;
  const baseUrl = (env.OPENAI_API_BASE ?? "").replace(/\/$/, "").replace(/\/chat\/completions$/, "");
  const apiKey = env.OPENAI_API_KEY;
  if (!model || !baseUrl || !apiKey) throw new Error(`${which} env is incomplete`);
  return { model, baseUrl, apiKey, isLuna: which === "luna" };
}

async function chat(c: Cred, system: string, user: string, responseFormat?: unknown): Promise<string> {
  const body: Record<string, unknown> = {
    model: c.model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  };
  // gpt-6-luna rejects temperature 0 and wants max_completion_tokens.
  if (c.isLuna) body.max_completion_tokens = 1500;
  else { body.temperature = 0; body.max_tokens = 800; }
  if (responseFormat) body.response_format = responseFormat;
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(90_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${c.apiKey}` },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        last = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        if (res.status === 400 && responseFormat) { delete body.response_format; continue; }
        if (![429, 500, 502, 503, 504].includes(res.status)) break;
      } else {
        const msg = (JSON.parse(text) as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }> }).choices?.[0]?.message;
        const out = msg?.content?.trim() || msg?.reasoning_content?.trim() || "";
        if (out) return out;
        last = "empty content";
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 300 * attempt));
  }
  throw new Error(last);
}

// ---------- lexical baseline (same tokenization and rule as the Jev eval's lexical control) ----------
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
function tokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) {
    let latin = ""; let cjk = "";
    const fl = () => { if (latin.length >= 2 || /\d/.test(latin)) out.push(latin); latin = ""; };
    const fc = () => { if (cjk.length === 1) out.push(cjk); for (let i = 0; i + 1 < cjk.length; i += 1) out.push(cjk.slice(i, i + 2)); cjk = ""; };
    for (const ch of m[0]) { if (CJK.test(ch)) { fl(); cjk += ch; } else { fc(); latin += ch; } }
    fl(); fc();
  }
  return out;
}
function overlap(q: string[], text: string): number {
  if (!q.length) return 0;
  const h = new Set(tokens(text));
  return q.filter((t) => h.has(t)).length / q.length;
}

// ---------- session state shared by the jev and lexical protocols ----------
type Sess = { id: string; title: string; turns: Array<{ query: string; answer: string }> };
const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length <= n ? t : `${t.slice(0, n - 1)}…`; };
function brief(s: Sess): TopicBrief {
  const last = s.turns.at(-1)!;
  return { id: s.id, name: clip(s.title, 80), summary: clip(last.query, 300), description: clip(last.answer, 800) };
}

async function jevChoice(c: Cred, req: JevTopicRequest): Promise<string> {
  const q = req.questions.topic;
  const keys = Object.keys(q.criteria);
  const options = keys.map((k) => `- ${k}: ${q.criteria[k]}`).join("\n");
  const schema = {
    type: "json_schema",
    json_schema: {
      name: "topic_choice", strict: true,
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          choice: { type: "string", enum: keys },
          probabilities: { type: "object", additionalProperties: false, properties: Object.fromEntries(keys.map((k) => [k, { type: "number" }])), required: keys },
        },
        required: ["choice", "probabilities"],
      },
    },
  };
  const hint = c.isLuna ? "" : `\n\nReturn one JSON object only: {"choice": one of [${keys.join(", ")}], "probabilities": {option: number}}.`;
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const text = await chat(c, q.instructions, `${req.state}\n\nOPTIONS:\n${options}${hint}`, c.isLuna ? schema : undefined);
    try {
      const s = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
      const obj = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)) as { choice?: string; probabilities?: Record<string, number> };
      const probs = Object.entries(obj.probabilities ?? {}).map(([value, probability]) => ({ value, probability }));
      return parseTopicChoice({ answers: [{ name: "topic", choice: obj.choice, probabilities: probs }] }, keys).choice;
    } catch (error) {
      lastErr = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastErr);
}

async function runCell(name: string): Promise<{ preds: Pred[]; model: string | null; calls: number }> {
  const cell = CELLS[name]!;
  const c = cell.model ? cred(cell.model) : null;
  const preds: Pred[] = [];
  let calls = 0;
  const push = (t: Turn, kind: string, sessionId: string | null, reason: string, attempts = 1) =>
    preds.push({ id: t.id, gold: t.gold, project: t.project, kind, sessionId, reason, attempts });

  if (cell.protocol === "sa") {
    const state = createRouterState();
    for (const t of dataset.turns) {
      let feedback = ""; let done = false; let attempts = 0; let reason = "";
      for (attempts = 1; attempts <= 2 && !done; attempts += 1) {
        calls += 1;
        let raw: string;
        try { raw = await chat(c!, routerSystemPrompt(), `${routerUserPrompt(state.sessions.map(summarizeSession), t.query)}${feedback}`); }
        catch (e) { reason = `call failed: ${e instanceof Error ? e.message : e}`; break; }
        let decision: RouteDecision;
        try { decision = parseRouteDecision(raw); }
        catch (e) { reason = String(e instanceof Error ? e.message : e); feedback = `\n\nThe previous output was refused: ${reason}. Return one JSON object.`; continue; }
        const r = applyRouteDecision(state, t.query, t.answer, decision);
        if ("refused" in r) { reason = r.refused; feedback = `\n\nThe previous decision was refused: ${r.refused}. Decide this message again.`; continue; }
        push(t, r.kind, r.sessionId, r.reason, attempts); done = true;
      }
      if (!done) push(t, "refused", null, reason, 2);
    }
    return { preds, model: c!.model, calls };
  }

  // jev and lexical: a flat set of sessions; choice is an existing id, new, or none.
  const sessions: Sess[] = [];
  let next = 1;
  for (const t of dataset.turns) {
    let choice: string;
    if (cell.protocol === "lexical") {
      const q = tokens(`${t.query}\n${t.answer}`);
      const ranked = sessions.map((s) => ({ s, o: overlap(q, `${s.title}\n${brief(s).summary}\n${brief(s).description}`) })).sort((a, b) => b.o - a.o || a.s.id.localeCompare(b.s.id));
      choice = ranked[0] && ranked[0].o > 0 ? ranked[0].s.id : JEV_NEW_TOPIC;
    } else {
      calls += 1;
      try { choice = await jevChoice(c!, buildAddTopicRequest({ query: t.query, answer: t.answer, topics: sessions.map(brief) })); }
      catch (e) { push(t, "refused", null, `call failed: ${e instanceof Error ? e.message : e}`, 2); continue; }
    }
    if (choice === JEV_NO_TOPIC) { push(t, "ignore", null, "none"); continue; }
    const existing = sessions.find((s) => s.id === choice);
    if (existing) { existing.turns.push({ query: t.query, answer: t.answer }); push(t, "attach", existing.id, "choice"); continue; }
    const s: Sess = { id: `s${next++}`, title: clip(t.query, 80), turns: [{ query: t.query, answer: t.answer }] };
    sessions.push(s);
    push(t, "accept", s.id, "new");
  }
  return { preds, model: c?.model ?? null, calls };
}

// ---------- scoring ----------
export function score(preds: Pred[]) {
  const goldOf = new Map(preds.map((p) => [p.id, p.gold]));
  const cluster = (p: Pred) => (p.sessionId ? `S:${p.sessionId}` : `X:${p.id}`); // ignored / refused = singleton
  const clusters = new Map<string, Pred[]>();
  for (const p of preds) clusters.set(cluster(p), [...(clusters.get(cluster(p)) ?? []), p]);
  const goldGroups = new Map<string, Pred[]>();
  for (const p of preds) goldGroups.set(p.gold, [...(goldGroups.get(p.gold) ?? []), p]);
  let bp = 0; let br = 0;
  for (const p of preds) {
    const mine = clusters.get(cluster(p))!; const same = goldGroups.get(p.gold)!;
    const both = mine.filter((q) => q.gold === p.gold).length;
    bp += both / mine.length; br += both / same.length;
  }
  const P = bp / preds.length; const R = br / preds.length;
  const sessionIds = [...clusters.keys()].filter((k) => k.startsWith("S:"));
  const cross = sessionIds.filter((k) => new Set(clusters.get(k)!.map((p) => p.project)).size > 1).length;
  const assigned = preds.filter((p) => p.sessionId);
  const dropped = preds.length - assigned.length;
  const pureTurn = (p: Pred) => clusters.get(cluster(p))!.every((q) => q.gold === p.gold);
  const lenient = assigned.filter(pureTurn).length / preds.length;
  // continuation: an earlier turn of the same gold conversation exists.
  const seen = new Set<string>(); let cont = 0; let contHit = 0; let attachN = 0; let attachPure = 0;
  const order = new Map(preds.map((p, i) => [p.id, i]));
  for (const p of preds) {
    const isCont = seen.has(p.gold); seen.add(p.gold);
    if (p.kind === "attach") {
      attachN += 1;
      const prior = clusters.get(cluster(p))!.filter((q) => order.get(q.id)! < order.get(p.id)!);
      if (prior.every((q) => q.gold === p.gold)) attachPure += 1;
    }
    if (!isCont) continue;
    cont += 1;
    const prior = (clusters.get(cluster(p)) ?? []).filter((q) => order.get(q.id)! < order.get(p.id)!);
    if (p.sessionId && prior.length > 0 && prior.every((q) => q.gold === p.gold)) contHit += 1;
  }
  void goldOf;
  return {
    turns: preds.length,
    bcubedP: P, bcubedR: R, bcubedF1: P + R ? (2 * P * R) / (P + R) : 0,
    crossProjectMerges: cross,
    sessions: sessionIds.length,
    dropped,
    lenientAccuracy: lenient,
    continuationAttach: cont ? contHit / cont : 0,
    continuations: cont,
    attachPrecision: attachN ? attachPure / attachN : null,
    attaches: attachN,
  };
}

const arg = (name: string, d: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1]! : d; };
const mode = process.argv[2];

if (mode === "run") {
  mkdirSync(outDir, { recursive: true });
  const cells = arg("--cells", "jev,sa,both,jev-ds").split(",");
  const runs = Number(arg("--runs", "3"));
  if (cells.some(name => !CELLS[name])) throw new Error("Unknown ablation cell");
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const jobs: Array<Promise<void>> = [];
  const names = [...new Set(["baseline", ...cells])];
  for (const name of names) {
    const n = name === "baseline" ? 1 : runs;
    for (let k = 1; k <= n; k += 1) {
      jobs.push((async () => {
        const started = Date.now();
        const r = await runCell(name);
        const file = join(outDir, `${name}-r${k}.json`);
        writeFileSync(file, `${JSON.stringify({ cell: name, run: k, ...CELLS[name], model: r.model, saPromptVersion: SUPERAGENT_ROUTER_PROMPT_VERSION, calls: r.calls, wallMs: Date.now() - started, score: score(r.preds), preds: r.preds }, null, 2)}\n`);
        console.error(`${name} r${k} done: f1=${score(r.preds).bcubedF1.toFixed(3)}`);
      })().catch((e) => {
        process.exitCode = 1;
        console.error(`${name} r${k} FAILED ${e instanceof Error ? e.message : e}`);
      }));
    }
  }
  await Promise.all(jobs);
} else if (mode === "summarize") {
  const files = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".json") && f !== "summary.json") : [];
  const byCell = new Map<string, Array<ReturnType<typeof score> & { calls: number; wallMs: number }>>();
  for (const f of files) {
    const j = JSON.parse(readFileSync(join(outDir, f), "utf8")) as { cell: string; score: ReturnType<typeof score>; calls: number; wallMs: number };
    byCell.set(j.cell, [...(byCell.get(j.cell) ?? []), { ...j.score, calls: j.calls, wallMs: j.wallMs }]);
  }
  const keys = ["bcubedF1", "bcubedP", "bcubedR", "lenientAccuracy", "continuationAttach", "attachPrecision", "crossProjectMerges", "dropped", "sessions", "calls", "wallMs"] as const;
  const summary: Record<string, unknown> = {};
  for (const [cell, rows] of byCell) {
    const o: Record<string, unknown> = { runs: rows.length };
    for (const k of keys) {
      const v = rows.map((r) => r[k] as number | null).filter((x): x is number => x !== null);
      o[k] = v.length ? { mean: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v) } : null;
    }
    summary[cell] = o;
  }
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.error("usage: run-ablation.ts run|summarize");
  process.exit(2);
}

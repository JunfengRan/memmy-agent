#!/usr/bin/env node
// Blank control for the v3 eval: no memory system at all. Each question's reader sees only the raw
// sessions of its own Space that were submitted before the question, through progressive disclosure:
//   list_sessions  → one line per session (who, agent, time span, turn count, first request)
//   open_session   → one line per turn (time, member request cut to 80 characters)
//   read_turns     → full text of chosen turns (member request and Agent reply)
//   search_history → turns whose text contains a keyword (plain substring, no ranking model)
// Nothing is summarized, deduplicated, merged or resolved: whatever the answer needs about current
// state, stale versions or conflicts has to be read out of the history itself. Answers are judged with
// the same judge, gold answers and trap texts as run-pipeline-eval.mjs, so answers.llm compares 1:1.
//
//   node harness/model-env.mjs --out <run>/models.json -- node history-baseline.mjs --out <run> [--only q01,q02]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadDataset } from "./build-gold-baseline.mjs";
import { acceptedTime } from "./episode-timeline.mjs";
import { createJudge } from "./judge.mjs";
import { assertJudgeFamily, createLlm, resolveModelConfig } from "./llm.mjs";
import { goldFor } from "./load-eval-set.mjs";
import { percentile, priceCalls, tokenBuckets } from "./metrics.mjs";

export const HISTORY_PROMPT_VERSION = 1;
export const MAX_STEPS = 12;
const OUTLINE_CHARS = 80;
const PRICING_PATH = fileURLToPath(new URL("./pricing.json", import.meta.url));

export const HISTORY_SYSTEM = `你是一个编码 Agent，正在回答项目成员的问题。你没有整理过的项目记忆，只能查看这个项目空间里成员们和 Agent 的历史会话。
历史会话按渐进式披露提供：先用 list_sessions 看有哪些会话，再用 open_session 看某个会话每一轮的概要，需要细节时用 read_turns 读原文；
也可以用 search_history 按关键词找相关的轮次。只能依据读到的历史回答，不能用常识补充项目细节。
- 同一件事前后说法不同时，以时间更晚的为当前状态；同一件事不同成员结论相反、又没有人拍板时，列出各项结论及其成员，说明尚未确定。
- 用一到三句中文直接回答当前状态。历史里没有能回答问题的内容时，只回答「记忆中没有相关内容」。`;

export const HISTORY_TOOLS = [
  { type: "function", function: { name: "list_sessions", description: "列出本空间在提问时刻之前的全部会话：会话 ID、成员、Agent、起止时间、轮数和第一轮的请求。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "open_session", description: "查看一个会话每一轮的时间和成员请求的开头。", parameters: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] } } },
  { type: "function", function: { name: "read_turns", description: "读取一个会话中指定轮次（从 1 开始）的完整原文。", parameters: { type: "object", properties: { session_id: { type: "string" }, turns: { type: "array", items: { type: "integer" } } }, required: ["session_id", "turns"] } } },
  { type: "function", function: { name: "search_history", description: "按关键词（原文子串）查找本空间历史中包含它的轮次。", parameters: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] } } }
];

const minute = (iso) => String(iso ?? "").slice(0, 16).replace("T", " ");
const cut = (text, n) => { const s = String(text ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };

// The history one question may see: its Space's Traces submitted before askedAt, grouped by session.
// A resubmitted Trace stays in the history as the member sent it; nothing is deduplicated.
export function historyFor(ds, question) {
  const conversations = new Map(ds.corpus.conversations.map((c) => [c.id, c]));
  const names = Object.fromEntries(ds.corpus.members.map((m) => [m.user_id, m.name]));
  const visible = ds.corpus.traces
    .filter((trace) => conversations.get(trace.conversation)?.space_id === question.space_id)
    .filter((trace) => Date.parse(acceptedTime(trace)) <= Date.parse(question.askedAt))
    .sort((a, b) => Date.parse(a.chat_time) - Date.parse(b.chat_time) || a.id.localeCompare(b.id));
  const sessions = new Map();
  for (const trace of visible) {
    const conversation = conversations.get(trace.conversation);
    const session = sessions.get(conversation.id) ?? {
      id: conversation.id, member: names[conversation.user_id] ?? conversation.user_id, agent: conversation.agent_id, turns: []
    };
    session.turns.push({ n: session.turns.length + 1, time: trace.chat_time, request: trace.query, reply: trace.answer });
    sessions.set(conversation.id, session);
  }
  return [...sessions.values()];
}

// Tool handlers over one question's history. Unknown sessions and turns answer with an error text
// the model can read, never an exception.
export function historyTools(sessions) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const turnLine = (s, t) => `[${s.id} #${t.n}] ${minute(t.time)} ${s.member}：${cut(t.request, OUTLINE_CHARS)}`;
  return {
    list_sessions() {
      if (!sessions.length) return "这个空间在提问时刻之前没有历史会话。";
      return sessions.map((s) => `${s.id}｜${s.member}｜${s.agent}｜${minute(s.turns[0].time)} ~ ${minute(s.turns.at(-1).time)}｜${s.turns.length} 轮｜首轮：${cut(s.turns[0].request, OUTLINE_CHARS)}`).join("\n");
    },
    open_session({ session_id }) {
      const s = byId.get(session_id);
      return s ? s.turns.map((t) => turnLine(s, t)).join("\n") : `没有会话 ${session_id}。`;
    },
    read_turns({ session_id, turns }) {
      const s = byId.get(session_id);
      if (!s) return `没有会话 ${session_id}。`;
      const wanted = (Array.isArray(turns) ? turns : [turns]).map(Number);
      const rows = s.turns.filter((t) => wanted.includes(t.n));
      if (!rows.length) return `会话 ${session_id} 没有第 ${wanted.join("、")} 轮。`;
      return rows.map((t) => `[${s.id} #${t.n}] ${minute(t.time)}\n${s.member}：${t.request}\nAgent：${t.reply}`).join("\n\n");
    },
    search_history({ keyword }) {
      const word = String(keyword ?? "").trim();
      if (!word) return "关键词为空。";
      const hits = sessions.flatMap((s) => s.turns.filter((t) => `${t.request}\n${t.reply}`.includes(word)).map((t) => turnLine(s, t)));
      return hits.length ? hits.slice(0, 20).join("\n") : `没有包含「${word}」的轮次。`;
    }
  };
}

async function chat(config, messages, { withTools = true } = {}) {
  const response = await fetch(`${config.baseUrl.replace(/\/chat\/completions$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, temperature: 0, max_tokens: 2048, messages, ...(withTools ? { tools: HISTORY_TOOLS } : {}) })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`${config.model} ${response.status}: ${JSON.stringify(body).slice(0, 300)}`), { status: response.status });
  return body;
}

async function chatWithRetry(config, messages, options) {
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { return await chat(config, messages, options); }
    catch (error) { last = error; await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1) * (error.status === 429 ? 5 : 1))); }
  }
  throw last;
}

// One question: the model calls tools until it answers or runs out of steps; the last step forbids
// tools so it must answer from what it has read.
export async function answerFromHistory({ question, sessions, call }) {
  const tools = historyTools(sessions);
  const messages = [
    { role: "system", content: HISTORY_SYSTEM },
    { role: "user", content: `# System Context\n- 当前时间：${question.askedAt}\n\n# 问题\n${question.question}` }
  ];
  const trace = [];
  // Every reader call keeps its own tokens and latency, so cost tiers and percentiles apply per call.
  const usage = { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, perCall: [] };
  const started = performance.now();
  const done = (fields) => ({ ...fields, trace, usage, wallclockMs: Math.round(performance.now() - started) });
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const last = step === MAX_STEPS - 1;
    const callStarted = performance.now();
    const at = new Date().toISOString();
    const body = await call(last ? [...messages, { role: "user", content: "请直接根据已读到的历史作答，不再调用工具。" }] : messages, { withTools: !last });
    const latencyMs = Math.round(performance.now() - callStarted);
    const buckets = tokenBuckets(body.usage) ?? { cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    usage.calls += 1;
    usage.inputTokens += buckets.cacheWriteTokens;
    usage.cachedInputTokens += buckets.cacheReadTokens;
    usage.outputTokens += buckets.outputTokens;
    usage.perCall.push({ at, latencyMs, inputTokens: buckets.cacheWriteTokens, cachedInputTokens: buckets.cacheReadTokens, outputTokens: buckets.outputTokens });
    const message = body.choices?.[0]?.message ?? {};
    const calls = message.tool_calls ?? [];
    if (!calls.length) return done({ answer: String(message.content ?? "").trim(), steps: step + 1 });
    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: calls });
    for (const toolCall of calls) {
      let args = {};
      try { args = JSON.parse(toolCall.function?.arguments || "{}"); } catch { args = {}; }
      const handler = tools[toolCall.function?.name];
      const result = handler ? handler(args) : `没有工具 ${toolCall.function?.name}。`;
      trace.push({ tool: toolCall.function?.name, args, chars: result.length });
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
    }
  }
  return done({ answer: "", steps: MAX_STEPS, exhausted: true });
}

export function trapTextsOf(question) {
  return question.trapItems.filter((trap) => trap.kind !== "space-isolation").flatMap((trap) => trap.texts ?? [trap.text]);
}

// Answer accuracy plus the reader's cost of reading raw history: tokens, calls, time and USD
// (pricing.json, per call; null when the model has no price). The judge is not part of the cost.
export function summarize(rows, { model = null, pricing = null } = {}) {
  const ratio = (n, d) => (d ? n / d : 0);
  const calls = rows.flatMap((r) => (r.usage.perCall ?? []).map((c) => ({ ...c, model })));
  const priced = pricing && model ? priceCalls(calls, pricing) : { costUsd: null, reason: "no pricing" };
  const times = rows.map((r) => r.wallclockMs).filter((ms) => Number.isFinite(ms));
  const latencies = calls.map((c) => c.latencyMs).filter((ms) => Number.isFinite(ms));
  const byKind = {};
  for (const row of rows) (byKind[row.kind] ??= []).push(row);
  const tokens = rows.reduce((t, r) => ({ calls: t.calls + r.usage.calls, input: t.input + r.usage.inputTokens + r.usage.cachedInputTokens, output: t.output + r.usage.outputTokens }), { calls: 0, input: 0, output: 0 });
  return {
    "answers.llm": ratio(rows.filter((r) => r.verdict.correct).length, rows.length),
    ...Object.fromEntries(Object.entries(byKind).map(([kind, list]) => [`answers.llm.${kind}`, ratio(list.filter((r) => r.verdict.correct).length, list.length)])),
    questions: rows.length,
    meanSteps: ratio(rows.reduce((t, r) => t + r.steps, 0), rows.length),
    exhausted: rows.filter((r) => r.exhausted).length,
    readerCalls: tokens.calls,
    readerInputTokensPerQuestion: Math.round(ratio(tokens.input, rows.length)),
    readerOutputTokensPerQuestion: Math.round(ratio(tokens.output, rows.length)),
    readerInputTokens: tokens.input,
    readerCachedInputTokens: rows.reduce((t, r) => t + r.usage.cachedInputTokens, 0),
    readerOutputTokens: tokens.output,
    readerCostUsd: priced.costUsd,
    readerCostPerQuestionUsd: priced.costUsd === null ? null : ratio(priced.costUsd, rows.length),
    ...(priced.reason ? { readerCostNote: priced.reason } : {}),
    questionWallclockMs: { total: times.reduce((t, ms) => t + ms, 0), mean: Math.round(ratio(times.reduce((t, ms) => t + ms, 0), times.length)), p50: percentile(times, 50), p95: percentile(times, 95) },
    readerCallLatencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) }
  };
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" }, only: { type: "string" }, concurrency: { type: "string" } } });
  if (!values.out) throw new Error("--out <directory> is required");
  const outDir = resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  const reader = resolveModelConfig("MEMMY_EVAL_READER");
  const judgeConfig = resolveModelConfig("MEMMY_EVAL_JUDGE");
  if (!reader || !judgeConfig) throw new Error("Configure MEMMY_EVAL_READER_* and MEMMY_EVAL_JUDGE_* (run through harness/model-env.mjs)");
  assertJudgeFamily(judgeConfig, reader.model);
  const ds = loadDataset();
  const gold = goldFor(ds, { flush: true });
  const only = values.only ? new Set(values.only.split(",")) : null;
  const questions = gold.questions.filter((q) => !q.excluded && (!only || only.has(q.id)));
  const judgeLlm = createLlm({ config: judgeConfig, cachePath: join(outDir, "judge-cache.json") });
  const judge = createJudge(judgeLlm);
  const partial = join(outDir, "history-run.partial.json");
  const done = existsSync(partial) ? JSON.parse(readFileSync(partial, "utf8")) : { rows: [] };
  const finished = new Set(done.rows.map((r) => r.id));
  const call = (messages, options) => chatWithRetry(reader, messages, options);
  const width = Math.max(1, Number(values.concurrency ?? 3));
  const runStarted = new Date();
  const queue = questions.filter((q) => !finished.has(q.id));
  async function worker() {
    for (let q = queue.shift(); q; q = queue.shift()) {
      const sessions = historyFor(ds, q);
      const result = await answerFromHistory({ question: q, sessions, call });
      const verdict = await judge.answer(q, result.answer, trapTextsOf(q));
      done.rows.push({ id: q.id, kind: q.kind, askedAt: q.askedAt, sessions: sessions.length, turns: sessions.reduce((t, s) => t + s.turns.length, 0), ...result, verdict });
      writeFileSync(partial, `${JSON.stringify(done, null, 2)}\n`);
      console.log(`${done.rows.length}/${questions.length} ${q.id} ${verdict.correct ? "OK " : "BAD"} steps=${result.steps}`);
    }
  }
  await Promise.all(Array.from({ length: width }, worker));
  judgeLlm.save();
  done.rows.sort((a, b) => questions.findIndex((q) => q.id === a.id) - questions.findIndex((q) => q.id === b.id));
  const pricing = JSON.parse(readFileSync(PRICING_PATH, "utf8"));
  const report = {
    kind: "history-baseline", promptVersion: HISTORY_PROMPT_VERSION, maxSteps: MAX_STEPS,
    // Wall time of this invocation (questions run `concurrency` at a time; judge calls included).
    startedAt: runStarted.toISOString(), endedAt: new Date().toISOString(), wallclockMs: Date.now() - runStarted.getTime(), concurrency: width,
    goldRevision: gold.goldRevision, reader: { model: reader.model }, judge: { model: judgeConfig.model, usage: { calls: judgeLlm.usage.calls, cacheHits: judgeLlm.usage.cacheHits } },
    scores: summarize(done.rows, { model: reader.model, pricing }), rows: done.rows
  };
  writeFileSync(join(outDir, "history-run.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.scores));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(String(error.message ?? error)); process.exitCode = 1; }
}

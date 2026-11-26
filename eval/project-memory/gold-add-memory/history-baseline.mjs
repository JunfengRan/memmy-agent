#!/usr/bin/env node
// Blank control for the v3 eval: no memory system at all. The reader is told how many projects there
// are, where each project's directory is, and that its sessions are files under sessions/; it reads them
// with generic file tools (list_dir, read_file, grep). Session files are raw transcripts of the turns
// submitted before the question was asked, one file per session. Nothing is summarized, outlined,
// deduplicated or resolved, and nothing produced by MemOS is shown. The answer rules are the MemOS
// reader's, and answers are judged with the same judge, gold answers and trap texts as
// run-pipeline-eval.mjs, so answers.llm compares 1:1.
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
import { displayNames } from "./oracle.mjs";

// v1 (structured session index, turn outlines, scoped to the question's Space) is in git history.
export const HISTORY_PROMPT_VERSION = 2;
export const MAX_STEPS = 12;
const ROOT = "/history";
const READ_LINES = 200;
const GREP_HITS = 30;
const PRICING_PATH = fileURLToPath(new URL("./pricing.json", import.meta.url));

const minute = (iso) => String(iso ?? "").slice(0, 16).replace("T", " ");

// The files one question may see: every project's sessions, holding only turns submitted (accepted)
// before askedAt. Returns {projects: [{name, dir}], files: Map(path → text)}.
export function historyFiles(ds, question) {
  const { spaceNames, memberNames } = displayNames(ds);
  const files = new Map();
  for (const conversation of ds.corpus.conversations) {
    const turns = ds.corpus.traces
      .filter((trace) => trace.conversation === conversation.id && Date.parse(acceptedTime(trace)) <= Date.parse(question.askedAt))
      .sort((a, b) => Date.parse(a.chat_time) - Date.parse(b.chat_time) || a.id.localeCompare(b.id));
    if (!turns.length) continue;
    const member = memberNames[conversation.user_id] ?? conversation.user_id;
    const lines = [`# 会话 ${conversation.id}（成员 ${member}，Agent ${conversation.agent_id}）`, ""];
    for (const trace of turns) {
      lines.push(`[${minute(trace.chat_time)}] ${member}：${trace.query}`);
      lines.push(`[${minute(trace.reply_time)}] Agent：${trace.answer}`);
    }
    files.set(`${ROOT}/${spaceNames[conversation.space_id]}/sessions/${conversation.id}.md`, `${lines.join("\n")}\n`);
  }
  const projects = ds.corpus.spaces.map((space) => ({ name: spaceNames[space.space_id], dir: `${ROOT}/${spaceNames[space.space_id]}` }));
  return { projects, files, current: spaceNames[question.space_id] };
}

export function historySystem({ projects, current }) {
  return `你是一个编码 Agent，正在回答项目成员的问题。你没有整理过的项目记忆，只有各项目的历史会话记录文件，可以用 list_dir、read_file、grep 查看。
项目历史在 ${ROOT} 下，共 ${projects.length} 个项目：${projects.map((p) => `${p.name}（${p.dir}）`).join("、")}。每个项目的会话记录在该项目目录的 sessions/ 下，一个会话一个文件。
这个问题来自项目 ${current}。只能依据读到的历史回答，不能用常识补充项目细节。
- 用一到三句中文直接回答当前状态。
- 历史里某项做法带有不一致结论且与问题相关时，列出各项结论及其成员，说明尚未确定。
- 历史里没有能回答问题的内容时，只回答「记忆中没有相关内容」。`;
}

export const HISTORY_TOOLS = [
  { type: "function", function: { name: "list_dir", description: "列出目录下的子目录和文件（文件带行数）。", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "read_file", description: `读取文件，带行号；可给起止行号（从 1 开始），一次最多 ${READ_LINES} 行。`, parameters: { type: "object", properties: { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } }, required: ["path"] } } },
  { type: "function", function: { name: "grep", description: `在目录或文件里按关键词（子串，不区分大小写）查找行，返回 路径:行号: 内容，最多 ${GREP_HITS} 条。`, parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } } }
];

// Generic file tools over one question's files. Bad paths answer with an error text the model can
// read, never an exception.
export function historyTools({ files }) {
  const norm = (path) => `/${String(path ?? ROOT).split("/").filter(Boolean).join("/")}`;
  const under = (dir) => [...files.keys()].filter((path) => path === dir || path.startsWith(`${dir}/`));
  return {
    list_dir({ path }) {
      const dir = norm(path);
      if (files.has(dir)) return `${dir} 是文件。`;
      const entries = new Map();
      for (const file of under(dir)) {
        const [head, ...rest] = file.slice(dir.length + 1).split("/");
        entries.set(head, rest.length ? `${head}/` : `${head}（${files.get(file).split("\n").length - 1} 行）`);
      }
      return entries.size ? [...entries.values()].sort().join("\n") : `${dir} 不存在或为空。`;
    },
    read_file({ path, start = 1, end }) {
      const file = norm(path);
      const text = files.get(file);
      if (text === undefined) return `没有文件 ${file}。`;
      const lines = text.split("\n").slice(0, -1);
      const from = Math.max(1, Number(start) || 1);
      const to = Math.min(lines.length, Number(end) || lines.length, from + READ_LINES - 1);
      return lines.slice(from - 1, to).map((line, i) => `${from + i}: ${line}`).join("\n") || "（没有内容）";
    },
    grep({ pattern, path }) {
      const word = String(pattern ?? "").trim().toLowerCase();
      if (!word) return "关键词为空。";
      const hits = [];
      for (const file of under(norm(path)).sort()) {
        files.get(file).split("\n").forEach((line, i) => { if (line.toLowerCase().includes(word)) hits.push(`${file}:${i + 1}: ${line}`); });
      }
      return hits.length ? hits.slice(0, GREP_HITS).join("\n") : `没有包含「${pattern}」的行。`;
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
export async function answerFromHistory({ question, history, call }) {
  const tools = historyTools(history);
  const messages = [
    { role: "system", content: historySystem(history) },
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
      const history = historyFiles(ds, q);
      const result = await answerFromHistory({ question: q, history, call });
      const verdict = await judge.answer(q, result.answer, trapTextsOf(q));
      done.rows.push({ id: q.id, kind: q.kind, askedAt: q.askedAt, files: history.files.size, ...result, verdict });
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

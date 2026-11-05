#!/usr/bin/env node
/**
 * Replays dataset v2 against a MemOS server through the spec API only (v3 §1.6, §2.2, §3.2, §4):
 *   create/space (space_name only; MemOS generates space_id) → create/domains → add/message per
 *   turn → get/status until done → search/memory at each askedAt → get/memory per space for the
 *   final state → API checks (api-checks.mjs).
 * Answers come from a fixed reader model given the template-three rendering of topic_detail_list.
 *
 * Usage:
 *   node run-memmy-live-eval.mjs                               full replay
 *   node run-memmy-live-eval.mjs --api-checks-only <live-run.json>
 *       re-run only the API checks against the spaces of an earlier run (no reader needed)
 *
 * Env:
 *   MEMMY_EVAL_BASE        default http://127.0.0.1:18960/api/openmem/v1
 *   MEMMY_EVAL_MODE        X-MemOS-Mode, default local
 *   MEMMY_EVAL_API_KEY     optional Authorization bearer
 *   MEMMY_EVAL_SUT_MODEL   model the server uses for M02/M04/M05 (recorded; the judge must differ in family)
 *   MEMMY_EVAL_READER_{PROVIDER,MODEL,BASE_URL,API_KEY}   fixed reader model (required for a replay)
 *   MEMMY_EVAL_RUN_TAG     suffix for space_name / conversation_id, default the run stamp
 *   MEMMY_EVAL_TASK_TIMEOUT_MS  per add_message task, default 300000
 * Output: eval/project-memory/runs/<stamp>/live-run.json (api-checks.json for --api-checks-only);
 * on any HTTP or task error, live-run.partial.json with the error, and exit 1.
 *
 * Every request is recorded as {call, phase, poll, at, ms, status, code}; phase is setup / add /
 * search / final / check, poll marks get/status. Each task records accepted → completed time.
 * Nothing here is added to the product request or response.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runApiChecks } from "./api-checks.mjs";
import { loadDataset, orderedTraces } from "./build-gold-baseline.mjs";
import { createLlm, resolveModelConfig } from "./llm.mjs";
import { loadGold } from "./load-eval-set.mjs";
import { displayNames } from "./oracle.mjs";
import { createReader, renderTemplate3 } from "./reader.mjs";
import { RUNS_DIR } from "./run-pipeline-eval.mjs";

export const RUNNER_REVISION = 2;
const argv = process.argv.slice(2);
const checksOnlyIndex = argv.indexOf("--api-checks-only");
const checksOnly = checksOnlyIndex >= 0 ? JSON.parse(readFileSync(argv[checksOnlyIndex + 1] ?? "", "utf8")) : null;
const base = (process.env.MEMMY_EVAL_BASE ?? "http://127.0.0.1:18960/api/openmem/v1").replace(/\/+$/, "");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const tag = checksOnly?.runTag ?? process.env.MEMMY_EVAL_RUN_TAG ?? stamp;
const taskTimeoutMs = Number(process.env.MEMMY_EVAL_TASK_TIMEOUT_MS ?? 300_000);
const outDir = join(RUNS_DIR, stamp);
const headers = {
  "content-type": "application/json",
  "X-MemOS-Mode": process.env.MEMMY_EVAL_MODE ?? "local",
  "X-MemOS-TZ": "+08:00",
  ...(process.env.MEMMY_EVAL_API_KEY ? { authorization: `Bearer ${process.env.MEMMY_EVAL_API_KEY}` } : {})
};

class ApiError extends Error {
  constructor(call, status, body) {
    super(`${call} failed: HTTP ${status} ${JSON.stringify(body).slice(0, 400)}`);
    Object.assign(this, { call, status, body });
  }
}

const ds = loadDataset();
const gold = loadGold();
let readerConfig = null;
let readerLlm = null;
let reader = null;
if (!checksOnly) {
  readerConfig = resolveModelConfig("MEMMY_EVAL_READER");
  if (!readerConfig) {
    console.error("reader not configured: set MEMMY_EVAL_READER_PROVIDER / _MODEL / _BASE_URL / _API_KEY");
    process.exit(2);
  }
  readerLlm = createLlm({ config: readerConfig, cachePath: join(RUNS_DIR, "reader-cache.json") });
  reader = createReader(readerLlm);
}
const names = displayNames(ds);
// Filled from create/space responses (MemOS generates space_id); --api-checks-only reuses the earlier run's.
const spaceMap = { ...(checksOnly?.spaceMap ?? {}) };
const conversationIds = Object.fromEntries(ds.corpus.conversations.map((c) => [c.id, `${c.conversation_id}:${tag}`]));
const conversations = new Map(ds.corpus.conversations.map((c) => [c.id, c]));
const memberName = (id) => names.memberNames[id] ?? id;
const run = {
  runVersion: 2,
  runnerRevision: RUNNER_REVISION,
  kind: checksOnly ? "api-checks" : "live",
  startedAt: new Date().toISOString(),
  base,
  mode: headers["X-MemOS-Mode"],
  runTag: tag,
  sut: { model: process.env.MEMMY_EVAL_SUT_MODEL ?? checksOnly?.sut?.model ?? null },
  reader: readerConfig ? { model: readerConfig.model, provider: readerConfig.provider } : null,
  spaceMap,
  tasks: [],
  questions: [],
  final: {},
  apiChecks: [],
  requests: [],
  phaseMs: {},
  usage: {}
};

let phase = "setup";
async function timed(name, fn) {
  const previous = phase;
  phase = name;
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    run.phaseMs[name] = (run.phaseMs[name] ?? 0) + (performance.now() - startedAt);
    phase = previous;
  }
}

// Envelope {code, message, data}; code 0 is success. strict=false returns failures instead of throwing.
async function call(path, body, { strict = true, method = "POST" } = {}) {
  const at = Date.now();
  const startedAt = performance.now();
  let status = 0;
  let payload;
  try {
    const response = await fetch(`${base}${path}`, { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
    status = response.status;
    payload = await response.json().catch(() => ({ code: -1, message: "non-JSON response" }));
  } catch (error) {
    payload = { code: -1, message: String(error.message ?? error) };
  }
  const endedAt = performance.now();
  const ms = endedAt - startedAt;
  run.requests.push({ call: path, phase, poll: path === "/get/status", at, status, code: payload?.code ?? null, ms });
  const ok = status >= 200 && status < 300 && payload?.code === 0;
  if (!ok && strict) throw new ApiError(path, status, payload);
  return { ok, status, code: payload?.code, message: payload?.message, data: payload?.data, ms, endedAt };
}

const localTime = (iso) => iso.slice(0, 19).replace("T", " ");

// Returns the final status plus when the poll that saw it returned (performance.now()), the number
// of polls and the sleep before that poll (completion happened at most that long earlier).
async function waitTask(taskId, label) {
  const deadline = Date.now() + taskTimeoutMs;
  let polls = 0;
  let lastSleepMs = 0;
  for (let delay = 200; ; delay = Math.min(delay * 2, 1_000)) {
    const r = await call("/get/status", { task_id: taskId });
    polls += 1;
    if (r.data?.status === "completed" || r.data?.status === "failed") return { ...r.data, observedAt: r.endedAt, polls, lastSleepMs };
    if (Date.now() > deadline) throw new Error(`${label}: task ${taskId} still ${r.data?.status} after ${taskTimeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    lastSleepMs = delay;
  }
}

function addBody(trace, overrides = {}) {
  const c = conversations.get(trace.conversation);
  return {
    user_id: c.user_id,
    agent_id: c.agent_id,
    conversation_id: conversationIds[c.id],
    space_ids: [spaceMap[c.space_id]],
    domains: [trace.domain],
    allow_memory_view: ["project"],
    async_mode: true,
    messages: [
      { role: "user", role_id: c.user_id, role_name: memberName(c.user_id), chat_time: localTime(trace.chat_time), content: trace.query },
      { role: "assistant", chat_time: localTime(trace.reply_time), content: trace.answer }
    ],
    ...overrides
  };
}

function searchBody(conversation, query) {
  const c = conversations.get(conversation);
  return {
    user_id: c.user_id,
    query,
    conversation_id: conversationIds[c.id],
    space_ids: [spaceMap[c.space_id]],
    include_memory_view: ["project"],
    memory_limit_number: 9
  };
}

async function search(conversation, query) {
  const { data } = await timed("search", () => call("/search/memory", searchBody(conversation, query)));
  return data?.topic_detail_list ?? [];
}

async function readSpace(space) {
  const topics = [];
  for (let page = 1; ; page += 1) {
    const { data } = await call("/get/memory", { space_id: spaceMap[space], page, size: 50 });
    topics.push(...(data?.topic_detail_list ?? []));
    if (!data?.pages || page >= data.pages) return topics;
  }
}

async function ask(question) {
  const topics = await search(question.conversation, question.question);
  const rendered = renderTemplate3({ topics, now: question.askedAt, spaceNames: Object.fromEntries(Object.entries(spaceMap).map(([k, v]) => [v, names.spaceNames[k]])), memberNames: names.memberNames });
  const answer = await timed("reader", () => reader.answer(question, rendered));
  run.questions.push({ id: question.id, askedAt: question.askedAt, topic_detail_list: topics, rendered, answer });
}

async function apiChecks() {
  run.apiChecks = await timed("check", () => runApiChecks({ gold, ds, spaceMap, call, searchBody, addBody, waitTask, readSpace }));
}

function save(name) {
  mkdirSync(outDir, { recursive: true });
  if (readerLlm) run.usage.reader = { ...readerLlm.usage, latencyMs: undefined };
  const path = join(outDir, name);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
  readerLlm?.save();
  return path;
}

const started = performance.now();
if (checksOnly) {
  await apiChecks();
  run.wallclockMs = performance.now() - started;
  const passed = run.apiChecks.filter((c) => c.passed).length;
  console.log(JSON.stringify({ out: save("api-checks.json"), passRate: passed / gold.apiChecks.length, apiChecks: run.apiChecks.map((c) => `${c.id}:${c.passed}`) }));
  process.exit(passed === gold.apiChecks.length ? 0 : 1);
}
try {
  await timed("setup", async () => {
    for (const space of ds.corpus.spaces) {
      const { space_id: datasetId, domains, ...rest } = space;
      const created = await call("/create/space", { ...rest, space_name: `${datasetId}_${tag}`, domains: [] });
      if (!created.data?.space_id) throw new Error(`${datasetId}: create/space returned no space_id`);
      spaceMap[datasetId] = created.data.space_id;
      await call("/create/domains", { space_id: spaceMap[datasetId], domains });
      const listed = await call("/list/domains", { space_id: spaceMap[datasetId] }, { strict: false });
      if (listed.ok && (listed.data?.domains ?? []).length !== domains.length) throw new Error(`${datasetId}: list/domains returned ${listed.data?.domains?.length} domains, expected ${domains.length}`);
      const existing = await readSpace(datasetId);
      if (existing.length) throw new Error(`${spaceMap[datasetId]} (${datasetId}) is not empty after create/space`);
    }
  });

  const questions = gold.questions.filter((q) => !q.excluded);
  const events = [
    ...orderedTraces(ds.corpus).map((trace) => ({ at: trace.chat_time, order: 0, trace })),
    ...questions.map((question) => ({ at: question.askedAt, order: 1, question }))
  ].sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  for (const event of events) {
    if (event.question) { await ask(event.question); continue; }
    const { trace } = event;
    if (trace.searchBefore) {
      const topics = await search(trace.conversation, trace.searchBefore.query);
      run.tasks.push({ trace: trace.id, searchBefore: true, topics: topics.map((t) => t.id) });
    }
    await timed("add", async () => {
      const accepted = await call("/add/message", addBody(trace));
      const taskId = accepted.data?.task_id;
      if (!taskId) throw new Error(`${trace.id}: add/message returned no task_id`);
      const status = await waitTask(taskId, trace.id);
      run.tasks.push({
        trace: trace.id, task_id: taskId, status: status.status, memory_views: status.memory_views ?? null, error: status.error ?? null,
        acceptMs: accepted.ms,
        completedMs: status.observedAt - accepted.endedAt, polls: status.polls, detectionSlackMs: status.lastSleepMs
      });
      if (status.status === "failed") throw new Error(`${trace.id}: task ${taskId} failed: ${JSON.stringify(status.error)}`);
    });
  }

  await timed("final", async () => {
    for (const space of ds.corpus.spaces) run.final[space.space_id] = await readSpace(space.space_id);
  });
  await apiChecks();
  run.wallclockMs = performance.now() - started;
  console.log(JSON.stringify({ out: save("live-run.json"), questions: run.questions.length, tasks: run.tasks.length, apiChecks: run.apiChecks.map((c) => `${c.id}:${c.passed}`) }));
} catch (error) {
  run.wallclockMs = performance.now() - started;
  run.error = { message: String(error.message ?? error), call: error.call ?? null, status: error.status ?? null, body: error.body ?? null };
  console.error(`live eval aborted: ${run.error.message}\npartial output: ${save("live-run.partial.json")}`);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Replays dataset v2 against a MemOS server through the spec API only (v3 §1.6, §2.2, §3.2, §4):
 *   create/space (with domains) → create/domains → add/message per turn → get/status until done
 *   → search/memory at each askedAt → get/memory per space for the final state → API checks.
 * Answers come from a fixed reader model given the template-three rendering of topic_detail_list.
 *
 * Env:
 *   MEMMY_EVAL_BASE        default http://127.0.0.1:18960/api/openmem/v1
 *   MEMMY_EVAL_MODE        X-MemOS-Mode, default local
 *   MEMMY_EVAL_API_KEY     optional Authorization bearer
 *   MEMMY_EVAL_SUT_MODEL   model the server uses for M02/M04/M05 (recorded; the judge must differ in family)
 *   MEMMY_EVAL_READER_{PROVIDER,MODEL,BASE_URL,API_KEY}   fixed reader model (required)
 *   MEMMY_EVAL_RUN_TAG     suffix for space_id / conversation_id, default the run stamp
 *   MEMMY_EVAL_TASK_TIMEOUT_MS  per add_message task, default 300000
 * Output: eval/project-memory/runs/<stamp>/live-run.json; on any HTTP or task error,
 * live-run.partial.json with the error, and exit 1.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDataset, orderedTraces } from "./build-gold-baseline.mjs";
import { createLlm, resolveModelConfig } from "./llm.mjs";
import { loadGold } from "./load-eval-set.mjs";
import { displayNames } from "./oracle.mjs";
import { createReader, renderTemplate3 } from "./reader.mjs";
import { RUNS_DIR } from "./run-pipeline-eval.mjs";

const base = (process.env.MEMMY_EVAL_BASE ?? "http://127.0.0.1:18960/api/openmem/v1").replace(/\/+$/, "");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const tag = process.env.MEMMY_EVAL_RUN_TAG ?? stamp;
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
const readerConfig = resolveModelConfig("MEMMY_EVAL_READER");
if (!readerConfig) {
  console.error("reader not configured: set MEMMY_EVAL_READER_PROVIDER / _MODEL / _BASE_URL / _API_KEY");
  process.exit(2);
}
const readerLlm = createLlm({ config: readerConfig, cachePath: join(RUNS_DIR, "reader-cache.json") });
const reader = createReader(readerLlm);
const names = displayNames(ds);
const spaceMap = Object.fromEntries(ds.corpus.spaces.map((s) => [s.space_id, `${s.space_id}_${tag}`]));
const conversationIds = Object.fromEntries(ds.corpus.conversations.map((c) => [c.id, `${c.conversation_id}:${tag}`]));
const conversations = new Map(ds.corpus.conversations.map((c) => [c.id, c]));
const memberName = (id) => names.memberNames[id] ?? id;
const run = {
  runVersion: 2,
  kind: "live",
  startedAt: new Date().toISOString(),
  base,
  mode: headers["X-MemOS-Mode"],
  runTag: tag,
  sut: { model: process.env.MEMMY_EVAL_SUT_MODEL ?? null },
  reader: { model: readerConfig.model, provider: readerConfig.provider },
  spaceMap,
  tasks: [],
  questions: [],
  final: {},
  apiChecks: [],
  requests: [],
  usage: {}
};

// Envelope {code, message, data}; code 0 is success. strict=false returns failures instead of throwing.
async function call(path, body, { strict = true, method = "POST" } = {}) {
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
  run.requests.push({ call: path, status, code: payload?.code ?? null, ms: performance.now() - startedAt });
  const ok = status >= 200 && status < 300 && payload?.code === 0;
  if (!ok && strict) throw new ApiError(path, status, payload);
  return { ok, status, code: payload?.code, message: payload?.message, data: payload?.data };
}

const localTime = (iso) => iso.slice(0, 19).replace("T", " ");

async function waitTask(taskId, label) {
  const deadline = Date.now() + taskTimeoutMs;
  for (let delay = 200; ; delay = Math.min(delay * 2, 3_000)) {
    const { data } = await call("/get/status", { task_id: taskId });
    if (data?.status === "completed") return data;
    if (data?.status === "failed") return data;
    if (Date.now() > deadline) throw new Error(`${label}: task ${taskId} still ${data?.status} after ${taskTimeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, delay));
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

async function search(conversation, query) {
  const c = conversations.get(conversation);
  const { data } = await call("/search/memory", {
    user_id: c.user_id,
    query,
    conversation_id: conversationIds[c.id],
    space_ids: [spaceMap[c.space_id]],
    include_memory_view: ["project"],
    memory_limit_number: 9
  });
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
  const answer = await reader.answer(question, rendered);
  run.questions.push({ id: question.id, askedAt: question.askedAt, topic_detail_list: topics, rendered, answer });
}

async function apiChecks() {
  for (const check of gold.apiChecks) {
    const result = { id: check.id, passed: false };
    if (check.id === "search_requires_space_ids") {
      const r = await call("/search/memory", { user_id: "u_lin", query: "月报的金额现在从哪里取？", conversation_id: conversationIds["ledger-ask"], include_memory_view: ["project"], memory_limit_number: 9 }, { strict: false });
      Object.assign(result, { passed: !r.ok, status: r.status, code: r.code, message: r.message, returned: r.data?.topic_detail_list?.length ?? 0 });
    } else if (check.id === "add_requires_space_ids") {
      const trace = ds.corpus.traces.find((t) => t.conversation === "ledger-build");
      const { space_ids, ...body } = addBody(trace, { conversation_id: `${conversationIds["ledger-build"]}:check` });
      const r = await call("/add/message", body, { strict: false });
      Object.assign(result, { passed: !r.ok, status: r.status, code: r.code, message: r.message });
    } else if (check.id === "search_space_isolation") {
      const foreign = new Set((run.final.space_ledger ?? []).map((t) => t.id));
      const leaks = [];
      for (const qid of check.questionTexts) {
        const question = gold.questions.find((q) => q.id === qid);
        const topics = await search("catalog-ask", question.question);
        for (const topic of topics) if (topic.space_id !== spaceMap.space_catalog || foreign.has(topic.id)) leaks.push({ question: qid, topic: topic.id, space_id: topic.space_id });
      }
      Object.assign(result, { passed: leaks.length === 0, leaks });
    } else if (check.id === "add_unregistered_domain") {
      const before = (await readSpace("space_ledger")).length;
      const trace = ds.corpus.traces.find((t) => t.conversation === "ledger-build");
      const r = await call("/add/message", addBody(trace, { domains: [check.domain], conversation_id: `${conversationIds["ledger-build"]}:domain-check` }), { strict: false });
      let status = null;
      if (r.ok && r.data?.task_id) status = await waitTask(r.data.task_id, check.id);
      const after = (await readSpace("space_ledger")).length;
      const rejected = r.message === "DOMAIN_INVALID" || r.code === 40002 || (status?.status === "failed" && JSON.stringify(status.error ?? {}).includes("DOMAIN_INVALID"));
      Object.assign(result, { passed: rejected && after === before, status: r.status, code: r.code, message: r.message, task: status, topicsBefore: before, topicsAfter: after });
    } else {
      Object.assign(result, { detail: "no runner for this check" });
    }
    run.apiChecks.push(result);
  }
}

function save(name) {
  mkdirSync(outDir, { recursive: true });
  run.usage.reader = { ...readerLlm.usage, latencyMs: undefined };
  const path = join(outDir, name);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
  readerLlm.save();
  return path;
}

const started = performance.now();
try {
  for (const space of ds.corpus.spaces) {
    const { domains, ...rest } = space;
    await call("/create/space", { ...rest, space_id: spaceMap[space.space_id], domains: [] });
    await call("/create/domains", { space_id: spaceMap[space.space_id], domains });
    const listed = await call("/list/domains", { space_id: spaceMap[space.space_id] }, { strict: false });
    if (listed.ok && (listed.data?.domains ?? []).length !== domains.length) throw new Error(`${space.space_id}: list/domains returned ${listed.data?.domains?.length} domains, expected ${domains.length}`);
    const existing = await readSpace(space.space_id);
    if (existing.length) throw new Error(`${spaceMap[space.space_id]} is not empty; use a new MEMMY_EVAL_RUN_TAG`);
  }

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
    const accepted = await call("/add/message", addBody(trace));
    const taskId = accepted.data?.task_id;
    if (!taskId) throw new Error(`${trace.id}: add/message returned no task_id`);
    const status = await waitTask(taskId, trace.id);
    run.tasks.push({ trace: trace.id, task_id: taskId, status: status.status, memory_views: status.memory_views ?? null, error: status.error ?? null });
    if (status.status === "failed") throw new Error(`${trace.id}: task ${taskId} failed: ${JSON.stringify(status.error)}`);
  }

  for (const space of ds.corpus.spaces) run.final[space.space_id] = await readSpace(space.space_id);
  await apiChecks();
  run.wallclockMs = performance.now() - started;
  console.log(JSON.stringify({ out: save("live-run.json"), questions: run.questions.length, tasks: run.tasks.length, apiChecks: run.apiChecks.map((c) => `${c.id}:${c.passed}`) }));
} catch (error) {
  run.wallclockMs = performance.now() - started;
  run.error = { message: String(error.message ?? error), call: error.call ?? null, status: error.status ?? null, body: error.body ?? null };
  console.error(`live eval aborted: ${run.error.message}\npartial output: ${save("live-run.partial.json")}`);
  process.exit(1);
}

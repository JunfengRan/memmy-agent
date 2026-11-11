#!/usr/bin/env node
// Control replay for the legacy (pre-v0.1) project memory, commit 44dcbb1e^. The legacy server has
// no /api/openmem/v1, so this drives its /api/v1/memory/add and /api/v1/memory/search
// (include_memory_view: ["project"]) with the dataset v2 corpus: one add per turn (user + reply
// messages, no source_trace_id, no generate_answer), questions at askedAt, answers from the same
// fixed reader over the same template-three rendering, scored by run-pipeline-eval.mjs.
//
// Differences that cannot be removed, and must be stated next to the numbers:
//  - legacy topics have no history / conflicts; its entries are shown as decisions / experiences /
//    timeline items only, so conflict and stale questions are answered without that structure;
//  - legacy has no get_memory; the "final state" is the union of the topics returned by every
//    question and a few probe queries per space, so write-quality scores are lower bounds;
//  - space isolation and domain checks are not part of the legacy API, so api.passRate is 0 by
//    construction and is not comparable.
//
// Env: MEMMY_EVAL_ENDPOINT (default http://127.0.0.1:18961), MEMMY_EVAL_TOKEN,
//      MEMMY_EVAL_READER_{PROVIDER,MODEL,BASE_URL,API_KEY}, MEMMY_EVAL_SUT_MODEL.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDataset, orderedTraces, traceOrderTime } from "../build-gold-baseline.mjs";
import { createLlm, resolveModelConfig } from "../llm.mjs";
import { loadGold } from "../load-eval-set.mjs";
import { displayNames } from "../oracle.mjs";
import { createReader, renderTemplate3 } from "../reader.mjs";
import { RUNS_DIR } from "../run-pipeline-eval.mjs";

const ds = loadDataset();
const gold = loadGold();
const endpoint = (process.env.MEMMY_EVAL_ENDPOINT ?? "http://127.0.0.1:18961").replace(/\/$/, "");
const token = process.env.MEMMY_EVAL_TOKEN;
const readerConfig = resolveModelConfig("MEMMY_EVAL_READER");
if (!readerConfig) { console.error("reader not configured: set MEMMY_EVAL_READER_PROVIDER / _MODEL / _BASE_URL / _API_KEY"); process.exit(2); }
const readerLlm = createLlm({ config: readerConfig, cachePath: process.env.MEMMY_EVAL_READER_CACHE ?? join(RUNS_DIR, "reader-cache.json") });
const reader = createReader(readerLlm);
const names = displayNames(ds);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const userId = `project-memory-legacy-${stamp}`;
const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
const conversations = new Map(ds.corpus.conversations.map((c) => [c.id, c]));
const LIMIT = 9;
const run = {
  runVersion: 2, kind: "control-legacy", startedAt: new Date().toISOString(), base: endpoint,
  sut: { model: process.env.MEMMY_EVAL_SUT_MODEL ?? null }, reader: { model: readerConfig.model, provider: readerConfig.provider },
  spaceMap: Object.fromEntries(ds.corpus.spaces.map((s) => [s.space_id, s.space_id])),
  final: Object.fromEntries(ds.corpus.spaces.map((s) => [s.space_id, []])),
  questions: [], apiChecks: [], requests: [], phaseMs: {}, usage: {}
};

async function call(path, body, phase) {
  const at = Date.now();
  const startedAt = performance.now();
  const response = await fetch(`${endpoint}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  const ms = performance.now() - startedAt;
  run.requests.push({ call: path, phase, poll: false, at, status: response.status, ms });
  run.phaseMs[phase] = (run.phaseMs[phase] ?? 0) + ms;
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

// Legacy entry kinds: decision | experience | evolution. No history or conflicts exist.
function toSpecTopic(topic, spaceId, fallbackTime) {
  const item = (entry) => ({ content: entry.entry ?? entry.content ?? "", time: entry.changed_at ?? entry.update_time ?? fallbackTime, user_ids: entry.user_ids ?? [] });
  const entries = topic.entries ?? [];
  return {
    id: topic.topic_id ?? topic.id, space_id: spaceId, domain: topic.domain ?? "",
    topic_name: topic.topic_name ?? "", topic_summary: topic.topic_summary ?? "", topic_description: topic.topic_description ?? "",
    decisions: entries.filter((e) => e.kind === "decision").map(item),
    experiences: entries.filter((e) => e.kind === "experience").map(item),
    timeline: entries.filter((e) => e.kind === "evolution").map(item),
    relativity: topic.relativity, update_time: topic.update_time ?? fallbackTime
  };
}

async function search(spaceId, query, limit, phase) {
  const result = await call("/api/v1/memory/search", {
    user_id: userId, query, space_ids: spaceId, include_memory_view: ["project"], memory_limit_number: limit, generate_answer: false
  }, phase);
  return (result?.topic_detail_list ?? []).map((topic) => toSpecTopic(topic, spaceId, result?.server_time));
}

const outDir = join(RUNS_DIR, stamp);
function save(name) {
  mkdirSync(outDir, { recursive: true });
  run.usage.reader = { ...readerLlm.usage, latencyMs: undefined };
  writeFileSync(join(outDir, name), `${JSON.stringify(run, null, 2)}\n`);
  readerLlm.save();
  return join(outDir, name);
}

const started = performance.now();
try {
  const events = [
    ...orderedTraces(ds.corpus).map((trace) => ({ at: traceOrderTime(trace), order: 0, trace })),
    ...gold.questions.filter((q) => !q.excluded).map((question) => ({ at: question.askedAt, order: 1, question }))
  ].sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  const seen = new Map(ds.corpus.spaces.map((s) => [s.space_id, new Map()]));
  const remember = (spaceId, topics) => { for (const topic of topics) seen.get(spaceId).set(topic.id, topic); };
  for (const event of events) {
    if (event.trace) {
      const trace = event.trace;
      const conversation = conversations.get(trace.conversation);
      await call("/api/v1/memory/add", {
        user_id: conversation.user_id, conversation_id: trace.conversation, agent_id: conversation.agent_id,
        space_ids: conversation.space_id, domains: [trace.domain], allow_memory_view: ["project"],
        messages: [
          { role: "user", content: trace.query, chat_time: trace.chat_time, role_id: conversation.user_id },
          { role: "assistant", content: trace.answer, chat_time: trace.reply_time ?? trace.chat_time }
        ]
      }, "add");
      continue;
    }
    const q = event.question;
    const topics = (await search(q.space_id, q.question, LIMIT, "search")).slice(0, LIMIT);
    remember(q.space_id, topics);
    const rendered = renderTemplate3({ topics, now: q.askedAt, ...names });
    run.questions.push({ id: q.id, askedAt: q.askedAt, topic_detail_list: topics, rendered, answer: await reader.answer(q, rendered) });
  }
  for (const space of ds.corpus.spaces) {
    for (const probe of ["项目", "决策", "月报", "价格", "导出", "分支", "连接串"]) remember(space.space_id, await search(space.space_id, probe, 25, "final"));
    run.final[space.space_id] = [...seen.get(space.space_id).values()];
  }
  run.wallclockMs = performance.now() - started;
  console.log(JSON.stringify({ out: save("live-run.json"), questions: run.questions.length }));
} catch (error) {
  run.wallclockMs = performance.now() - started;
  run.error = { message: String(error.message ?? error) };
  console.error(`legacy replay aborted: ${run.error.message}\npartial output: ${save("live-run.partial.json")}`);
  process.exit(1);
}

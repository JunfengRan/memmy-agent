#!/usr/bin/env node
// Control replay for the main-branch build, which has no project memory: every turn is written
// as a plain L1 memory through the generic /api/v1 routes, and every question is answered by the
// same fixed reader from the generic search hits. Hits are wrapped as pseudo-topics (one timeline
// item each) so run-pipeline-eval.mjs scores the control with the same code. The control has no
// project state, so its write and decision scores are 0 by construction; only search and answer
// scores are comparable.
//
// Env: MEMMY_EVAL_ENDPOINT (default http://127.0.0.1:18961), MEMMY_EVAL_TOKEN,
//      MEMMY_EVAL_READER_{PROVIDER,MODEL,BASE_URL,API_KEY}, MEMMY_EVAL_SUT_MODEL.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDataset, orderedTraces } from "../build-gold-baseline.mjs";
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
const readerLlm = createLlm({ config: readerConfig, cachePath: join(RUNS_DIR, "reader-cache.json") });
const reader = createReader(readerLlm);
const names = displayNames(ds);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const namespace = { source: "codex", profileId: "default", userId: `project-memory-control-${stamp}` };
const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
const conversations = new Map(ds.corpus.conversations.map((c) => [c.id, c]));
const run = {
  runVersion: 2, kind: "control-main", startedAt: new Date().toISOString(), base: endpoint,
  sut: { model: process.env.MEMMY_EVAL_SUT_MODEL ?? null }, reader: { model: readerConfig.model, provider: readerConfig.provider },
  spaceMap: Object.fromEntries(ds.corpus.spaces.map((s) => [s.space_id, s.space_id])),
  final: Object.fromEntries(ds.corpus.spaces.map((s) => [s.space_id, []])),
  questions: [], apiChecks: [], requests: [], usage: {}
};

async function call(path, body) {
  const startedAt = performance.now();
  const response = await fetch(`${endpoint}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  run.requests.push({ call: path, status: response.status, ms: performance.now() - startedAt });
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
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
    ...orderedTraces(ds.corpus).map((trace) => ({ at: trace.chat_time, order: 0, trace })),
    ...gold.questions.filter((q) => !q.excluded).map((question) => ({ at: question.askedAt, order: 1, question }))
  ].sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  for (const event of events) {
    if (event.trace) {
      const space = conversations.get(event.trace.conversation).space_id;
      await call("/api/v1/memory/add", { namespace, content: `${event.trace.query}\n${event.trace.answer}`, layer: "L1", createdAt: event.trace.chat_time, tags: [`space:${space}`] });
      continue;
    }
    const q = event.question;
    const result = await call("/api/v1/memory/search", { namespace, query: q.question, limit: 9, filter: { tags: [`space:${q.space_id}`] }, includeInjectedContext: false, verbose: true });
    const hits = Array.isArray(result?.debug?.hits) ? result.debug.hits : [];
    const topics = hits.slice(0, 9).map((hit, index) => ({
      id: `hit_${q.id}_${index}`, space_id: q.space_id, domain: "", topic_name: "", topic_summary: "", topic_description: "",
      decisions: [], experiences: [], timeline: [{ content: hit.snippet ?? "", time: hit.createdAt ?? q.askedAt, user_ids: [] }], update_time: hit.createdAt ?? q.askedAt
    }));
    const rendered = renderTemplate3({ topics, now: q.askedAt, ...names });
    run.questions.push({ id: q.id, askedAt: q.askedAt, topic_detail_list: topics, rendered, answer: await reader.answer(q, rendered) });
  }
  run.wallclockMs = performance.now() - started;
  console.log(JSON.stringify({ out: save("live-run.json"), questions: run.questions.length }));
} catch (error) {
  run.wallclockMs = performance.now() - started;
  run.error = { message: String(error.message ?? error) };
  console.error(`control replay aborted: ${run.error.message}\npartial output: ${save("live-run.partial.json")}`);
  process.exit(1);
}

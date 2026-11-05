#!/usr/bin/env node
// Self-tests for the scorer and the API checks that need no server, judge or reader:
//   node selftest.mjs        exit 0 when every case passes
// Cases: R1-2 kind-aware matching probe, R1-1 API checks against refused / 404 / 500 / empty
// servers, R1-3 efficiency fields on new and old run shapes, R1-4 per-kind answer scores.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INVALID_PARAMS, DOMAIN_INVALID, runApiChecks } from "./api-checks.mjs";
import { loadDataset } from "./build-gold-baseline.mjs";
import { createJudge } from "./judge.mjs";
import { createLlm } from "./llm.mjs";
import { loadGold } from "./load-eval-set.mjs";
import { buildOracleRun } from "./oracle.mjs";
import { efficiency, scoreRun } from "./run-pipeline-eval.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const ds = loadDataset();
const gold = loadGold();
const judge = createJudge(createLlm({ config: null }));
const pricing = JSON.parse(readFileSync(join(root, "pricing.json"), "utf8"));
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("R1-2: a timeline write carrying dec_tz text, listed first, does not steal the decision match", async () => {
  const run = buildOracleRun(ds, gold);
  const tz = gold.entries.find((e) => e.id === "dec_tz");
  const probe = { id: "probe_extra", space_id: "space_ledger", domain: "代码开发", topic_name: "probe", topic_summary: "", topic_description: "", decisions: [], experiences: [], timeline: [{ content: tz.content, time: tz.time, user_ids: ["u_lin"] }] };
  run.final.space_ledger = [probe, ...run.final.space_ledger];
  const { scores, errors, detail } = await scoreRun(run, { ds, gold, judge });
  const row = detail.decisions.find((r) => r.id === "dec_tz");
  assert.deepEqual({ matched: row.matched, content: row.content, userIds: row.userIds, time: row.time }, { matched: true, content: true, userIds: true, time: true });
  assert.equal(scores["entries.decision.recall"], 1);
  assert.equal(errors["writes.duplicate"], 1);
  const duplicate = detail.writes.filter((w) => w.label === "match" && w.matched === null);
  assert.deepEqual(duplicate.map((w) => w.uid), ["space_ledger#probe_extra#timeline#0"]);
  assert.equal(detail.writes.find((w) => w.kind === "decision" && w.content === tz.content).matched, "dec_tz");
});

test("R1-4: per-kind LLM and Token F1 scores are in scores", async () => {
  const { scores } = await scoreRun(buildOracleRun(ds, gold), { ds, gold, judge });
  for (const kind of new Set(gold.questions.filter((q) => !q.excluded).map((q) => q.kind))) {
    assert.equal(scores[`answers.llm.${kind}`], 1, kind);
    assert.equal(scores[`answers.tokenF1.${kind}`], 1, kind);
  }
});

// A fake transport in the shape of run-memmy-live-eval.mjs call(): respond(path, body) → {status, payload} or throws.
function checksContext(respond) {
  const spaceMap = { space_ledger: "srv_ledger", space_catalog: "srv_catalog" };
  const conversations = new Map(ds.corpus.conversations.map((c) => [c.id, c]));
  const call = async (path, body, { strict = true } = {}) => {
    let status = 0;
    let payload;
    try { ({ status, payload } = await respond(path, body)); } catch (error) { payload = { code: -1, message: String(error.message ?? error) }; }
    const ok = status >= 200 && status < 300 && payload?.code === 0;
    if (!ok && strict) throw new Error(`${path} HTTP ${status}`);
    return { ok, status, code: payload?.code, message: payload?.message, data: payload?.data };
  };
  const searchBody = (conversation, query) => { const c = conversations.get(conversation); return { user_id: c.user_id, query, conversation_id: c.id, space_ids: [spaceMap[c.space_id]], include_memory_view: ["project"], memory_limit_number: 9 }; };
  const addBody = (trace, overrides = {}) => { const c = conversations.get(trace.conversation); return { user_id: c.user_id, conversation_id: c.id, space_ids: [spaceMap[c.space_id]], domains: [trace.domain], allow_memory_view: ["project"], async_mode: true, messages: [], ...overrides }; };
  const readSpace = async (space) => (await call("/get/memory", { space_id: spaceMap[space], page: 1, size: 50 })).data.topic_detail_list;
  const waitTask = async (taskId) => (await call("/get/status", { task_id: taskId })).data;
  return { gold, ds, spaceMap, call, searchBody, addBody, waitTask, readSpace };
}
const ledgerTopic = { id: "t1", space_id: "srv_ledger", topic_name: "月报" };
const okEnvelope = (data) => ({ status: 200, payload: { code: 0, message: "ok", data } });
const conforming = async (path, body) => {
  if (path === "/get/memory") return okEnvelope({ topic_detail_list: body.space_id === "srv_ledger" ? [ledgerTopic] : [], pages: 1 });
  if (path === "/search/memory") {
    if (!body.space_ids) return { status: 400, payload: { code: INVALID_PARAMS, message: "INVALID_PARAMS" } };
    return okEnvelope({ topic_detail_list: body.space_ids[0] === "srv_ledger" ? [ledgerTopic] : [] });
  }
  if (path === "/add/message") {
    if (!body.space_ids) return { status: 400, payload: { code: INVALID_PARAMS, message: "INVALID_PARAMS" } };
    return { status: 400, payload: { code: DOMAIN_INVALID, message: "DOMAIN_INVALID" } };
  }
  return { status: 404, payload: { code: 40401, message: "NOT_FOUND" } };
};
const passRate = (results) => results.filter((r) => r.passed).length / results.length;

test("R1-1: a conforming server passes all four checks", async () => {
  const results = await runApiChecks(checksContext(conforming));
  assert.equal(passRate(results), 1, JSON.stringify(results));
});

for (const [name, respond] of [
  ["refused connection", async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:1"); }],
  ["404 on every path", async () => ({ status: 404, payload: { code: -1, message: "non-JSON response" } })],
  ["500 on every path", async () => ({ status: 500, payload: { code: 50001, message: "INTERNAL" } })]
]) {
  test(`R1-1: ${name} fails every check (api.passRate 0)`, async () => {
    const results = await runApiChecks(checksContext(respond));
    assert.equal(passRate(results), 0, JSON.stringify(results));
  });
}

test("R1-1: isolation fails when search returns nothing anywhere (no positive control)", async () => {
  const respond = async (path, body) => (path === "/search/memory" && body.space_ids ? okEnvelope({ topic_detail_list: [] }) : conforming(path, body));
  const results = await runApiChecks(checksContext(respond));
  const isolation = results.find((r) => r.id === "search_space_isolation");
  assert.equal(isolation.passed, false);
  assert.equal(isolation.controlFailed.length, 5);
});

test("R1-1: isolation fails when the catalog query returns a ledger topic", async () => {
  const respond = async (path, body) => (path === "/search/memory" && body.space_ids ? okEnvelope({ topic_detail_list: [ledgerTopic] }) : conforming(path, body));
  const isolation = (await runApiChecks(checksContext(respond))).find((r) => r.id === "search_space_isolation");
  assert.equal(isolation.passed, false);
  assert.equal(isolation.leaks.length, 5);
});

test("R1-1: a rejection with a code other than 40001 does not pass the space_ids checks", async () => {
  const respond = async (path, body) => (!body.space_ids && path !== "/get/memory" ? { status: 400, payload: { code: 40002, message: "DOMAIN_INVALID" } } : conforming(path, body));
  const results = await runApiChecks(checksContext(respond));
  assert.equal(results.find((r) => r.id === "search_requires_space_ids").passed, false);
  assert.equal(results.find((r) => r.id === "add_requires_space_ids").passed, false);
});

const startedAt = "2026-11-05T00:00:00.000Z";
const t0 = Date.parse(startedAt);
const newRun = {
  runnerRevision: 2, startedAt, wallclockMs: 60_000, sut: { model: "claude-haiku-5-5" },
  phaseMs: { setup: 100, add: 5_000, search: 300, reader: 2_000, final: 50, check: 400 },
  requests: [
    { call: "/create/space", phase: "setup", poll: false, at: t0 + 10, ms: 5 },
    { call: "/add/message", phase: "add", poll: false, at: t0 + 1_000, ms: 2 },
    { call: "/get/status", phase: "add", poll: true, at: t0 + 1_200, ms: 1 },
    { call: "/get/status", phase: "add", poll: true, at: t0 + 1_600, ms: 1 },
    { call: "/add/message", phase: "add", poll: false, at: t0 + 3_000, ms: 4 },
    { call: "/get/status", phase: "add", poll: true, at: t0 + 3_200, ms: 1 },
    { call: "/search/memory", phase: "search", poll: false, at: t0 + 10_000, ms: 8 },
    { call: "/search/memory", phase: "check", poll: false, at: t0 + 50_000, ms: 6 }
  ],
  tasks: [
    { trace: "a", task_id: "x", completedMs: 600, detectionSlackMs: 400 },
    { trace: "b", task_id: "y", completedMs: 200, detectionSlackMs: 0 }
  ],
  usage: { reader: { model: "claude-haiku-5-5", calls: 1, cacheHits: 0, inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 0, perCall: [{ inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100 }] } }
};
const usageLines = [
  { at: new Date(t0 + 1_100).toISOString(), status: 200, latencyMs: 400, model: "claude-haiku-5-5", usage: { prompt_tokens: 1_000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 } } },
  { at: new Date(t0 + 3_100).toISOString(), status: 200, latencyMs: 200, model: "claude-haiku-5-5", usage: { prompt_tokens: 3_000, completion_tokens: 300 } },
  { at: new Date(t0 + 900_000).toISOString(), status: 200, latencyMs: 200, model: "claude-haiku-5-5", usage: { prompt_tokens: 9, completion_tokens: 9 } }
];
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test("R1-3: efficiency covers every metrics.md row on a new-runner run with a usage file", () => {
  const e = efficiency(newRun, { judgeUsage: null, sutUsage: { path: "mem", lines: usageLines, unparsed: 0 }, pricing });
  assert.equal(e.add.requests, 2);
  assert.equal(e.add.pollingRequests, 3);
  assert.equal(e.search.requests, 1);
  assert.equal(e.checks.requests, 1);
  assert.equal(e.add.wallclockMs, 5_000);
  assert.equal(e.search.wallclockMs, 300);
  assert.equal(e.add.llmCalls, 2);
  assert.equal(e.sutUsage.outsideRun, 1);
  assert.equal(e.sutUsage.callsDuringSearchRequests, 0);
  assert.equal(e.add.avgInputTokens, 2_000);
  assert.equal(e.add.avgOutputTokens, 200);
  // (200 * 0.1 + 800 * 0.01 + 100 * 0.5 + 3000 * 0.1 + 300 * 0.5) / 1e6
  close(e.add.totalCostUsd, 528 / 1e6);
  close(e.add.avgCostUsd, 264 / 1e6);
  assert.deepEqual([e.add.latencyMs.p50, e.add.latencyMs.p95], [3, 3.9]);
  assert.deepEqual({ n: e.add.task.n, p50: e.add.task.p50, mean: e.add.task.mean }, { n: 2, p50: 400, mean: 400 });
  assert.equal(e.search.llmCalls, 0);
  assert.equal(e.search.totalCostUsd, 0);
  assert.equal(e.search.avgCostUsd, 0);
  assert.equal(e.search.avgInputTokens, null);
  assert.ok(e.search.reasons.avgInputTokens && e.search.reasons.avgOutputTokens);
  close(e.reader.costUsd, (1_000 * 0.1 + 100 * 0.5) / 1e6);
});

test("R1-3: without a usage file, SUT fields are null with a reason; unpriced models are null with a reason", () => {
  const e = efficiency(newRun, { judgeUsage: null, sutUsage: null, pricing });
  for (const block of [e.add, e.search]) for (const field of ["llmCalls", "avgOutputTokens", "avgCostUsd", "totalCostUsd"]) { assert.equal(block[field], null); assert.ok(block.reasons[field], field); }
  const unpriced = efficiency({ ...newRun, sut: { model: "deepseek-x" } }, { judgeUsage: null, sutUsage: { path: "mem", lines: usageLines.map((l) => ({ ...l, model: "deepseek-x" })), unparsed: 0 }, pricing });
  assert.equal(unpriced.add.totalCostUsd, null);
  assert.match(unpriced.add.reasons.totalCostUsd, /deepseek-x/);
  assert.equal(unpriced.add.llmCalls, 2);
});

test("R1-3: an old-runner run (no phases, no task timing) reports null + reason for timing", () => {
  const old = { startedAt, wallclockMs: 60_000, requests: newRun.requests.map(({ phase, poll, at, ...r }) => r), tasks: [{ trace: "a", task_id: "x" }], usage: {} };
  const e = efficiency(old, { judgeUsage: null, sutUsage: { path: "mem", lines: usageLines, unparsed: 0 }, pricing });
  assert.equal(e.add.task, null);
  assert.ok(e.add.reasons.task);
  assert.equal(e.add.wallclockMs, null);
  assert.ok(e.add.reasons.wallclockMs);
  assert.equal(e.add.pollingRequests, 3);
  assert.equal(e.search.requests, 2);
  assert.ok(e.search.reasons.requests);
  assert.equal(e.sutUsage.callsDuringSearchRequests, null);
});

let failed = 0;
for (const { name, fn } of cases) {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${String(error.message).split("\n").join("\n     ")}`); }
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);

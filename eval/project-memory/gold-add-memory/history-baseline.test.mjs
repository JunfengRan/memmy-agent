import assert from "node:assert/strict";
import test from "node:test";
import { loadDataset } from "./build-gold-baseline.mjs";
import { acceptedTime } from "./episode-timeline.mjs";
import { answerFromHistory, historyFiles, historySystem, historyTools, MAX_STEPS, summarize } from "./history-baseline.mjs";
import { goldFor } from "./load-eval-set.mjs";

const ds = loadDataset();
const gold = goldFor(ds, { flush: true });
const question = (id) => gold.questions.find((q) => q.id === id);

test("the reader is told the projects and their session directories, nothing more", () => {
  const history = historyFiles(ds, question("q01"));
  const system = historySystem(history);
  assert.equal(history.projects.length, ds.corpus.spaces.length);
  assert.match(system, /共 6 个项目：ledger（\/history\/ledger）/);
  assert.match(system, /sessions\//);
  assert.match(system, /这个问题来自项目 ledger/);
  for (const banned of ["主题", "Topic", "摘要", "决策", "以时间更晚的为当前状态"]) assert.ok(!system.includes(banned), banned);
});

test("session files are raw transcripts of turns submitted before the question", () => {
  const q = question("q01");
  const { files } = historyFiles(ds, q);
  const text = [...files.values()].join("\n");
  for (const trace of ds.corpus.traces) {
    const visible = Date.parse(acceptedTime(trace)) <= Date.parse(q.askedAt);
    if (visible) assert.ok(text.includes(trace.query) && text.includes(trace.answer), trace.id);
  }
  const hidden = ds.corpus.traces.filter((t) => Date.parse(acceptedTime(t)) > Date.parse(q.askedAt) &&
    !ds.corpus.traces.some((o) => o !== t && o.query === t.query && Date.parse(acceptedTime(o)) <= Date.parse(q.askedAt)));
  assert.ok(hidden.length > 0);
  for (const trace of hidden) assert.ok(!text.includes(trace.query), trace.id);
  for (const path of files.keys()) assert.match(path, /^\/history\/[a-z]+\/sessions\/[\w-]+\.md$/);
});

test("generic file tools: list_dir, read_file with line numbers, grep", () => {
  const tools = historyTools(historyFiles(ds, question("q02")));
  assert.match(tools.list_dir({ path: "/history" }), /ledger\//);
  assert.match(tools.list_dir({ path: "/history/ledger/sessions" }), /ledger-build\.md（\d+ 行）/);
  const file = tools.read_file({ path: "/history/ledger/sessions/ledger-build.md", start: 3, end: 4 });
  assert.match(file, /^3: \[2026-10-21 09:15\] 林工：/);
  assert.match(file, /\n4: \[2026-10-21 09:17\] Agent：/);
  assert.match(tools.grep({ pattern: "AMOUNT", path: "/history/ledger" }), /\/history\/ledger\/sessions\/[\w-]+\.md:\d+: /);
  assert.match(tools.read_file({ path: "/history/nope.md" }), /没有文件/);
});

test("the tool loop answers, and the last step must answer without tools", async () => {
  const q = question("q01");
  const history = historyFiles(ds, q);
  const scripted = [
    { choices: [{ message: { tool_calls: [{ id: "1", function: { name: "list_dir", arguments: "{\"path\":\"/history/ledger\"}" } }] } }] },
    { choices: [{ message: { content: "金额从 journal 正文取。" } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }
  ];
  const result = await answerFromHistory({ question: q, history, call: async () => scripted.shift() });
  assert.equal(result.answer, "金额从 journal 正文取。");
  assert.deepEqual(result.trace.map((t) => t.tool), ["list_dir"]);

  const forced = [];
  const looping = await answerFromHistory({ question: q, history, call: async (_messages, options) => {
    forced.push(options.withTools);
    return options.withTools
      ? { choices: [{ message: { tool_calls: [{ id: "x", function: { name: "list_dir", arguments: "{}" } }] } }] }
      : { choices: [{ message: { content: "记忆中没有相关内容" } }] };
  } });
  assert.equal(looping.steps, MAX_STEPS);
  assert.equal(forced.at(-1), false);
  assert.equal(looping.answer, "记忆中没有相关内容");
});

test("summary reports answer accuracy overall and by kind", () => {
  const usage = { calls: 2, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 };
  const scores = summarize([
    { kind: "plain", verdict: { correct: true }, steps: 2, usage },
    { kind: "plain", verdict: { correct: false }, steps: 4, usage },
    { kind: "conflict", verdict: { correct: true }, steps: 3, usage }
  ]);
  assert.equal(scores["answers.llm"], 2 / 3);
  assert.equal(scores["answers.llm.plain"], 0.5);
  assert.equal(scores["answers.llm.conflict"], 1);
  assert.equal(scores.meanSteps, 3);
});

test("each question keeps its reader tokens and time; the summary prices them per call", async () => {
  const q = question("q01");
  const result = await answerFromHistory({ question: q, history: historyFiles(ds, q), call: async () => ({
    choices: [{ message: { content: "答" } }], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 400 }
  }) });
  assert.equal(result.usage.perCall.length, 1);
  assert.ok(Number.isFinite(result.usage.perCall[0].latencyMs));
  assert.ok(Number.isFinite(result.wallclockMs));
  const pricing = { models: { m: { input: 1, cachedInput: 0.1, output: 2 } } };
  const scores = summarize([{ kind: "plain", verdict: { correct: true }, steps: 1, ...result }], { model: "m", pricing });
  const call = result.usage.perCall[0];
  assert.equal(scores.readerCostUsd, (call.inputTokens * 1 + call.cachedInputTokens * 0.1 + call.outputTokens * 2) / 1e6);
  assert.equal(scores.questionWallclockMs.total, result.wallclockMs);
  assert.equal(summarize([{ kind: "plain", verdict: { correct: true }, steps: 1, ...result }]).readerCostUsd, null);
});

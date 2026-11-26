import assert from "node:assert/strict";
import test from "node:test";
import { loadDataset } from "./build-gold-baseline.mjs";
import { answerFromHistory, historyFor, historyTools, MAX_STEPS, summarize } from "./history-baseline.mjs";
import { goldFor } from "./load-eval-set.mjs";

const ds = loadDataset();
const gold = goldFor(ds, { flush: true });
const question = (id) => gold.questions.find((q) => q.id === id);

test("a question sees only its own Space's sessions submitted before it was asked", () => {
  const q = question("q01");
  const sessions = historyFor(ds, q);
  const conversations = new Map(ds.corpus.conversations.map((c) => [c.id, c]));
  assert.ok(sessions.length > 0);
  for (const session of sessions) {
    assert.equal(conversations.get(session.id).space_id, q.space_id);
    for (const turn of session.turns) assert.ok(Date.parse(turn.time) <= Date.parse(q.askedAt));
  }
  const later = ds.corpus.traces.filter((t) => conversations.get(t.conversation).space_id === q.space_id && Date.parse(t.reply_time) > Date.parse(q.askedAt));
  const seen = new Set(sessions.flatMap((s) => s.turns.map((t) => t.request)));
  assert.ok(later.every((t) => !seen.has(t.query) || ds.corpus.traces.some((o) => o !== t && o.query === t.query)));
});

test("disclosure goes from session index to turn outline to full text", () => {
  const tools = historyTools(historyFor(ds, question("q02")));
  const index = tools.list_sessions();
  assert.match(index, /ledger-build｜林工/);
  const outline = tools.open_session({ session_id: "ledger-build" });
  assert.match(outline, /\[ledger-build #1\]/);
  assert.ok(!outline.includes("Agent："), "the outline shows requests only");
  const full = tools.read_turns({ session_id: "ledger-build", turns: [1] });
  assert.match(full, /Agent：/);
  assert.match(tools.search_history({ keyword: "amount" }), /#\d+\]/);
  assert.match(tools.open_session({ session_id: "nope" }), /没有会话/);
});

test("the tool loop answers, and the last step must answer without tools", async () => {
  const q = question("q01");
  const sessions = historyFor(ds, q);
  const scripted = [
    { choices: [{ message: { tool_calls: [{ id: "1", function: { name: "list_sessions", arguments: "{}" } }] } }] },
    { choices: [{ message: { content: "金额从 journal 正文取。" } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }
  ];
  const result = await answerFromHistory({ question: q, sessions, call: async () => scripted.shift() });
  assert.equal(result.answer, "金额从 journal 正文取。");
  assert.deepEqual(result.trace.map((t) => t.tool), ["list_sessions"]);

  const forced = [];
  const looping = await answerFromHistory({ question: q, sessions, call: async (_messages, options) => {
    forced.push(options.withTools);
    return options.withTools
      ? { choices: [{ message: { tool_calls: [{ id: "x", function: { name: "list_sessions", arguments: "{}" } }] } }] }
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
  const result = await answerFromHistory({ question: q, sessions: historyFor(ds, q), call: async () => ({
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

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDataset } from "../build-gold-baseline.mjs";
import { buildEpisodeTimeline } from "../episode-timeline.mjs";
import { createJudge } from "../judge.mjs";
import { createLlm } from "../llm.mjs";
import { goldFor } from "../load-eval-set.mjs";
import { oracleTopics } from "../oracle.mjs";
import { replaySchedule } from "../run-memos-v3-live.mjs";
import { createStepChecker } from "./step-check.mjs";

const ds = loadDataset();
const gold = goldFor(ds, { flush: true });
const timeline = buildEpisodeTimeline(ds, { flush: true });
const { events } = replaySchedule(ds, gold);
// Exact text is settled by rule, so no model is called; answers are scored by the stub below.
const ruleJudge = (answerCorrect) => ({ ...createJudge(createLlm({ config: null })), answer: async () => ({ correct: answerCorrect, reason: "stub" }) });

async function drive({ readSpaceAt, answerCorrect = true, until = events.length }) {
  const outDir = mkdtempSync(join(tmpdir(), "step-check-"));
  const checker = createStepChecker({ ds, gold, outDir, judge: ruleJudge(answerCorrect), readJobs: null });
  const run = { tasks: [], questions: [] };
  const pauses = [];
  for (let index = 0; index < until; index += 1) {
    const event = events[index];
    if (event.trace) run.tasks.push({ trace: event.trace.id, task_id: event.trace.id, status: "completed" });
    else run.questions.push({ id: event.question.id, answer: "答", topic_detail_list: [], flush: { settled: true } });
    const verdict = await checker.check(run, index, { event, readSpace: async (space) => readSpaceAt(event.at, space) });
    if (verdict === "pause") pauses.push(index);
  }
  return { pauses, run, outDir };
}

test("replaying the gold itself never pauses", async () => {
  const { pauses, run } = await drive({ readSpaceAt: (at, space) => oracleTopics(ds, at, space, timeline) });
  assert.deepEqual(pauses, []);
  assert.ok(run.stepCheck.checkedTraces.length > 100, "nearly every Trace was checked");
});

test("an empty memory pauses at the first Add gold commits, naming the missing entry", async () => {
  const { pauses, outDir } = await drive({ readSpaceAt: () => [], until: 20 });
  assert.ok(pauses.length >= 1);
  const files = readdirSync(join(outDir, "pauses"));
  assert.match(files[0], /^001-/);
  const firstCommit = events.findIndex((event) => event.trace && gold.traceLabels.find((l) => l.trace === event.trace.id)?.ops.length &&
    timeline.commitByTrace.get(event.trace.id) <= events[pauses[0]].at);
  assert.ok(firstCommit >= 0 && firstCommit <= pauses[0]);
});

test("a wrong answer pauses with the layer that lost the fact", async () => {
  const first = events.findIndex((event) => event.question);
  const { pauses, outDir } = await drive({ readSpaceAt: (at, space) => oracleTopics(ds, at, space, timeline), answerCorrect: false, until: first + 1 });
  assert.deepEqual(pauses, [first]);
  const [file] = readdirSync(join(outDir, "pauses"));
  const record = JSON.parse((await import("node:fs")).readFileSync(join(outDir, "pauses", file), "utf8"));
  const issue = record.issues.find((item) => item.type === "answer_wrong");
  assert.equal(issue.layer, "search", "the fact is stored but the stub search returned nothing");
});

test("a timeline that restates its decision still counts for the timeline entry", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "step-check-"));
  const judge = { ...ruleJudge(true), attribute: async (candidate, list) => list.length > 1
    ? { label: "match", ids: ["dec_price", "tl_price"], source: "stub" }
    : { label: "match", ids: [list[0].id], source: "stub" } };
  const checker = createStepChecker({ ds, gold, outDir, judge, readJobs: null });
  const at = timeline.commitByTrace.get("t_price");
  const topics = oracleTopics(ds, at, "space_catalog", timeline).map((topic) => ({ ...topic,
    timeline: (topic.timeline ?? []).map((entry) => ({ ...entry, content: `${entry.content}（改写）` })) }));
  const run = { tasks: [{ trace: "t_price", task_id: "t_price", status: "completed" }], questions: [] };
  const event = { at, trace: ds.corpus.traces.find((trace) => trace.id === "t_price") };
  await checker.check(run, 0, { event, readSpace: async (space) => (space === "space_catalog" ? topics : []) });
  const issues = Object.keys(run.stepCheck.reported);
  assert.ok(!issues.some((key) => key.startsWith("missing:t_price")), issues.join(", "));
});

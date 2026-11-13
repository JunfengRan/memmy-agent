// Joins a traced live run into one JSON file per question plus trace/index.md.
//   node harness/build-trace.mjs --run <run-dir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadGold } from "../load-eval-set.mjs";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const runDir = arg("run");
if (!runDir) { console.error("usage: --run <run-dir>"); process.exit(2); }

function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const live = JSON.parse(readFileSync(join(runDir, "live-run.json"), "utf8"));
const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"));
const gold = loadGold();
const goldQuestions = new Map(gold.questions.map((item) => [item.id, item]));
const goldEntries = new Map(gold.entries.map((item) => [item.id, item]));
const reportQuestions = new Map((report.detail?.questions ?? []).map((item) => [item.id, item]));
const steps = readJsonl(join(runDir, "trace", "add-steps.jsonl"));
const calls = readJsonl(join(runDir, "trace", "model-calls.jsonl"));
const readers = new Map(readJsonl(join(runDir, "trace", "reader-calls.jsonl")).map((item) => [item.id, item]));
const explain = JSON.parse(readFileSync(join(runDir, "trace", "search-explain.json"), "utf8"));
const explained = new Map(explain.questions.map((item) => [item.id, item]));
const stepsByTrace = new Map();
for (const step of steps) {
  const list = stepsByTrace.get(step.trace) ?? [];
  list.push(step);
  stepsByTrace.set(step.trace, list);
}
const callsByTrace = new Map();
for (const call of calls) {
  const trace = call.context?.trace;
  if (!trace) continue;
  const list = callsByTrace.get(trace) ?? [];
  list.push(call);
  callsByTrace.set(trace, list);
}

const outDir = join(runDir, "trace", "questions");
mkdirSync(outDir, { recursive: true });
const rows = [];
for (const asked of live.questions) {
  const question = goldQuestions.get(asked.id);
  const judged = reportQuestions.get(asked.id);
  const sources = [...new Set((question.expectedItems ?? []).flatMap((item) => goldEntries.get(item.entry)?.sources ?? []))];
  const dossier = {
    id: asked.id,
    kind: question.kind,
    question: question.question,
    goldAnswer: question.goldAnswer,
    mustInclude: question.mustInclude,
    expectedItems: question.expectedItems,
    judge: judged?.answer ?? null,
    recall: judged?.recall ?? null,
    entryHit: judged?.entryHit ?? null,
    rendered: asked.rendered,
    answer: asked.answer,
    reader: readers.get(asked.id) ?? null,
    search: explained.get(asked.id) ?? null,
    adds: sources.map((trace) => ({
      trace,
      steps: stepsByTrace.get(trace) ?? [],
      modelCalls: (callsByTrace.get(trace) ?? []).map((call) => ({
        at: call.at,
        operation: call.operation ?? null,
        task_id: call.context?.task_id ?? null,
        request: call.request ?? null,
        response: call.response ?? null
      }))
    }))
  };
  writeFileSync(join(outDir, `${asked.id}.json`), `${JSON.stringify(dossier, null, 2)}\n`);
  rows.push({
    id: asked.id,
    kind: question.kind,
    correct: judged?.answer?.correct ?? null,
    recall3: judged?.recall?.["3"] ?? null,
    entryHit: judged?.entryHit ?? null,
    reason: judged?.answer?.reason ?? ""
  });
}

const wrong = rows.filter((row) => row.correct === false);
const hitGap = rows.filter((row) => row.correct === true && row.entryHit === 0);
const lines = [
  "# 逐题追踪",
  "",
  `错题 ${wrong.length}，答对但条目未命中 ${hitGap.length}。`,
  "",
  "| 题 | 类型 | 对 | Recall@3 | entryHit | 评委 |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map((row) => `| ${row.id} | ${row.kind} | ${row.correct} | ${row.recall3} | ${row.entryHit} | ${String(row.reason).replace(/\|/g, "/")} |`),
  "",
  "## 答对但 entryHit 为 0",
  "",
  hitGap.length ? hitGap.map((row) => `- ${row.id}`).join("\n") : "无",
  ""
];
writeFileSync(join(runDir, "trace", "index.md"), lines.join("\n"));
console.log(JSON.stringify({ questions: rows.length, wrong: wrong.map((row) => row.id), entryHitGap: hitGap.map((row) => row.id) }));

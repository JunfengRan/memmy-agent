#!/usr/bin/env node
/**
 * Deterministic gate for the three-stage project-memory evaluation.
 *
 * Input JSON (for a real Memmy run):
 * {
 *   "add": {"entries": [{"kind":"decision", "sourceTraceIds":["t_column"], "topicId":"..."}]},
 *   "search": [{"questionId":"q01", "recalledTraceIds":["t_column"]}],
 *   "answers": [{"questionId":"q01", "answer":"..."}]
 * }
 *
 * `--oracle` emits a self-contained perfect-output fixture from reviewed gold. This is
 * a smoke test for the scorer, not a product result. Real runs should replace the fixture
 * with records captured from add_message, search_memory and the final answer model.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const gold = JSON.parse(readFileSync(join(root, "generated/extracted-gold.json"), "utf8"));
const questions = gold.timelines.flatMap((timeline) => timeline.questions);
const entries = gold.entries;
const byQuestion = new Map(questions.map((question) => [question.id, question]));
const set = (values) => new Set(Array.isArray(values) ? values : []);
const ratio = (numerator, denominator) => denominator ? numerator / denominator : 1;

function oracle() {
  return {
    add: { entries: entries.map(({ kind, topicId, sourceTraceIds, text }) => ({ kind, topicId, sourceTraceIds, text })) },
    search: questions.map((question) => ({ questionId: question.id, recalledTraceIds: [...question.asksAbout] })),
    answers: questions.map((question) => ({ questionId: question.id, answer: question.goldAnswer }))
  };
}

function scoreAdd(actual) {
  const expected = entries.map((entry) => ({ kind: entry.kind, topicId: entry.topicId, sourceTraceIds: set(entry.sourceTraceIds) }));
  const got = (actual?.entries ?? []).map((entry) => ({ kind: entry.kind, topicId: entry.topicId, sourceTraceIds: set(entry.sourceTraceIds) }));
  const match = (candidate, target) => candidate.kind === target.kind && candidate.topicId === target.topicId && [...target.sourceTraceIds].every((id) => candidate.sourceTraceIds.has(id));
  const matchedExpected = new Set();
  let truePositive = 0;
  for (const candidate of got) {
    const index = expected.findIndex((target, i) => !matchedExpected.has(i) && match(candidate, target));
    if (index >= 0) { matchedExpected.add(index); truePositive += 1; }
  }
  const precision = ratio(truePositive, got.length);
  const recall = ratio(truePositive, expected.length);
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { expected: expected.length, actual: got.length, matched: truePositive, precision, recall, f1 };
}

function scoreSearch(actual) {
  const rows = Array.isArray(actual) ? actual : [];
  const byId = new Map(rows.map((row) => [row.questionId, row]));
  let evidenceHits = 0; let evidenceTotal = 0; let trapHits = 0; let trapTotal = 0; let scopeLeak = 0; let scopeTotal = 0;
  for (const question of questions) {
    const row = byId.get(question.id) ?? {};
    const recalled = set(row.recalledTraceIds);
    const expected = set(question.asksAbout);
    const traps = set(question.trapEvidenceIds);
    evidenceTotal += expected.size;
    for (const id of expected) if (recalled.has(id)) evidenceHits += 1;
    if (traps.size) { trapTotal += 1; if ([...traps].some((id) => recalled.has(id))) trapHits += 1; }
    if (question.kind === "scope-leak") { scopeTotal += 1; if ([...recalled].some((id) => id !== "t_global")) scopeLeak += 1; }
  }
  return { questions: questions.length, evidenceRecall: ratio(evidenceHits, evidenceTotal), trapRate: ratio(trapHits, trapTotal), scopeLeakRate: ratio(scopeLeak, scopeTotal), evidenceHits, evidenceTotal, trapHits, trapTotal, scopeLeak, scopeTotal };
}

function scoreAnswers(actual) {
  const rows = Array.isArray(actual) ? actual : [];
  const byId = new Map(rows.map((row) => [row.questionId, row.answer]));
  let passed = 0; let traps = 0; const failures = [];
  for (const question of questions) {
    const answer = String(byId.get(question.id) ?? "");
    const hit = question.mustInclude.every((phrase) => answer.includes(phrase));
    const trap = question.mustNotInclude.some((phrase) => answer.includes(phrase));
    if (hit && !trap) passed += 1;
    else failures.push({ questionId: question.id, hit, trap, answer });
    if (trap) traps += 1;
  }
  return { questions: questions.length, passed, accuracy: ratio(passed, questions.length), trapRate: ratio(traps, questions.length), failures };
}

const args = process.argv.slice(2);
const oracleMode = args.includes("--oracle");
const inputPath = args.find((arg) => !arg.startsWith("--"));
let input;
if (oracleMode) input = oracle();
else if (inputPath) input = JSON.parse(readFileSync(inputPath, "utf8"));
else {
  console.error("usage: node run-pipeline-eval.mjs --oracle [output.json] | node run-pipeline-eval.mjs run.json");
  process.exit(2);
}
const measured = input?.input ?? input;
const report = { schemaVersion: 1, source: oracleMode ? "reviewed-gold-oracle" : inputPath, add: scoreAdd(measured.add), search: scoreSearch(measured.search), answer: scoreAnswers(measured.answers) };
const outputPath = oracleMode && inputPath ? inputPath : null;
if (outputPath) writeFileSync(outputPath, `${JSON.stringify({ input, report }, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (!oracleMode && (report.add.f1 < 0.85 || report.search.evidenceRecall < 0.85 || report.answer.accuracy < 0.85)) process.exitCode = 1;

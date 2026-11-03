#!/usr/bin/env node
/**
 * Scores one project-memory run against the reviewed gold.
 *
 * Input JSON (written by run-memmy-live-eval.mjs, or any run in the same shape):
 * {
 *   "add": {"entries": [{"kind":"decision", "topicId":"...", "projectId":"proj_ledger", "sourceTraceIds":["t_column"], "text":"..."}]},
 *   "search": [{"questionId":"q01", "ranked":[{"sourceTraceIds":["t_column"]}]}],
 *   "answers": [{"questionId":"q01", "answer":"..."}],
 *   "requests": [{"phase":"add|search", "latencyMs":123, "usage":{"model":"...", "inputTokens":1, "outputTokens":1, "cachedInputTokens":0}}],
 *   "wallclockMs": 12345
 * }
 *
 * Usage:
 *   node run-pipeline-eval.mjs run.json [--out report.json] [--no-judge] [--gate] [--min-entry-f1=0.85] [--min-recall-at-10=0.85] [--min-llm-score=0.85]
 *   node run-pipeline-eval.mjs --oracle   perfect output from gold; every quality metric must be 1
 *   node run-pipeline-eval.mjs --empty    empty output; every quality metric must be 0
 *
 * Exit code: 0 after a report, 1 only when --gate is set and a threshold fails, 2 on bad input.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJudge } from "./judge.mjs";
import { scoreAnswer } from "./load-eval-set.mjs";
import { bcubed, costUsd, groupMean, mean, percentile, prf, ratio, tokenF1 } from "./metrics.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const gold = JSON.parse(readFileSync(join(root, "generated/extracted-gold.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(root, "dataset/corpus.json"), "utf8"));
const pricing = JSON.parse(readFileSync(join(root, "pricing.json"), "utf8"));
const questions = gold.timelines.flatMap((timeline) => timeline.questions);
const goldEntries = gold.entries;
const goldById = new Map(goldEntries.map((entry) => [entry.id, entry]));
const traceProject = new Map(corpus.traces.map((trace) => [trace.id, trace.projectId]));
const sessionProject = new Map(corpus.sessions.map((session) => [session.id, session.projectId]));
const KS = [1, 3, 5, 10];

function oracle() {
  return {
    add: { entries: goldEntries.map(({ kind, goldTopic, projectId, sourceTraceIds, text }) => ({ kind, topicId: goldTopic, projectId, sourceTraceIds, text })) },
    search: questions.map((question) => ({ questionId: question.id, ranked: question.asksAbout.map((id) => ({ sourceTraceIds: [id] })) })),
    answers: questions.map((question) => ({ questionId: question.id, answer: question.goldAnswer })),
    requests: [],
    wallclockMs: null
  };
}

function empty() {
  return { add: { entries: [] }, search: [], answers: [], requests: [], wallclockMs: null };
}

function entryProject(entry) {
  if (entry.projectId) return entry.projectId;
  if (entry.sessionId && sessionProject.get(entry.sessionId)) return sessionProject.get(entry.sessionId);
  return (entry.sourceTraceIds ?? []).map((id) => traceProject.get(id)).find(Boolean) ?? null;
}

async function scoreAdd(actual, judge) {
  const candidates = (actual?.entries ?? []).map((entry) => ({ ...entry, projectId: entryProject(entry), sourceTraceIds: entry.sourceTraceIds ?? [] }));
  const goldTraces = new Set(goldEntries.flatMap((entry) => entry.sourceTraceIds));
  const candidateTraces = new Set(candidates.flatMap((entry) => entry.sourceTraceIds));
  const covered = [...goldTraces].filter((id) => candidateTraces.has(id));
  const sourceTraceCoverage = {
    coverage: ratio(covered.length, goldTraces.size),
    covered: covered.length,
    total: goldTraces.size,
    missing: [...goldTraces].filter((id) => !candidateTraces.has(id))
  };
  const counts = { expected: goldEntries.length, actual: candidates.length, goldTopics: new Set(goldEntries.map((entry) => entry.goldTopic)).size, modelTopics: new Set(candidates.map((entry) => `${entry.projectId}\u0000${entry.topicId}`)).size };
  if (!judge) return { ...counts, entryF1: null, contentF1: null, topicInduction: null, sourceTraceCoverage, note: "judge disabled" };

  const labels = candidates.map(() => ({ label: "none", gold: null, source: "no-project" }));
  await Promise.all([...new Set(goldEntries.map((entry) => entry.projectId))].map(async (projectId) => {
    const indexes = candidates.map((entry, index) => entry.projectId === projectId ? index : -1).filter((index) => index >= 0);
    const projectLabels = await judge.labelEntries(goldEntries.filter((entry) => entry.projectId === projectId), indexes.map((index) => candidates[index]));
    indexes.forEach((index, i) => { labels[index] = projectLabels[i]; });
  }));

  const strictMatched = new Set();
  const contentMatched = new Map();
  let duplicates = 0;
  candidates.forEach((candidate, index) => {
    const { label, gold: goldId } = labels[index];
    if (label !== "match") return;
    if (!contentMatched.has(goldId)) contentMatched.set(goldId, index);
    else duplicates += 1;
    if (!strictMatched.has(goldId) && goldById.get(goldId).kind === candidate.kind) strictMatched.add(goldId);
  });
  const kindConfusion = {};
  for (const [goldId, index] of contentMatched) {
    const key = `${goldById.get(goldId).kind}->${candidates[index].kind}`;
    kindConfusion[key] = (kindConfusion[key] ?? 0) + 1;
  }
  const topicItems = candidates.flatMap((candidate, index) => labels[index].label === "match"
    ? [{ predicted: `${candidate.projectId}\u0000${candidate.topicId}`, gold: goldById.get(labels[index].gold).goldTopic }]
    : []);
  return {
    ...counts,
    entryF1: { ...prf(strictMatched.size, candidates.length, goldEntries.length), matched: strictMatched.size },
    contentF1: { ...prf(contentMatched.size, candidates.length, goldEntries.length), matched: contentMatched.size },
    labels: { match: labels.filter((row) => row.label === "match").length, stale: labels.filter((row) => row.label === "stale").length, none: labels.filter((row) => row.label === "none").length, duplicates },
    kindConfusion,
    topicInduction: { ...bcubed(topicItems), matchedGoldTopics: new Set(topicItems.map((item) => item.gold)).size },
    sourceTraceCoverage,
    missedGold: goldEntries.filter((entry) => !contentMatched.has(entry.id)).map((entry) => entry.id),
    candidates: candidates.map((candidate, index) => ({ kind: candidate.kind, topicId: candidate.topicId, text: candidate.text, ...labels[index] }))
  };
}

function scoreSearch(actual) {
  const byId = new Map((Array.isArray(actual) ? actual : []).map((row) => [row.questionId, row]));
  const rows = questions.map((question) => {
    const row = byId.get(question.id) ?? {};
    const ranked = Array.isArray(row.ranked)
      ? row.ranked.map((item) => item.sourceTraceIds ?? [])
      : (row.recalledTraceIds ?? []).map((id) => [id]);
    const evidence = new Set(question.asksAbout);
    const recallAt = (k) => {
      const seen = new Set(ranked.slice(0, k).flat());
      return [...evidence].filter((id) => seen.has(id)).length / evidence.size;
    };
    const context = new Set(ranked.flat());
    return {
      questionId: question.id,
      kind: question.kind,
      contextItems: ranked.length,
      ...Object.fromEntries(KS.map((k) => [`recallAt${k}`, recallAt(k)])),
      recallContext: recallAt(Infinity),
      trap: question.trapEvidenceIds.length ? question.trapEvidenceIds.some((id) => context.has(id)) : null
    };
  });
  const recall = Object.fromEntries([...KS.map((k) => `recallAt${k}`), "recallContext"].map((key) => [key, mean(rows.map((row) => row[key]))]));
  const trapRows = rows.filter((row) => row.trap !== null);
  return {
    questions: questions.length,
    ...recall,
    trapRate: ratio(trapRows.filter((row) => row.trap).length, trapRows.length),
    byKind: Object.fromEntries(Object.entries(groupMean(rows, "kind", (row) => row.recallAt10)).map(([kind, value]) => [kind, {
      n: value.n,
      recallAt10: value.mean,
      recallContext: mean(rows.filter((row) => row.kind === kind).map((row) => row.recallContext))
    }])),
    perQuestion: rows
  };
}

async function scoreAnswers(actual, judge) {
  const byId = new Map((Array.isArray(actual) ? actual : []).map((row) => [row.questionId, String(row.answer ?? "")]));
  const rows = await Promise.all(questions.map(async (question) => {
    const answer = byId.get(question.id) ?? "";
    const verdict = judge ? await judge.judgeAnswer(question, answer) : null;
    return {
      questionId: question.id,
      kind: question.kind,
      llmCorrect: verdict ? (verdict.correct ? 1 : 0) : null,
      llmReason: verdict?.reason,
      tokenF1: tokenF1(answer, question.goldAnswer),
      rubric: scoreAnswer(answer, question) ? 1 : 0,
      answer
    };
  }));
  const byKind = {};
  for (const kind of [...new Set(rows.map((row) => row.kind))].sort()) {
    const group = rows.filter((row) => row.kind === kind);
    byKind[kind] = { n: group.length, llmScore: judge ? mean(group.map((row) => row.llmCorrect)) : null, tokenF1: mean(group.map((row) => row.tokenF1)), rubricAccuracy: mean(group.map((row) => row.rubric)) };
  }
  return {
    questions: questions.length,
    llmScore: judge ? mean(rows.map((row) => row.llmCorrect)) : null,
    tokenF1: mean(rows.map((row) => row.tokenF1)),
    rubricAccuracy: mean(rows.map((row) => row.rubric)),
    byKind,
    failures: rows.filter((row) => row.llmCorrect === 0).map(({ questionId, kind, llmReason, answer }) => ({ questionId, kind, reason: llmReason, answer }))
  };
}

function phaseEfficiency(requests, phase) {
  const rows = requests.filter((row) => row.phase === phase);
  const withUsage = rows.filter((row) => row.usage);
  const costs = withUsage.map((row) => costUsd(row.usage, pricing));
  const priced = costs.filter((cost) => cost !== null);
  const latencies = rows.map((row) => row.latencyMs);
  return {
    requests: rows.length,
    requestsWithUsage: withUsage.length,
    llmCalls: withUsage.reduce((total, row) => total + (row.usage.llmCalls ?? 0), 0),
    models: [...new Set(withUsage.map((row) => row.usage.model).filter(Boolean))],
    timeMs: latencies.reduce((total, value) => total + value, 0),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    ...(phase === "add" ? { avgInputTokens: mean(withUsage.map((row) => row.usage.inputTokens + row.usage.cachedInputTokens)) } : {}),
    avgOutputTokens: mean(withUsage.map((row) => row.usage.outputTokens)),
    avgCostUsd: priced.length === withUsage.length ? mean(priced) : null,
    totalCostUsd: priced.length === withUsage.length && priced.length ? priced.reduce((total, cost) => total + cost, 0) : null
  };
}

function efficiency(measured, judge) {
  const requests = Array.isArray(measured.requests) ? measured.requests : [];
  const judgeUsage = judge?.usage;
  return {
    wallclockMs: measured.wallclockMs ?? null,
    add: phaseEfficiency(requests, "add"),
    search: phaseEfficiency(requests, "search"),
    judge: judgeUsage ? {
      model: judgeUsage.model,
      calls: judgeUsage.calls,
      cacheHits: judgeUsage.cacheHits,
      inputTokens: judgeUsage.inputTokens,
      outputTokens: judgeUsage.outputTokens,
      costUsd: costUsd({ model: judgeUsage.model, inputTokens: judgeUsage.inputTokens, outputTokens: judgeUsage.outputTokens, cachedInputTokens: judgeUsage.cachedInputTokens }, pricing),
      latencyP50Ms: percentile(judgeUsage.latencyMs, 50),
      latencyP95Ms: percentile(judgeUsage.latencyMs, 95)
    } : null
  };
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const outPath = option("out", null);
const inputPath = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--out");
let input;
let source;
if (flag("oracle")) { input = oracle(); source = "reviewed-gold-oracle"; }
else if (flag("empty")) { input = empty(); source = "empty-output"; }
else if (inputPath) {
  try { input = JSON.parse(readFileSync(inputPath, "utf8")); } catch (error) { console.error(String(error)); process.exit(2); }
  source = inputPath;
} else {
  console.error("usage: node run-pipeline-eval.mjs run.json [--out report.json] [--no-judge] [--gate] | --oracle | --empty");
  process.exit(2);
}
const measured = input?.input ?? input;
const judge = flag("no-judge") ? null : createJudge({ cachePath: join(root, "generated/judge-cache.json") });
let report;
try {
  report = {
    schemaVersion: 2,
    source,
    judgeModel: judge?.config?.model ?? null,
    add: await scoreAdd(measured.add, judge),
    search: scoreSearch(measured.search),
    answer: await scoreAnswers(measured.answers, judge),
    efficiency: null
  };
  report.efficiency = efficiency(measured, judge);
} finally {
  judge?.save();
}
if (outPath) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (flag("gate")) {
  const checks = [
    ["add.entryF1", report.add.entryF1?.f1, Number(option("min-entry-f1", 0.85))],
    ["search.recallAt10", report.search.recallAt10, Number(option("min-recall-at-10", 0.85))],
    ["answer.llmScore", report.answer.llmScore, Number(option("min-llm-score", 0.85))]
  ];
  const failed = checks.filter(([, value, min]) => value === null || value === undefined || value < min);
  for (const [name, value, min] of failed) console.error(`gate failed: ${name}=${value} < ${min}`);
  if (failed.length) process.exitCode = 1;
}

#!/usr/bin/env node
/**
 * Scores a spec-shaped run against dataset/gold.json.
 *
 * Run JSON (written by run-memmy-live-eval.mjs, or --oracle / --empty):
 *   { runVersion: 2, spaceMap: {dataset space id: server space id},
 *     final: {dataset space id: topic_detail_list from get_memory},
 *     questions: [{id, topic_detail_list, rendered, answer}],
 *     apiChecks: [{id, passed, detail}], requests: [{call, ms, status}], usage }
 *
 * Usage:
 *   node run-pipeline-eval.mjs runs/<stamp>/live-run.json [--out report.json] [--gate] [--prune-judge-cache]
 *       [--sut-usage <usage.jsonl>]   SUT model usage from harness/usage-proxy.mjs (or MEMMY_EVAL_SUT_USAGE)
 *       [--min-decision-state=0.8] [--min-topic-f1=0.8] [--min-entry-f1=0.8] [--min-recall-at-3=0.85] [--min-answer=0.8]
 *       [--max-duplicate-rate=0.02] [--max-wrong-merge-rate=0.01]
 *   node run-pipeline-eval.mjs --oracle   every score must be 1 and every error 0
 *   node run-pipeline-eval.mjs --empty    every score must be 0
 * Live runs need MEMMY_EVAL_JUDGE_{PROVIDER,MODEL,BASE_URL,API_KEY} and MEMMY_EVAL_SUT_MODEL (or run.sut.model).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finalPointTexts, loadDataset } from "./build-gold-baseline.mjs";
import { JUDGE_PROMPT_VERSION, createJudge } from "./judge.mjs";
import { assertJudgeFamily, createLlm, resolveModelConfig } from "./llm.mjs";
import { LIMITS, length, loadGold } from "./load-eval-set.mjs";
import { mean, percentile, priceCalls, priceUsage, prf, tokenF1 } from "./metrics.mjs";
import { buildEmptyRun, buildOracleRun } from "./oracle.mjs";

const root = dirname(fileURLToPath(import.meta.url));
export const RUNS_DIR = join(root, "..", "runs");
const norm = (text) => String(text ?? "").replace(/\s+/g, "").trim();
const sameSet = (a, b) => JSON.stringify([...new Set(a ?? [])].sort()) === JSON.stringify([...new Set(b ?? [])].sort());
const ratio = (n, d) => (d ? n / d : 0);
const FIELDS = [["decisions", "decision"], ["experiences", "experience"], ["timeline", "timeline"]];

function inWindow(time, [from, to]) {
  const at = Date.parse(time);
  return Number.isFinite(at) && at >= Date.parse(from) && at <= Date.parse(to);
}

function majority(counts, order) {
  let best = null;
  for (const id of order) if ((counts.get(id) ?? 0) > 0 && (best === null || counts.get(id) > counts.get(best))) best = id;
  return best;
}

export async function scoreRun(run, { ds, gold, judge }) {
  const reverse = new Map(Object.entries(run.spaceMap ?? {}).map(([dataset, server]) => [server, dataset]));
  const traces = new Map(ds.corpus.traces.map((t) => [t.id, t]));
  const conversationText = (sources) => sources.map((id) => traces.get(id)).filter(Boolean).map((t) => `${t.query}\n${t.answer}`).join("\n");
  const spaceText = (space) => conversationText(ds.corpus.traces.filter((t) => ds.corpus.conversations.find((c) => c.id === t.conversation)?.space_id === space).map((t) => t.id));
  const goldById = new Map(gold.entries.map((e) => [e.id, e]));
  const topicOrder = gold.topics.map((t) => t.id);
  const required = gold.entries.filter((e) => !e.optional);
  const goldList = {};
  const knownTexts = {};
  for (const e of gold.entries) {
    const conflictTexts = [...e.conflicts ?? [], ...(e.alternatives ?? []).flatMap((alt) => alt.conflicts ?? [])].map((c) => c.content);
    (goldList[e.space_id] ??= []).push({ id: e.id, kind: e.kind, text: e.content, staleTexts: e.staleVersions, conflictTexts });
    const known = (knownTexts[e.space_id] ??= new Set());
    for (const text of [e.content, ...e.staleVersions, ...conflictTexts]) known.add(norm(text));
  }
  const negatives = {};
  for (const n of gold.negatives) (negatives[n.space_id] ??= []).push({ id: n.id, text: n.text });

  // Final state: flatten get_memory into entries.
  const actual = [];
  const actualTopics = [];
  let fieldLimitViolations = 0;
  for (const [space, topics] of Object.entries(run.final ?? {})) {
    for (const [index, topic] of (topics ?? []).entries()) {
      const key = `${space}#${topic.id ?? index}`;
      actualTopics.push({ key, space, topic });
      if (length(topic.topic_name) > LIMITS.topic_name) fieldLimitViolations += 1;
      if (length(topic.topic_summary) > LIMITS.topic_summary) fieldLimitViolations += 1;
      if (length(topic.topic_description) > LIMITS.topic_description) fieldLimitViolations += 1;
      for (const [field, kind] of FIELDS) {
        for (const [i, raw] of (topic[field] ?? []).entries()) {
          actual.push({ uid: `${key}#${kind}#${i}`, space, topicKey: key, kind, content: raw.content, raw });
          for (const text of [raw.content, ...(raw.conflicts ?? []).map((c) => c.content), ...(raw.history ?? []).map((h) => h.content)]) {
            if (length(text) > LIMITS[kind]) fieldLimitViolations += 1;
          }
        }
      }
    }
  }
  await Promise.all(actual.map(async (a) => { a.attr = await judge.attribute(a, goldList[a.space] ?? [], negatives[a.space] ?? []); }));

  // One-to-one matching (Kuhn), in four passes: required on same-kind edges, required on any edge,
  // optional on same-kind edges, optional on any edge. Optional never takes a required entry's
  // match, and a cross-kind write never takes a same-kind one: a gold entry already matched to a
  // write of its own kind may only be moved to another write of its own kind. Candidates are
  // ordered same kind first, then primary id (attr.ids[0]) first, then write order.
  const kindOfWrite = new Map(actual.map((a) => [a.uid, a.kind]));
  const adjacency = new Map();
  for (const g of gold.entries) {
    const candidates = actual.filter((a) => a.space === g.space_id && a.attr.label === "match" && a.attr.ids.includes(g.id));
    const rank = (a) => (a.kind === g.kind ? 0 : 2) + (a.attr.ids[0] === g.id ? 0 : 1);
    adjacency.set(g.id, candidates.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map(({ a }) => a.uid));
  }
  const owner = new Map();
  const tryAssign = (goldId, seen, sameKindOnly) => {
    const kind = goldById.get(goldId).kind;
    for (const uid of adjacency.get(goldId)) {
      if (seen.has(uid) || (sameKindOnly && kindOfWrite.get(uid) !== kind)) continue;
      seen.add(uid);
      const current = owner.get(uid);
      if (current === undefined || tryAssign(current, seen, kindOfWrite.get(uid) === goldById.get(current).kind)) { owner.set(uid, goldId); return true; }
    }
    return false;
  };
  const matchedGold = () => new Set(owner.values());
  for (const group of [required, gold.entries.filter((e) => e.optional)]) {
    for (const sameKindOnly of [true, false]) {
      for (const g of group) if (!matchedGold().has(g.id)) tryAssign(g.id, new Set(), sameKindOnly);
    }
  }
  const pairOfGold = new Map([...owner.entries()].map(([uid, goldId]) => [goldId, actual.find((a) => a.uid === uid)]));
  const counted = actual.filter((a) => !(owner.has(a.uid) && goldById.get(owner.get(a.uid)).optional));
  const requiredPairs = required.filter((g) => pairOfGold.has(g.id)).map((g) => ({ g, a: pairOfGold.get(g.id) }));

  const byKind = {};
  for (const kind of ["decision", "experience", "timeline"]) {
    const tp = requiredPairs.filter(({ g, a }) => g.kind === kind && a.kind === kind).length;
    byKind[kind] = prf(tp, counted.filter((a) => a.kind === kind).length, required.filter((g) => g.kind === kind).length);
  }
  const overall = prf(requiredPairs.length, counted.length, required.length);
  const negativeHits = new Set(actual.filter((a) => a.attr.label === "negative").flatMap((a) => a.attr.ids));

  // Decision state: content, conflicts (with members), history, user_ids, time, sourced reasons.
  const decisionRows = [];
  let reasonTotal = 0;
  let reasonHits = 0;
  for (const g of required.filter((e) => e.kind === "decision")) {
    const a = pairOfGold.get(g.id);
    const goldReasons = g.history.filter((h) => h.reason).length;
    reasonTotal += goldReasons;
    if (!a || a.kind !== "decision") { decisionRows.push({ id: g.id, matched: Boolean(a), content: false, conflicts: false, history: false, userIds: false, time: false, reasons: 0 }); continue; }
    const text = conversationText(g.sources);
    let best = null;
    for (const variant of [g, ...(g.alternatives ?? []).map((alt) => ({ ...g, ...alt }))]) {
      const conflictsActual = a.raw.conflicts ?? [];
      const historyActual = a.raw.history ?? [];
      const conflictAlign = await judge.align(variant.conflicts.map((c) => c.content), conflictsActual.map((c) => c.content));
      const conflicts = conflictsActual.length === variant.conflicts.length && conflictAlign.every((j, i) => j !== null && sameSet(variant.conflicts[i].user_ids, conflictsActual[j].user_ids));
      const historyAlign = await judge.align(variant.history.map((h) => h.content), historyActual.map((h) => h.content));
      const history = historyActual.length === variant.history.length && historyAlign.every((j) => j !== null);
      let reasons = 0;
      for (const [i, h] of variant.history.entries()) {
        const j = historyAlign[i];
        if (!h.reason || j === null || !norm(historyActual[j].reason)) continue;
        if ((await judge.reasonSupported(historyActual[j].reason, text, h.reason)).supported) reasons += 1;
      }
      const row = { id: g.id, matched: true, content: true, conflicts, history, userIds: sameSet(variant.user_ids, a.raw.user_ids), time: inWindow(a.raw.time, g.timeWindow), reasons };
      const total = [row.conflicts, row.history, row.userIds, row.time].filter(Boolean).length + row.reasons;
      if (!best || total > best.total) best = { ...row, total };
    }
    delete best.total;
    reasonHits += best.reasons;
    decisionRows.push(best);
  }
  let reasonFabricated = 0;
  for (const a of actual.filter((x) => x.kind === "decision")) {
    const g = owner.has(a.uid) ? goldById.get(owner.get(a.uid)) : null;
    for (const h of a.raw.history ?? []) {
      if (!norm(h.reason)) continue;
      const verdict = await judge.reasonSupported(h.reason, g ? conversationText(g.sources) : spaceText(a.space), g?.history.find((x) => norm(x.content) === norm(h.content))?.reason);
      if (!verdict.supported) reasonFabricated += 1;
    }
  }
  const decisionScore = (field) => ratio(decisionRows.filter((r) => r[field]).length, decisionRows.length);
  const stateExact = ratio(decisionRows.filter((r) => r.content && r.conflicts && r.history && r.userIds && r.time).length, decisionRows.length);

  // Topics: extended B-cubed (unmatched writes dilute precision, unmatched gold has recall 0).
  const requiredPairOf = new Map(requiredPairs.map(({ g, a }) => [a.uid, g]));
  let precisionSum = 0;
  for (const a of counted) {
    const g = requiredPairOf.get(a.uid);
    if (!g) continue;
    const samePredicted = counted.filter((x) => x.topicKey === a.topicKey);
    precisionSum += samePredicted.filter((x) => requiredPairOf.get(x.uid)?.topic === g.topic).length / samePredicted.length;
  }
  let recallSum = 0;
  for (const g of required) {
    const a = pairOfGold.get(g.id);
    if (!a || !requiredPairOf.has(a.uid)) continue;
    const sameGold = required.filter((x) => x.topic === g.topic);
    recallSum += sameGold.filter((x) => pairOfGold.get(x.id)?.topicKey === a.topicKey).length / sameGold.length;
  }
  const bcubedP = ratio(precisionSum, counted.length);
  const bcubedR = ratio(recallSum, required.length);
  const bcubed = { precision: bcubedP, recall: bcubedR, f1: bcubedP + bcubedR ? (2 * bcubedP * bcubedR) / (bcubedP + bcubedR) : 0 };

  const topicMap = new Map();
  let wrongMerges = 0;
  for (const { key } of actualTopics) {
    const counts = new Map();
    for (const { g, a } of requiredPairs) if (a.topicKey === key) counts.set(g.topic, (counts.get(g.topic) ?? 0) + 1);
    wrongMerges += Math.max(0, counts.size - 1);
    const goldTopic = majority(counts, topicOrder);
    if (goldTopic) topicMap.set(key, goldTopic);
  }
  let duplicateTopics = 0;
  const topicRows = [];
  for (const goldTopic of gold.topics) {
    const counts = new Map();
    for (const { g, a } of requiredPairs) if (g.topic === goldTopic.id) counts.set(a.topicKey, (counts.get(a.topicKey) ?? 0) + 1);
    duplicateTopics += Math.max(0, counts.size - 1);
    const primaryKey = majority(counts, actualTopics.map((t) => t.key));
    const primary = actualTopics.find((t) => t.key === primaryKey)?.topic;
    const summaryPoints = finalPointTexts(goldTopic.summaryKeyPoints);
    const descriptionPoints = finalPointTexts(goldTopic.descriptionKeyPoints);
    const summary = primary ? await judge.keyPoints(summaryPoints, primary.topic_summary ?? "") : summaryPoints.map(() => false);
    const description = primary ? await judge.keyPoints(descriptionPoints, primary.topic_description ?? "") : descriptionPoints.map(() => false);
    topicRows.push({ id: goldTopic.id, actual: primary?.id ?? null, actualTopics: counts.size, domain: primary?.domain === goldTopic.domain, keyPoints: [...summary, ...description] });
  }
  const keyPoints = topicRows.flatMap((r) => r.keyPoints);
  const coveredGoldTopics = new Set(requiredPairs.map(({ g }) => g.topic));
  const actualWithMatch = new Set(requiredPairs.map(({ a }) => a.topicKey));
  let controlMerges = 0;
  for (const pair of ds.labels.controls?.["similar-name"] ?? []) {
    const leftKeys = new Set(requiredPairs.filter(({ g }) => g.topic === pair[0]).map(({ a }) => a.topicKey));
    const rightKeys = new Set(requiredPairs.filter(({ g }) => g.topic === pair[1]).map(({ a }) => a.topicKey));
    if ([...leftKeys].some((key) => rightKeys.has(key))) controlMerges += 1;
  }
  let controlSplits = 0;
  for (const pair of ds.labels.controls?.["same-work"] ?? []) {
    const left = pairOfGold.get(pair[0]);
    const right = pairOfGold.get(pair[1]);
    if (left && right && left.topicKey !== right.topicKey) controlSplits += 1;
  }
  const lateTexts = new Set();
  for (const entry of gold.entries) for (const item of [...(entry.conflicts ?? []), ...(entry.history ?? [])]) if (item.late) lateTexts.add(norm(item.content));
  const deferredRequired = required.filter((entry) => entry.deferred);
  const deferredNegatives = gold.negatives.filter((item) => item.deferred);

  // Search.
  const fallbackTopic = (space, topic) => {
    const counts = new Map();
    for (const [field] of FIELDS) {
      for (const raw of topic[field] ?? []) {
        const g = (goldList[space] ?? []).find((x) => [x.text, ...x.staleTexts, ...x.conflictTexts].some((t) => norm(t) === norm(raw.content)));
        if (g) counts.set(goldById.get(g.id).topic, (counts.get(goldById.get(g.id).topic) ?? 0) + 1);
      }
    }
    return majority(counts, topicOrder);
  };
  const questionRows = [];
  const scored = gold.questions.filter((q) => !q.excluded);
  for (const q of scored) {
    const result = (run.questions ?? []).find((r) => r.id === q.id);
    const trapTexts = q.trapItems.flatMap((t) => t.texts ?? [t.text]);
    if (!result) { questionRows.push({ id: q.id, kind: q.kind, missing: true, recall: { 1: 0, 3: 0, 9: 0 }, entryHit: 0, itemHits: 0, items: q.expectedItems.length, staleCurrent: 0, staleHistory: 0, staleTraps: q.trapItems.filter((t) => t.kind === "stale").length, leaks: 0, foreign: 0, overLimit: false, answer: { correct: false }, rubric: 0, tokenF1: 0 }); continue; }
    const all = result.topic_detail_list ?? [];
    const list = all.slice(0, 9);
    const foreign = list.filter((t) => t.space_id !== undefined && reverse.get(t.space_id) !== q.space_id).length;
    const mapped = list.map((t) => {
      const space = reverse.get(t.space_id) ?? q.space_id;
      return topicMap.get(`${space}#${t.id}`) ?? fallbackTopic(space, t);
    });
    const recall = Object.fromEntries([1, 3, 9].map((k) => [k, ratio(q.expectedTopics.filter((id) => mapped.slice(0, k).includes(id)).length, Math.min(k, q.expectedTopics.length))]));
    const items = list.flatMap((t) => [
      ...(t.decisions ?? []).flatMap((d) => [{ text: d.content, part: "current" }, ...(d.conflicts ?? []).map((c) => ({ text: c.content, part: "conflicts" })), ...(d.history ?? []).map((h) => ({ text: h.content, part: "history" }))]),
      ...(t.experiences ?? []).map((e) => ({ text: e.content, part: "current" })),
      ...(t.timeline ?? []).map((e) => ({ text: e.content, part: "current" }))
    ]);
    const keys = [
      ...q.expectedItems.map((item) => ({ type: "expected", item, text: item.text })),
      ...q.trapItems.flatMap((trap) => (trap.texts ?? [trap.text]).map((text) => ({ type: trap.kind, trap, text })))
    ];
    const found = keys.map((key) => items.filter((it) => norm(it.text) === norm(key.text)));
    const open = keys.map((_, i) => i).filter((i) => !found[i].length);
    const allKnown = new Set(Object.values(knownTexts).flatMap((set) => [...set]));
    const unknown = items.filter((it) => !allKnown.has(norm(it.text)));
    if (open.length && unknown.length) {
      const aligned = await judge.align(open.map((i) => keys[i].text), unknown.map((it) => it.text));
      aligned.forEach((j, n) => { if (j !== null) found[open[n]].push(unknown[j]); });
    }
    let itemHits = 0;
    let staleCurrent = 0;
    let staleHistory = 0;
    let leaks = 0;
    keys.forEach((key, i) => {
      const parts = found[i].map((it) => it.part);
      if (key.type === "expected" && parts.includes(key.item.part === "content" ? "current" : "conflicts")) itemHits += 1;
      if (key.type === "stale" && parts.includes("current")) staleCurrent += 1;
      if (key.type === "stale" && (parts.includes("history") || parts.includes("conflicts"))) staleHistory += 1;
      if (key.type === "cross-project" && parts.length) leaks += 1;
    });
    const answer = await judge.answer(q, result.answer, trapTexts);
    const reply = String(result.answer ?? "");
    questionRows.push({
      id: q.id, kind: q.kind, missing: false, topics: list.length, recall,
      entryHit: itemHits === q.expectedItems.length && q.expectedItems.length ? 1 : 0, itemHits, items: q.expectedItems.length,
      staleCurrent, staleHistory, staleTraps: q.trapItems.filter((t) => t.kind === "stale").length, leaks, foreign, overLimit: all.length > 9,
      answer, rubric: reply && q.mustInclude.every((phrase) => reply.includes(phrase)) ? 1 : 0, tokenF1: reply ? tokenF1(reply, q.goldAnswer) : 0
    });
  }
  const sum = (field) => questionRows.reduce((total, row) => total + (typeof row[field] === "number" ? row[field] : 0), 0);
  const byQuestionKind = Object.fromEntries([...new Set(questionRows.map((r) => r.kind))].sort().map((kind) => {
    const rows = questionRows.filter((r) => r.kind === kind);
    return [kind, { n: rows.length, answer: mean(rows.map((r) => (r.answer.correct ? 1 : 0))), tokenF1: mean(rows.map((r) => r.tokenF1)), entryHit: mean(rows.map((r) => r.entryHit)) }];
  }));

  const apiPassed = gold.apiChecks.filter((check) => (run.apiChecks ?? []).find((r) => r.id === check.id)?.passed === true).length;

  const scores = {
    "entries.precision": overall.precision,
    "entries.recall": overall.recall,
    "entries.recall.deferred": ratio(deferredRequired.filter((entry) => pairOfGold.has(entry.id)).length, deferredRequired.length),
    "entries.f1": overall.f1,
    ...Object.fromEntries(Object.entries(byKind).flatMap(([kind, m]) => [[`entries.${kind}.precision`, m.precision], [`entries.${kind}.recall`, m.recall], [`entries.${kind}.f1`, m.f1]])),
    "entries.kindCorrect": ratio(requiredPairs.filter(({ g, a }) => g.kind === a.kind).length, required.length),
    "decisions.content": decisionScore("content"),
    "decisions.conflicts": decisionScore("conflicts"),
    "decisions.history": decisionScore("history"),
    "decisions.userIds": decisionScore("userIds"),
    "decisions.time": decisionScore("time"),
    "decisions.reasons": ratio(reasonHits, reasonTotal),
    "decisions.stateExact": stateExact,
    "topics.bcubed.precision": bcubed.precision,
    "topics.bcubed.recall": bcubed.recall,
    "topics.bcubed.f1": bcubed.f1,
    "topics.domain": ratio(topicRows.filter((r) => r.domain).length, topicRows.length),
    "topics.keyPoints": ratio(keyPoints.filter(Boolean).length, keyPoints.length),
    "search.recall@1": ratio(questionRows.reduce((t, r) => t + r.recall[1], 0), questionRows.length),
    "search.recall@3": ratio(questionRows.reduce((t, r) => t + r.recall[3], 0), questionRows.length),
    "search.recall@9": ratio(questionRows.reduce((t, r) => t + r.recall[9], 0), questionRows.length),
    "search.entryHit": ratio(sum("entryHit"), questionRows.length),
    "search.itemHit": ratio(sum("itemHits"), sum("items")),
    "search.staleTrapInHistory": ratio(sum("staleHistory"), sum("staleTraps")),
    "answers.llm": ratio(questionRows.filter((r) => r.answer.correct).length, questionRows.length),
    "answers.rubric": ratio(sum("rubric"), questionRows.length),
    "answers.tokenF1": ratio(sum("tokenF1"), questionRows.length),
    ...Object.fromEntries(Object.entries(byQuestionKind).flatMap(([kind, m]) => [[`answers.llm.${kind}`, m.answer], [`answers.tokenF1.${kind}`, m.tokenF1]])),
    "api.passRate": ratio(apiPassed, gold.apiChecks.length)
  };
  const errors = {
    "notWritten.falseWriteRate": ratio(negativeHits.size, gold.negatives.length),
    "notWritten.deferredForced": deferredNegatives.filter((item) => negativeHits.has(item.id)).length,
    "writes.staleAsCurrent": actual.filter((a) => a.attr.label === "stale").length,
    "writes.lateAsCurrent": actual.filter((item) => lateTexts.has(norm(item.content))).length,
    "writes.conflictAsEntry": actual.filter((a) => a.attr.label === "conflict").length,
    "writes.unattributed": actual.filter((a) => a.attr.label === "none").length,
    "writes.duplicate": actual.filter((a) => a.attr.label === "match" && !owner.has(a.uid)).length,
    "writes.fieldLimitViolations": fieldLimitViolations,
    "decisions.reasonFabricated": reasonFabricated,
    "topics.duplicateTopics": duplicateTopics,
    "topics.wrongMerges": wrongMerges,
    "topics.duplicateRate": ratio(duplicateTopics, coveredGoldTopics.size),
    "topics.wrongMergeRate": ratio(wrongMerges, actualWithMatch.size),
    "topics.controlMerges": controlMerges,
    "topics.controlSplits": controlSplits,
    "search.staleShownAsCurrent": sum("staleCurrent"),
    "search.crossProjectLeak": sum("leaks"),
    "search.foreignTopics": sum("foreign"),
    "search.overLimit": questionRows.filter((r) => r.overLimit).length,
    "questions.missing": questionRows.filter((r) => r.missing).length
  };
  return {
    scores,
    errors,
    detail: {
      counts: { requiredEntries: required.length, actualEntries: actual.length, goldTopics: gold.topics.length, actualTopics: actualTopics.length, negatives: gold.negatives.length, questions: questionRows.length },
      byQuestionKind,
      decisions: decisionRows,
      topics: topicRows.map(({ keyPoints: points, ...row }) => ({ ...row, keyPoints: ratio(points.filter(Boolean).length, points.length) })),
      writes: actual.map((a) => ({ uid: a.uid, kind: a.kind, content: a.content, label: a.attr.label, ids: a.attr.ids, matched: owner.get(a.uid) ?? null, source: a.attr.source, reason: a.attr.reason })),
      missedEntries: required.filter((g) => !pairOfGold.has(g.id)).map((g) => g.id),
      negativesWritten: [...negativeHits],
      questions: questionRows,
      apiChecks: run.apiChecks ?? []
    }
  };
}

// SUT model usage recorded by harness/usage-proxy.mjs, one JSON object per line:
// {at, path, status, latencyMs, model, usage: {prompt_tokens, completion_tokens, prompt_tokens_details: {cached_tokens}}}
// or {at, path, error} when the upstream call failed.
export function loadSutUsage(path) {
  const lines = [];
  let unparsed = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line)); } catch { unparsed += 1; }
  }
  return { path, lines, unparsed };
}

const PHASE_BY_PATH = { "/add/message": "add", "/get/status": "add", "/search/memory": "search", "/api/v1/memory/add": "add", "/api/v1/memory/search": "search" };
const NO_USAGE = "no SUT usage file: pass --sut-usage <file> or MEMMY_EVAL_SUT_USAGE (written by harness/usage-proxy.mjs)";
const OLD_RUNNER = "run was recorded by a runner without task timing and request phases (runnerRevision < 2)";
const latency = (values) => ({ n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) });

// Efficiency per phase (metrics.md「指标定义 … 效率」). Averages of tokens are per SUT model call and
// input tokens include cache hits; avgCostUsd is per product request (add/message or search/memory).
// Fields that cannot be measured are null and explained in that block's `reasons`.
export function efficiency(run, { judgeUsage, sutUsage, pricing }) {
  const requests = run.requests ?? [];
  const phased = requests.length > 0 && requests.every((r) => typeof r.phase === "string");
  const phaseOf = (r) => (phased ? r.phase : PHASE_BY_PATH[r.call] ?? "other");
  const isPoll = (r) => r.poll ?? r.call === "/get/status";

  // SUT calls inside the run's time window; v0.1 search makes no model call, so all go to add.
  let sut = null;
  if (sutUsage) {
    const from = run.startedAt ? Date.parse(run.startedAt) - 1_000 : -Infinity;
    const to = run.startedAt && typeof run.wallclockMs === "number" ? Date.parse(run.startedAt) + run.wallclockMs + 5_000 : Infinity;
    const inRun = sutUsage.lines.filter((line) => { const at = Date.parse(line.at); return !Number.isFinite(at) || (at >= from && at <= to); });
    const calls = inRun.map((line) => {
      const u = line.usage ?? null;
      const prompt = u?.prompt_tokens ?? (u?.input_tokens !== undefined ? u.input_tokens + (u.cache_read_input_tokens ?? 0) : null);
      const cached = u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0;
      return { at: Date.parse(line.at), failed: Boolean(line.error) || !(line.status >= 200 && line.status < 300), hasUsage: prompt !== null, model: line.model ?? run.sut?.model ?? null, prompt: prompt ?? 0, cached, output: u?.completion_tokens ?? u?.output_tokens ?? 0, latencyMs: line.latencyMs };
    });
    const searchWindows = phased ? requests.filter((r) => phaseOf(r) === "search" && typeof r.at === "number").map((r) => [r.at, r.at + r.ms]) : null;
    sut = {
      file: sutUsage.path,
      lines: sutUsage.lines.length,
      unparsedLines: sutUsage.unparsed,
      outsideRun: sutUsage.lines.length - inRun.length,
      models: [...new Set(calls.map((c) => c.model))],
      attribution: "v0.1 search makes no SUT model calls: every call in the usage file is attributed to add, search is 0 measured",
      callsDuringSearchRequests: searchWindows ? calls.filter((c) => searchWindows.some(([a, b]) => c.at >= a && c.at <= b)).length : null,
      calls
    };
    if (sut.callsDuringSearchRequests === null) sut.reasons = { callsDuringSearchRequests: OLD_RUNNER };
  }

  const tasks = (run.tasks ?? []).filter((t) => t.task_id);
  const timedTasks = tasks.filter((t) => typeof t.completedMs === "number");

  function block(name) {
    const product = requests.filter((r) => phaseOf(r) === name && !isPoll(r));
    const polls = requests.filter((r) => phaseOf(r) === name && isPoll(r));
    const reasons = {};
    const out = {
      requests: product.length,
      pollingRequests: polls.length,
      wallclockMs: run.phaseMs?.[name] ?? null,
      latencyMs: latency(product.map((r) => r.ms)),
      llmCalls: null, failedLlmCalls: null, inputTokens: null, cachedInputTokens: null, outputTokens: null,
      avgInputTokens: null, avgOutputTokens: null, avgCostUsd: null, totalCostUsd: null
    };
    if (!requests.length) reasons.requests = "run has no request log";
    else if (!phased) reasons.requests = `${OLD_RUNNER}; requests are split by path, so API-check calls are included`;
    if (out.wallclockMs === null) reasons.wallclockMs = run.phaseMs ? `no time was spent in ${name}` : `${OLD_RUNNER}; efficiency.wallclockMs is the whole run`;
    if (!product.length) reasons.latencyMs = "no requests";
    const calls = name === "add" ? sut?.calls ?? null : sut ? [] : null;
    if (!calls) {
      for (const field of ["llmCalls", "failedLlmCalls", "inputTokens", "cachedInputTokens", "outputTokens", "avgInputTokens", "avgOutputTokens", "avgCostUsd", "totalCostUsd"]) reasons[field] = NO_USAGE;
    } else {
      const withUsage = calls.filter((c) => c.hasUsage);
      Object.assign(out, {
        llmCalls: calls.length,
        failedLlmCalls: calls.filter((c) => c.failed).length,
        inputTokens: withUsage.reduce((t, c) => t + c.prompt, 0),
        cachedInputTokens: withUsage.reduce((t, c) => t + c.cached, 0),
        outputTokens: withUsage.reduce((t, c) => t + c.output, 0)
      });
      if (withUsage.length < calls.length) reasons.inputTokens = reasons.outputTokens = `${calls.length - withUsage.length} call(s) have no usage (upstream error); token sums cover the rest`;
      if (name === "add") {
        out.avgInputTokens = withUsage.length ? out.inputTokens / withUsage.length : null;
        out.llmLatencyMs = latency(calls.map((c) => c.latencyMs).filter((v) => typeof v === "number"));
      } else {
        reasons.avgInputTokens = "measured for add only (metrics.md)";
        reasons.llmCalls = sut.attribution;
      }
      out.avgOutputTokens = withUsage.length ? out.outputTokens / withUsage.length : null;
      if (!withUsage.length) reasons.avgOutputTokens = `no SUT model calls in ${name}`;
      if (name === "add" && !withUsage.length) reasons.avgInputTokens = "no SUT model calls in add";
      const price = priceCalls(withUsage.map((c) => ({ model: c.model, inputTokens: c.prompt - c.cached, cachedInputTokens: c.cached, outputTokens: c.output })), pricing);
      out.totalCostUsd = price.costUsd;
      out.avgCostUsd = price.costUsd === null || !product.length ? null : price.costUsd / product.length;
      if (price.reason) reasons.totalCostUsd = reasons.avgCostUsd = price.reason;
      else if (!product.length) reasons.avgCostUsd = "no requests";
    }
    if (name === "add") {
      out.task = timedTasks.length
        ? { n: timedTasks.length, of: tasks.length, p50: percentile(timedTasks.map((t) => t.completedMs), 50), p95: percentile(timedTasks.map((t) => t.completedMs), 95), mean: mean(timedTasks.map((t) => t.completedMs)), detectionSlackMeanMs: mean(timedTasks.map((t) => t.detectionSlackMs ?? 0)) }
        : null;
      if (!out.task) reasons.task = tasks.length ? OLD_RUNNER : "no add tasks";
    }
    if (Object.keys(reasons).length) out.reasons = reasons;
    return out;
  }

  const model = (usage) => {
    if (!usage) return null;
    const { perCall, latencyMs, ...rest } = usage;
    const price = priceUsage(usage, pricing);
    return { ...rest, costUsd: price.costUsd, ...(price.reason ? { reasons: { costUsd: price.reason } } : {}) };
  };
  const byCall = {};
  for (const request of requests) (byCall[request.call] ??= []).push(request.ms);
  const checkRequests = requests.filter((r) => r.phase === "check");
  return {
    notes: "avgInputTokens / avgOutputTokens are per SUT model call, input includes cache hits; avgCostUsd is per add/message or search/memory request; task.* is add/message response → the get/status poll that saw completed (upper bound, completion happened at most detectionSlackMs earlier); judge and reader are not part of the product",
    wallclockMs: run.wallclockMs ?? null,
    phaseWallclockMs: run.phaseMs ?? null,
    add: block("add"),
    search: block("search"),
    checks: phased ? { requests: checkRequests.length } : { requests: null, reasons: { requests: OLD_RUNNER } },
    sutUsage: sut ? { ...sut, calls: undefined } : { reasons: { file: NO_USAGE } },
    latencyByCall: Object.fromEntries(Object.entries(byCall).map(([call, values]) => [call, latency(values)])),
    reader: model(run.usage?.reader ?? null),
    judge: model(judgeUsage)
  };
}

function parseArgs(argv) {
  const options = { thresholds: { "decisions.stateExact": 0.8, "topics.bcubed.f1": 0.8, "entries.f1": 0.8, "search.recall@3": 0.85, "answers.llm": 0.8, "api.passRate": 1 }, maxDuplicateRate: 0.02, maxWrongMergeRate: 0.01 };
  const flags = { "--min-decision-state": "decisions.stateExact", "--min-topic-f1": "topics.bcubed.f1", "--min-entry-f1": "entries.f1", "--min-recall-at-3": "search.recall@3", "--min-answer": "answers.llm" };
  const caps = { "--max-duplicate-rate": "maxDuplicateRate", "--max-wrong-merge-rate": "maxWrongMergeRate" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [name, value] = arg.split("=");
    if (arg === "--oracle" || arg === "--empty") options.mode = arg.slice(2);
    else if (arg === "--gate") options.gate = true;
    else if (arg === "--prune-judge-cache") options.prune = true;
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--sut-usage") options.sutUsage = argv[++i];
    else if (name === "--sut-usage") options.sutUsage = value;
    else if (flags[name]) options.thresholds[flags[name]] = Number(value);
    else if (caps[name]) options[caps[name]] = Number(value ?? argv[++i]);
    else if (!arg.startsWith("--")) options.input = arg;
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseArgs(process.argv.slice(2));
  const ds = loadDataset();
  const gold = loadGold();
  let run;
  let llm;
  if (options.mode) {
    run = options.mode === "oracle" ? buildOracleRun(ds, gold) : buildEmptyRun(ds, gold);
    llm = createLlm({ config: null });
  } else {
    if (!options.input) { console.error("usage: node run-pipeline-eval.mjs <live-run.json> [--out report.json] [--gate] | --oracle | --empty"); process.exit(2); }
    run = JSON.parse(readFileSync(options.input, "utf8"));
    if (run.runVersion !== 2) throw new Error("run file is not runVersion 2");
    const config = resolveModelConfig("MEMMY_EVAL_JUDGE");
    try {
      assertJudgeFamily(config, process.env.MEMMY_EVAL_SUT_MODEL ?? run.sut?.model);
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
    llm = createLlm({ config, cachePath: join(RUNS_DIR, "judge-cache.json"), concurrency: Number(process.env.MEMMY_EVAL_JUDGE_CONCURRENCY ?? 6) });
  }
  const judge = createJudge(llm);
  let result;
  try {
    result = await scoreRun(run, { ds, gold, judge });
  } finally {
    llm.save({ prune: options.prune });
  }
  const pricing = JSON.parse(readFileSync(join(root, "pricing.json"), "utf8"));
  const sutUsagePath = options.sutUsage ?? process.env.MEMMY_EVAL_SUT_USAGE ?? null;
  const report = {
    reportVersion: 2,
    run: { kind: run.kind ?? "live", input: options.input ?? null, startedAt: run.startedAt ?? null, base: run.base ?? null, sut: run.sut ?? null, reader: run.reader ?? null },
    judge: { model: llm.config?.model ?? null, family: llm.config?.family ?? null, promptVersion: JUDGE_PROMPT_VERSION, temperature: 0 },
    ...result,
    efficiency: efficiency(run, { judgeUsage: llm.usage, sutUsage: sutUsagePath ? loadSutUsage(sutUsagePath) : null, pricing })
  };
  const failures = [];
  if (options.mode === "oracle") {
    for (const [key, value] of Object.entries(report.scores)) if (value !== 1) failures.push(`${key}=${value}, oracle must be 1`);
    for (const [key, value] of Object.entries(report.errors)) if (value !== 0) failures.push(`${key}=${value}, oracle must be 0`);
  } else if (options.mode === "empty") {
    for (const [key, value] of Object.entries(report.scores)) if (value !== 0) failures.push(`${key}=${value}, empty must be 0`);
  } else if (options.gate) {
    for (const [key, min] of Object.entries(options.thresholds)) if (!(report.scores[key] >= min)) failures.push(`${key}=${report.scores[key]} < ${min}`);
    for (const key of ["search.staleShownAsCurrent", "search.crossProjectLeak", "search.foreignTopics", "decisions.reasonFabricated", "topics.controlMerges", "writes.lateAsCurrent"]) if (report.errors[key] !== 0) failures.push(`${key}=${report.errors[key]} must be 0`);
    if (!(report.errors["topics.duplicateRate"] <= options.maxDuplicateRate)) failures.push(`topics.duplicateRate=${report.errors["topics.duplicateRate"]} > ${options.maxDuplicateRate}`);
    if (!(report.errors["topics.wrongMergeRate"] <= options.maxWrongMergeRate)) failures.push(`topics.wrongMergeRate=${report.errors["topics.wrongMergeRate"]} > ${options.maxWrongMergeRate}`);
  }
  report.check = { mode: options.mode ?? (options.gate ? "gate" : "report"), failures };
  const out = options.out ?? (options.input ? join(dirname(options.input), "report.json") : join(RUNS_DIR, `${options.mode}-report.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ out, scores: report.scores, errors: report.errors, failures })}\n`);
  process.exit(failures.length ? 1 : 0);
}

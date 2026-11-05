#!/usr/bin/env node
// Derives dataset v2 gold from the corpus and the per-trace labels by replaying the labelled
// M05 ops in chat_time order (v3 §2.2.9). The result is committed as dataset/gold.json;
// load-eval-set.mjs rebuilds it and fails when the committed copy drifts.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
export const DATASET_DIR = join(root, "dataset");
export const GOLD_PATH = join(DATASET_DIR, "gold.json");

export function loadDataset(dir = DATASET_DIR) {
  const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
  return { corpus: read("corpus.json"), labels: read("labels.json"), conflicts: read("conflicts.json"), questions: read("questions.json") };
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const union = (left, right) => [...new Set([...left, ...right])];

export function orderedTraces(corpus) {
  return corpus.traces.map((trace, index) => ({ trace, index }))
    .sort((a, b) => a.trace.chat_time.localeCompare(b.trace.chat_time) || a.index - b.index)
    .map(({ trace }) => trace);
}

// Replays labelled ops for every trace whose reply landed at or before `until`.
// Returns entry states keyed by gold entry id, plus rule violations found on the way.
export function replay(ds, until = "9999") {
  const conversations = new Map(ds.corpus.conversations.map((c) => [c.id, c]));
  const meta = ds.labels.entries;
  const state = new Map();
  const errors = [];
  const informedConversations = new Set();
  for (const trace of orderedTraces(ds.corpus)) {
    if (trace.reply_time > until) continue;
    const conversation = conversations.get(trace.conversation);
    const label = ds.labels.traces[trace.id];
    if (!label) { errors.push(`${trace.id} has no label`); continue; }
    const notes = trace.annotations ?? [];
    if (notes.some((n) => n.type === "informed")) informedConversations.add(trace.conversation);
    for (const op of label.ops) {
      const where = `${trace.id}:${op.op}:${op.entry}`;
      const by = op.by ?? conversation?.user_id;
      const at = { time: trace.chat_time, timeWindow: [trace.chat_time, trace.reply_time] };
      const kind = meta[op.entry]?.kind;
      if (!kind) { errors.push(`${where} unknown entry`); continue; }
      let entry = state.get(op.entry);
      if (op.op === "add") {
        if (entry) { errors.push(`${where} adds an entry that already exists`); continue; }
        state.set(op.entry, { content: op.content, ...at, user_ids: [by], history: [], conflicts: [], sources: [trace.id], superseded: [] });
        continue;
      }
      if (!entry) { errors.push(`${where} targets an entry that does not exist yet`); continue; }
      entry.sources = union(entry.sources, [trace.id]);
      const inContent = entry.user_ids.includes(by);
      const conflictIndex = entry.conflicts.findIndex((item) => item.user_ids.includes(by));
      const approval = notes.some((n) => n.type === "approval");
      if (op.op === "conflict_append") {
        if (kind !== "decision") errors.push(`${where} conflicts exist only on decisions`);
        if (inContent || conflictIndex >= 0 || approval) errors.push(`${where} author already owns a conclusion or was approved; conflict_append is wrong`);
        entry.conflicts.push({ content: op.content, ...at, user_ids: [by] });
      } else if (op.op === "conflict_update") {
        const item = entry.conflicts[op.target];
        if (!item || !item.user_ids.includes(by)) { errors.push(`${where} author does not own conflicts[${op.target}]`); continue; }
        entry.superseded.push(item.content);
        Object.assign(item, { content: op.content, ...at });
      } else if (op.op === "rewrite" || op.op === "update") {
        if (op.op === "rewrite" && kind !== "decision") errors.push(`${where} rewrite is for decisions`);
        if (op.op === "update" && kind !== "experience") errors.push(`${where} update is for experiences`);
        if (op.op === "rewrite" && !inContent && !approval) errors.push(`${where} neither author nor approved; must be conflict_append`);
        if (op.op === "rewrite" && op.via !== (inContent ? "author" : "approval")) errors.push(`${where} via should be ${inContent ? "author" : "approval"}`);
        if (op.reason === undefined) errors.push(`${where} must state reason (null when the conversation gives none)`);
        entry.history.push({ content: entry.content, time: entry.time, timeWindow: entry.timeWindow, user_ids: entry.user_ids, reason: op.reason ?? null });
        Object.assign(entry, { content: op.content, ...at, user_ids: [by] });
        if (op.mergeConflict !== undefined) {
          const [merged] = entry.conflicts.splice(op.mergeConflict, 1);
          if (!merged) errors.push(`${where} mergeConflict ${op.mergeConflict} missing`);
          else entry.user_ids = union(entry.user_ids, merged.user_ids);
        }
      } else if (op.op === "resolve") {
        const picked = entry.conflicts[op.target];
        if (!picked) { errors.push(`${where} conflicts[${op.target}] missing`); continue; }
        if (!notes.some((n) => n.type === "resolve")) errors.push(`${where} needs a resolve signal`);
        if (!informedConversations.has(trace.conversation)) errors.push(`${where} conversation was never informed`);
        const reason = op.reason ?? null;
        const losers = [{ content: entry.content, time: entry.time, timeWindow: entry.timeWindow, user_ids: entry.user_ids }, ...entry.conflicts.filter((_, i) => i !== op.target)];
        for (const loser of losers) entry.history.push({ ...loser, reason });
        Object.assign(entry, { content: picked.content, time: picked.time, timeWindow: picked.timeWindow, user_ids: picked.user_ids, conflicts: [] });
      } else {
        errors.push(`${where} unknown op`);
      }
    }
  }
  return { state, errors };
}

export function buildGold(ds) {
  const { corpus, labels, questions } = ds;
  const { state, errors } = replay(ds);
  const topics = new Map(labels.topics.map((topic) => [topic.id, topic]));
  const conversations = new Map(corpus.conversations.map((c) => [c.id, c]));
  const entries = Object.entries(labels.entries).map(([id, meta]) => {
    const final = state.get(id);
    if (!final) { errors.push(`${id} is labelled but never written`); return null; }
    const topic = topics.get(meta.topic);
    if (!topic) errors.push(`${id} topic ${meta.topic} missing`);
    const staleVersions = [...final.history.map((item) => item.content), ...final.superseded];
    return {
      id,
      kind: meta.kind,
      ...(meta.category ? { category: meta.category } : {}),
      optional: meta.optional === true,
      topic: meta.topic,
      space_id: topic?.space_id,
      content: final.content,
      time: final.time,
      timeWindow: final.timeWindow,
      user_ids: final.user_ids,
      ...(meta.kind === "decision" ? { conflicts: final.conflicts, history: final.history } : {}),
      ...(meta.kind === "experience" ? { history: final.history } : {}),
      staleVersions,
      sources: final.sources,
      ...(meta.alternatives ? { alternatives: meta.alternatives } : {})
    };
  }).filter(Boolean);

  const negatives = [];
  const traceLabels = orderedTraces(corpus).map((trace) => {
    const label = labels.traces[trace.id] ?? { ops: [] };
    const space_id = conversations.get(trace.conversation)?.space_id;
    for (const [index, drop] of (label.dropped ?? []).entries()) {
      if (drop.nw) negatives.push({ id: `nw_${trace.id}${index ? `_${index}` : ""}`, trace: trace.id, space_id, text: drop.nw, reason: drop.reason });
    }
    const required = label.ops.filter((op) => !labels.entries[op.entry]?.optional);
    return {
      trace: trace.id,
      space_id,
      outcome: required.length ? "written" : label.ops.length ? "optional-only" : "not-written",
      ops: label.ops.map((op) => `${op.op}:${op.entry}`),
      dropped: (label.dropped ?? []).map((drop) => drop.reason)
    };
  });

  const goldTopics = labels.topics.map((topic) => ({ ...topic, entries: entries.filter((entry) => entry.topic === topic.id).map((entry) => entry.id) }));

  const goldQuestions = questions.questions.map((question) => {
    const { state: snap } = replay(ds, question.askedAt);
    const expectedItems = [];
    for (const want of question.expect.entries) {
      const entry = snap.get(want.entry);
      if (!entry) { errors.push(`${question.id} expects ${want.entry} before it exists`); continue; }
      for (const part of want.parts) {
        if (part === "content") expectedItems.push({ entry: want.entry, part, text: entry.content });
        else if (part === "conflicts") {
          if (!entry.conflicts.length) errors.push(`${question.id} expects conflicts on ${want.entry} but there are none at askedAt`);
          entry.conflicts.forEach((item, index) => expectedItems.push({ entry: want.entry, part, index, text: item.content }));
        } else errors.push(`${question.id} unknown part ${part}`);
      }
    }
    const trapItems = [];
    for (const trap of question.traps) {
      const entry = snap.get(trap.entry);
      if (!entry) { errors.push(`${question.id} trap ${trap.entry} does not exist at askedAt`); continue; }
      if (trap.kind === "stale") {
        const item = entry.history[trap.history];
        if (!item) errors.push(`${question.id} stale trap ${trap.entry} history[${trap.history}] missing at askedAt`);
        else trapItems.push({ entry: trap.entry, kind: "stale", text: item.content });
      } else if (trap.kind === "cross-project") {
        const texts = [entry.content, ...entry.conflicts.map((c) => c.content), ...entry.history.map((h) => h.content)];
        trapItems.push({ entry: trap.entry, kind: "cross-project", texts });
      } else errors.push(`${question.id} unknown trap kind ${trap.kind}`);
    }
    return {
      id: question.id,
      kind: question.kind,
      askedAt: question.askedAt,
      conversation: question.conversation,
      space_id: question.space_id,
      question: question.question,
      goldAnswer: question.goldAnswer,
      mustInclude: question.mustInclude,
      ...(question.excluded ? { excluded: true, excludedReason: question.excludedReason } : {}),
      expectedTopics: question.expect.topics,
      expectedItems,
      trapItems
    };
  });

  return {
    gold: {
      datasetVersion: 2,
      derivedFrom: ["dataset/corpus.json", "dataset/labels.json", "dataset/questions.json"],
      spaces: corpus.spaces,
      members: corpus.members,
      topics: goldTopics,
      entries,
      negatives,
      traceLabels,
      questions: goldQuestions,
      apiChecks: questions.apiChecks
    },
    errors
  };
}

export function renderGold(gold) {
  return `${JSON.stringify(gold, null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { gold, errors } = buildGold(loadDataset());
  if (errors.length) {
    console.error(JSON.stringify({ errors }, null, 2));
    process.exit(1);
  }
  writeFileSync(GOLD_PATH, renderGold(gold));
  const count = (kind, optional) => gold.entries.filter((e) => e.kind === kind && e.optional === optional).length;
  console.log(JSON.stringify({
    output: "dataset/gold.json",
    topics: gold.topics.length,
    decisions: count("decision", false),
    experiences: count("experience", false),
    timeline: count("timeline", false),
    optionalTimeline: count("timeline", true),
    negatives: gold.negatives.length,
    questions: gold.questions.filter((q) => !q.excluded).length,
    apiChecks: gold.apiChecks.length
  }));
}

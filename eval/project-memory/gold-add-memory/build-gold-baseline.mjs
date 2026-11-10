#!/usr/bin/env node
// Derives dataset v2.1 gold from the corpus and the per-trace labels by replaying the labelled
// M05 ops in submit order (v3 §2.2.9). The result is committed as dataset/gold.json;
// load-eval-set.mjs rebuilds it and fails when the committed copy drifts.
// Ordering uses submit_time ?? chat_time. A trace is visible once submit_time ?? reply_time
// has passed. resubmitOf creates no ops. deferredUntil applies the op at the later trace.
// history_backfill inserts history by time and leaves the current version alone.
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

// submit_time defaults to chat_time. Replay order follows submission; visibility follows
// submit_time ?? reply_time (a late submit is not visible at its chat_time).
export function traceOrderTime(trace) {
  return trace.submit_time ?? trace.chat_time;
}

export function traceVisibleTime(trace) {
  return trace.submit_time ?? trace.reply_time;
}

// resubmitOf reuses the original trace. The add body is built from that trace, byte for byte.
export function submittedTrace(trace, traces) {
  const byId = traces instanceof Map ? traces : new Map((traces ?? []).map((item) => [item.id, item]));
  const seen = new Set();
  let current = trace;
  while (current?.resubmitOf) {
    if (seen.has(current.id)) throw new Error(`${trace.id} resubmit cycle`);
    seen.add(current.id);
    const next = byId.get(current.resubmitOf);
    if (!next) throw new Error(`${current.id} resubmitOf ${current.resubmitOf} missing`);
    current = next;
  }
  return current;
}

export function projectAddBody(trace, { traces, conversation, conversationId, spaceId, memberName }) {
  const source = submittedTrace(trace, traces);
  const clock = (iso) => String(iso).slice(0, 19).replace("T", " ");
  return {
    user_id: conversation.user_id,
    agent_id: conversation.agent_id,
    conversation_id: conversationId,
    space_ids: [spaceId],
    domains: [source.domain],
    allow_memory_view: ["project"],
    async_mode: true,
    messages: [
      { role: "user", role_id: conversation.user_id, role_name: memberName, chat_time: clock(source.chat_time), content: source.query },
      { role: "assistant", chat_time: clock(source.reply_time), content: source.answer }
    ]
  };
}

export function orderedTraces(corpus) {
  return corpus.traces.map((trace, index) => ({ trace, index }))
    .sort((a, b) => traceOrderTime(a.trace).localeCompare(traceOrderTime(b.trace)) || a.index - b.index)
    .map(({ trace }) => trace);
}

function pointActive(point, traces, at) {
  const since = traces.get(point?.since);
  if (!since || traceVisibleTime(since) > at) return false;
  if (!point.until) return true;
  const until = traces.get(point.until);
  return !until || traceVisibleTime(until) > at;
}

// Points whose since trace is visible at `at` and whose until trace is not.
export function activePointTexts(points, traces, at) {
  const map = traces instanceof Map ? traces : new Map((traces ?? []).map((trace) => [trace.id, trace]));
  return (points ?? []).filter((point) => pointActive(point, map, at)).map((point) => point.text);
}

// Scoring uses the final wording: points that are not retired (no until).
export function finalPointTexts(points) {
  return (points ?? []).filter((point) => point && !point.until).map((point) => point.text);
}

// A late decision was spoken before the current version and submitted after it.
// It must not rewrite that later version (v3 §2.2.9).
export function isLateDecision(trace, entry) {
  return Boolean(entry && trace.submit_time && trace.chat_time < entry.time && trace.submit_time > entry.time);
}

// Replays labelled ops visible at or before `until` (submit_time ?? reply_time).
// stopBeforeId cuts the replay just before that trace, in submit order.
// Returns entry states keyed by gold entry id, plus rule violations found on the way.
export function replay(ds, until = "9999", { stopBeforeId } = {}) {
  const conversations = new Map(ds.corpus.conversations.map((c) => [c.id, c]));
  const meta = ds.labels.entries;
  const state = new Map();
  const errors = [];
  const informedConversations = new Set();
  const waiting = [];

  function apply(op, source, release) {
    const conversation = conversations.get(source.conversation);
    const notes = source.annotations ?? [];
    const where = `${source.id}:${op.op}:${op.entry}`;
    const by = op.by ?? conversation?.user_id;
    const at = { time: source.chat_time, timeWindow: [source.chat_time, source.reply_time] };
    const sourceIds = source.id === release.id ? [source.id] : [source.id, release.id];
    const kind = meta[op.entry]?.kind;
    if (!kind) { errors.push(`${where} unknown entry`); return; }
    let entry = state.get(op.entry);
    if (op.op === "add") {
      if (entry) { errors.push(`${where} adds an entry that already exists`); return; }
      state.set(op.entry, {
        content: op.content, ...at, user_ids: [by], history: [], conflicts: [], sources: sourceIds, superseded: [],
        ...(source.id !== release.id ? { deferred: true } : {})
      });
      return;
    }
    if (!entry) { errors.push(`${where} targets an entry that does not exist yet`); return; }
    if ((op.op === "rewrite" || op.op === "update") && isLateDecision(source, entry)) {
      errors.push(`${where} late decision must not rewrite`);
      return;
    }
    entry.sources = union(entry.sources, sourceIds);
    const inContent = entry.user_ids.includes(by);
    const conflictIndex = entry.conflicts.findIndex((item) => item.user_ids.includes(by));
    const approval = notes.some((n) => n.type === "approval");
    const late = isLateDecision(source, entry);
    if (op.op === "history_backfill") {
      entry.history.push({ content: op.content, time: op.time ?? source.chat_time, timeWindow: at.timeWindow, user_ids: [by], reason: op.reason ?? null });
      entry.history.sort((a, b) => a.time.localeCompare(b.time) || a.content.localeCompare(b.content));
      return;
    }
    if (op.op === "conflict_append") {
      if (kind !== "decision") errors.push(`${where} conflicts exist only on decisions`);
      if (inContent || conflictIndex >= 0 || approval) errors.push(`${where} author already owns a conclusion or was approved; conflict_append is wrong`);
      entry.conflicts.push({ content: op.content, ...at, user_ids: [by], ...(late ? { late: true } : {}) });
    } else if (op.op === "conflict_update") {
      const item = entry.conflicts[op.target];
      if (!item || !item.user_ids.includes(by)) { errors.push(`${where} author does not own conflicts[${op.target}]`); return; }
      entry.superseded.push(item.content);
      Object.assign(item, { content: op.content, ...at, ...(late ? { late: true } : {}) });
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
      if (!picked) { errors.push(`${where} conflicts[${op.target}] missing`); return; }
      if (!notes.some((n) => n.type === "resolve")) errors.push(`${where} needs a resolve signal`);
      if (!informedConversations.has(source.conversation)) errors.push(`${where} conversation was never informed`);
      const reason = op.reason ?? null;
      const losers = [{ content: entry.content, time: entry.time, timeWindow: entry.timeWindow, user_ids: entry.user_ids }, ...entry.conflicts.filter((_, i) => i !== op.target)];
      for (const loser of losers) entry.history.push({ ...loser, reason });
      Object.assign(entry, { content: picked.content, time: picked.time, timeWindow: picked.timeWindow, user_ids: picked.user_ids, conflicts: [] });
    } else {
      errors.push(`${where} unknown op`);
    }
  }

  for (const trace of orderedTraces(ds.corpus)) {
    if (stopBeforeId && trace.id === stopBeforeId) break;
    if (traceVisibleTime(trace) > until) continue;
    const label = ds.labels.traces[trace.id];
    if (!label) { errors.push(`${trace.id} has no label`); continue; }
    if (trace.resubmitOf) {
      if ((label.ops ?? []).length) errors.push(`${trace.id} resubmit creates no ops`);
      continue;
    }
    const notes = trace.annotations ?? [];
    if (notes.some((n) => n.type === "informed")) informedConversations.add(trace.conversation);
    for (const item of waiting) {
      if (item.done || item.op.deferredUntil !== trace.id) continue;
      apply(item.op, item.trace, trace);
      item.done = true;
    }
    for (const op of label.ops ?? []) {
      if (op.deferredUntil) { waiting.push({ op, trace, done: false }); continue; }
      apply(op, trace, trace);
    }
  }
  for (const item of waiting) {
    if (item.done) continue;
    const target = ds.corpus.traces.find((trace) => trace.id === item.op.deferredUntil);
    if (!target) errors.push(`${item.trace.id}:${item.op.op}:${item.op.entry} deferredUntil ${item.op.deferredUntil} missing`);
    else if (!stopBeforeId && traceVisibleTime(target) <= until) errors.push(`${item.trace.id}:${item.op.op}:${item.op.entry} deferredUntil ${target.id} did not apply`);
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
      ...(final.deferred ? { deferred: true } : {}),
      ...(meta.alternatives ? { alternatives: meta.alternatives } : {})
    };
  }).filter(Boolean);

  const negatives = [];
  const traceLabels = orderedTraces(corpus).map((trace) => {
    const label = labels.traces[trace.id] ?? { ops: [] };
    const space_id = conversations.get(trace.conversation)?.space_id;
    for (const [index, drop] of (label.dropped ?? []).entries()) {
      if (drop.nw) negatives.push({ id: `nw_${trace.id}${index ? `_${index}` : ""}`, trace: trace.id, space_id, text: drop.nw, reason: drop.reason, ...(drop.deferred ? { deferred: true } : {}) });
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
      datasetVersion: 2.1,
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

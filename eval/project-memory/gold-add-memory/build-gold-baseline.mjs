#!/usr/bin/env node
// Derives the gold fixtures from the corpus and labelled memory operations. The v2.1 archive replays
// M05 ops in submit order (v3 §2.2.9). The result is committed as dataset/gold.json;
// load-eval-set.mjs rebuilds it and fails when the committed copy drifts.
// Ordering uses submit_time ?? chat_time. A trace is visible once submit_time ?? reply_time
// has passed. resubmitOf creates no ops. deferredUntil applies the op at the later trace.
// history_backfill inserts history by time and leaves the current version alone.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FLUSH_BY_DEFAULT, buildEpisodeTimeline, effectiveQuestions, validateEpisodeLabels } from "./episode-timeline.mjs";

export { effectiveQuestions };

const root = dirname(fileURLToPath(import.meta.url));
export const DATASET_DIR = join(root, "dataset");
export const GOLD_PATH = join(DATASET_DIR, "gold.json");

export function datasetDirectory(version) {
  if (version === undefined || Number(version) === 3) return DATASET_DIR;
  if (Number(version) === 2.1) return join(root, "history", "v2.1");
  throw new Error(`unsupported dataset version ${version}`);
}

export function loadDataset(dir = DATASET_DIR) {
  const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
  const corpus = read("corpus.json");
  const ds = { corpus, labels: read("labels.json"), conflicts: read("conflicts.json"), questions: read("questions.json") };
  if (corpus.datasetVersion === 3) ds.episodes = read("episodes.json");
  return ds;
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

function visibilityOf(trace, timeline) {
  return timeline ? timeline.commitByTrace.get(trace.id) : traceVisibleTime(trace);
}

function pointActive(point, traces, at, timeline) {
  const since = traces.get(point?.since);
  const visibleSince = since && visibilityOf(since, timeline);
  if (!visibleSince || visibleSince > at) return false;
  if (!point.until) return true;
  const until = traces.get(point.until);
  const visibleUntil = until && visibilityOf(until, timeline);
  return !visibleUntil || visibleUntil > at;
}

// Points whose since trace is visible at `at` and whose until trace is not.
export function activePointTexts(points, traces, at, timeline) {
  const map = traces instanceof Map ? traces : new Map((traces ?? []).map((trace) => [trace.id, trace]));
  return (points ?? []).filter((point) => pointActive(point, map, at, timeline)).map((point) => point.text);
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
export function replay(ds, until = "9999", { stopBeforeId, traceMode = false, timeline, flush = FLUSH_BY_DEFAULT } = {}) {
  const episodeTimeline = !traceMode && ds.episodes ? timeline ?? buildEpisodeTimeline(ds, { flush }) : null;
  const conversations = new Map(ds.corpus.conversations.map((c) => [c.id, c]));
  const meta = ds.labels.entries;
  const state = new Map();
  const errors = [];
  const informedConversations = new Set();
  const informedTurns = new Map();
  if (episodeTimeline) {
    for (const trace of ds.corpus.traces) {
      if (!trace.annotations?.some((note) => note.type === "informed")) continue;
      const turns = informedTurns.get(trace.conversation) ?? [];
      turns.push(trace);
      informedTurns.set(trace.conversation, turns);
    }
  }
  const waiting = [];
  // `${trace}:${decision}` where a member replaced their own position; each needs a change record.
  const changes = new Set();
  // v3 has no permission or arbitration step. The frozen v2.1 still lets a relayed approval
  // rewrite and has no change records.
  const v3Policy = ds.corpus.datasetVersion >= 3;

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
    const late = isLateDecision(source, entry);
    const approval = !v3Policy && notes.some((n) => n.type === "approval");
    // Project memory has no permission or arbitration step: only a member's own position can be
    // replaced by that member, and every such replacement is recorded as a timeline entry.
    const picked = op.op === "resolve" ? entry.conflicts[op.target] : null;
    const ownChange = op.op === "rewrite" ? inContent && op.content !== entry.content
      : op.op === "conflict_update" ? Boolean(entry.conflicts[op.target]?.user_ids.includes(by)) && op.content !== entry.conflicts[op.target].content
        : op.op === "resolve" && picked ? (inContent && !picked.user_ids.includes(by)) || entry.conflicts.some((item, i) => i !== op.target && item.user_ids.includes(by))
          : false;
    if (ownChange && v3Policy) {
      changes.add(`${source.id}:${op.entry}`);
      const recorded = (ds.labels.traces[source.id]?.ops ?? []).some((other) => other.op === "add" && meta[other.entry]?.changeOf === op.entry);
      if (!recorded) errors.push(`${where} replaces the member's own position; add a timeline entry with changeOf ${op.entry}`);
    }
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
      // A relayed agreement ("I checked with the author") does not authorize a rewrite.
      if (op.op === "rewrite" && !inContent && !approval) errors.push(`${where} only the author rewrites; must be conflict_append`);
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
      if (!picked) { errors.push(`${where} conflicts[${op.target}] missing`); return; }
      if (!notes.some((n) => n.type === "resolve")) errors.push(`${where} needs a resolve signal`);
      const informed = episodeTimeline
        ? (informedTurns.get(source.conversation) ?? []).some((trace) => traceVisibleTime(trace) < traceVisibleTime(source))
        : informedConversations.has(source.conversation);
      if (!informed) errors.push(`${where} conversation was never informed`);
      const reason = op.reason ?? null;
      const losers = [{ content: entry.content, time: entry.time, timeWindow: entry.timeWindow, user_ids: entry.user_ids }, ...entry.conflicts.filter((_, i) => i !== op.target)];
      for (const loser of losers) entry.history.push({ ...loser, reason });
      Object.assign(entry, { content: picked.content, time: picked.time, timeWindow: picked.timeWindow, user_ids: picked.user_ids, conflicts: [] });
    } else {
      errors.push(`${where} unknown op`);
    }
  }

  if (episodeTimeline) {
    const traces = new Map(ds.corpus.traces.map((trace) => [trace.id, trace]));
    const visible = orderedTraces(ds.corpus).flatMap((source) => (ds.labels.traces[source.id]?.ops ?? []).flatMap((op) => {
      const release = op.deferredUntil ? traces.get(op.deferredUntil) : source;
      const at = release && episodeTimeline.commitByTrace.get(release.id);
      return at && at <= until ? [{ op, source, release, at }] : [];
    }));
    visible.sort((left, right) => left.at.localeCompare(right.at) || traceOrderTime(left.release).localeCompare(traceOrderTime(right.release)));
    for (const { op, source, release } of visible) apply(op, source, release);
    return { state, errors, changes };
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
  return { state, errors, changes };
}

// flush derives the expected state under the v3 replay that flushes each question's Space before
// it searches and every Space before the final read. flush: false is the earlier derivation in
// which Episodes close and form only on their own timers.
export function buildGold(ds, { flush = FLUSH_BY_DEFAULT } = {}) {
  const { corpus, labels } = ds;
  const questions = { ...ds.questions, questions: effectiveQuestions(ds, { flush: flush && Boolean(ds.episodes) }) };
  const timelineErrors = ds.episodes ? validateEpisodeLabels(ds) : [];
  const timeline = ds.episodes && !timelineErrors.length ? buildEpisodeTimeline(ds, { flush }) : null;
  const { state, errors } = replay(ds, "9999", { timeline, traceMode: !timeline });
  errors.push(...timelineErrors);
  const sourceReplay = replay(ds, "9999", { traceMode: true });
  const allSourceOperations = timeline ? sourceReplay.state : null;
  for (const [trace, label] of Object.entries(labels.traces)) {
    for (const op of label.ops ?? []) {
      const decision = labels.entries[op.entry]?.changeOf;
      if (decision && !sourceReplay.changes.has(`${trace}:${decision}`)) errors.push(`${trace}:${op.entry} records a change but the member did not replace their own position on ${decision}`);
    }
  }
  const pendingEntries = [];
  const topics = new Map(labels.topics.map((topic) => [topic.id, topic]));
  const traces = new Map(corpus.traces.map((trace) => [trace.id, trace]));
  const conversations = new Map(corpus.conversations.map((c) => [c.id, c]));
  const entries = Object.entries(labels.entries).map(([id, meta]) => {
    const final = state.get(id);
    if (!final) {
      if (allSourceOperations?.has(id)) pendingEntries.push({ id, topic: meta.topic });
      else errors.push(`${id} is labelled but never written`);
      return null;
    }
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
      ...(meta.changeOf ? { changeOf: meta.changeOf, conflictCase: true } : {}),
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

  const goldTopics = labels.topics.flatMap((topic) => {
    const added = entries.filter((entry) => entry.topic === topic.id).map((entry) => entry.id);
    if (timeline && !added.length) return [];
    const result = { ...topic, entries: added };
    if (timeline) {
      for (const field of ["summaryKeyPoints", "descriptionKeyPoints"]) {
        result[field] = topic[field].filter((point) => timeline.commitByTrace.has(point.since)).map(({ until, ...point }) =>
          until && timeline.commitByTrace.has(until) ? { ...point, until } : point);
      }
    }
    return [result];
  });

  const isolationKind = corpus.datasetVersion === 3 ? "space-isolation" : "cross-project";
  const goldQuestions = questions.questions.map((question) => {
    const { state: snap } = replay(ds, question.askedAt, { timeline, traceMode: !timeline });
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
    if (question.pending && timeline) {
      const { entry: id, phase, fact } = question.pending;
      const draftTrace = corpus.traces.find((trace) => labels.traces[trace.id]?.ops.some((op) => op.op === "add" && op.entry === id));
      const draft = draftTrace && labels.traces[draftTrace.id].ops.find((op) => op.op === "add" && op.entry === id);
      const release = draft?.deferredUntil ? traces.get(draft.deferredUntil) : draftTrace;
      const batch = release && timeline.batchByTrace.get(release.id);
      const topic = topics.get(labels.entries[id]?.topic);
      const asked = question.askedAt;
      const open = batch && traceVisibleTime(release) <= asked && batch.closedAt > asked;
      const staged = batch?.stagedAt && batch.stagedAt <= asked && (!batch.committedAt || batch.committedAt > asked);
      if (!topic || topic.space_id !== question.space_id || (phase === "open" ? !open : phase === "staged" ? !staged : true) || snap.has(id)) {
        errors.push(`${question.id} does not ask while ${id} is ${phase} in the same Space`);
      } else {
        if (fact !== undefined && (typeof fact !== "string" || !fact.trim())) errors.push(`${question.id} needs non-empty metadata evidence`);
        trapItems.push({ entry: id, kind: "premature", text: draft.content, topic: topic.id, topicName: topic.topic_name, ...(fact ? { fact } : {}) });
      }
    }
    for (const trap of question.traps) {
      const entry = snap.get(trap.entry);
      if (!entry) { errors.push(`${question.id} trap ${trap.entry} does not exist at askedAt`); continue; }
      if (trap.kind === "stale") {
        const item = entry.history[trap.history];
        if (!item) errors.push(`${question.id} stale trap ${trap.entry} history[${trap.history}] missing at askedAt`);
        else trapItems.push({ entry: trap.entry, kind: "stale", text: item.content });
      } else if (trap.kind === isolationKind) {
        const texts = [entry.content, ...entry.conflicts.map((c) => c.content), ...entry.history.map((h) => h.content)];
        trapItems.push({ entry: trap.entry, kind: isolationKind, texts });
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
      ...(question.pending ? { pending: question.pending } : {}),
      expectedTopics: question.expect.topics,
      expectedItems,
      trapItems
    };
  });

  return {
    gold: {
      datasetVersion: corpus.datasetVersion,
      // Revision 2: gold under the flushing replay, with the v3 own-change conflict policy.
      ...(timeline ? { goldRevision: 2, processing: timeline.flush ? "flush" : "natural" } : {}),
      derivedFrom: ["dataset/corpus.json", "dataset/labels.json", "dataset/questions.json", ...(timeline ? ["dataset/episodes.json"] : [])],
      spaces: corpus.spaces,
      members: corpus.members,
      topics: goldTopics,
      entries,
      negatives,
      traceLabels,
      questions: goldQuestions,
      ...(timeline ? { episodeLabels: ds.episodes.episodes, topicRevisions: ds.episodes.topicRevisions, pendingEntries, processingBatches: timeline.batches, visibilityEvents: timeline.events } : {}),
      apiChecks: questions.apiChecks
    },
    errors
  };
}

export function renderGold(gold) {
  return `${JSON.stringify(gold, null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // --natural prints the timer-only derivation instead of writing dataset/gold.json.
  const natural = process.argv.includes("--natural");
  const { gold, errors } = buildGold(loadDataset(), { flush: !natural });
  if (errors.length) {
    console.error(JSON.stringify({ errors }, null, 2));
    process.exit(1);
  }
  if (natural) {
    process.stdout.write(renderGold(gold));
    process.exit(0);
  }
  writeFileSync(GOLD_PATH, renderGold(gold));
  const count = (kind, optional) => gold.entries.filter((e) => e.kind === kind && e.optional === optional).length;
  console.log(JSON.stringify({
    output: "dataset/gold.json",
    processing: gold.processing,
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

// Offline reference clock over human-labelled Episodes. This module is used only by evaluation.
const MINUTE = 60_000;
const PROCESS_MS = 1_000;
const IDLE_MS = 15 * MINUTE;
const MAX_WAIT_MS = 30 * MINUTE;
const FORMATION_MS = 120 * MINUTE;
const MAX_TURNS = 8;
const FORMATION_COUNT = 10;
const FORMATION_LIMIT = 50;

// Whether gold is derived under the flushing replay (see buildEpisodeTimeline).
export const FLUSH_BY_DEFAULT = true;

export const acceptedTime = (trace) => trace.submit_time ?? trace.reply_time;
const timestamp = (at) => `${new Date(at + 8 * 60 * MINUTE).toISOString().slice(0, 19)}+08:00`;

export function validateEpisodeLabels(ds) {
  const errors = [];
  const original = ds.corpus.traces.filter((trace) => !trace.resubmitOf);
  const traces = new Map(original.map((trace) => [trace.id, trace]));
  const conversations = new Map(ds.corpus.conversations.map((conversation) => [conversation.id, conversation]));
  const topics = new Map(ds.labels.topics.map((topic) => [topic.id, topic]));
  const positions = new Map();
  for (const trace of original) {
    const ids = positions.get(trace.conversation) ?? [];
    ids.push(trace.id);
    positions.set(trace.conversation, ids);
  }
  const owners = new Map();
  const seen = new Map();
  for (const episode of ds.episodes.episodes) {
    if (!episode.id || seen.has(episode.id)) errors.push(`duplicate or empty episode ${episode.id}`);
    seen.set(episode.id, episode);
    const first = traces.get(episode.traces?.[0]);
    if (!first) { errors.push(`${episode.id} needs a first original turn`); continue; }
    const ids = positions.get(first.conversation);
    const offset = ids.indexOf(first.id);
    const topic = topics.get(episode.topic);
    if (episode.topic !== null && (!topic || topic.space_id !== conversations.get(first.conversation)?.space_id || topic.domain !== first.domain)) {
      errors.push(`${episode.id} topic must be in the conversation's Space and domain`);
    }
    if (!episode.goal?.trim() || !episode.quote?.trim() || !first.query.includes(episode.quote)) errors.push(`${episode.id} needs a goal and a verbatim first-turn quote`);
    for (const [index, id] of episode.traces.entries()) {
      const trace = traces.get(id);
      if (!trace) { errors.push(`${episode.id} includes unknown or retransmitted turn ${id}`); continue; }
      if (owners.has(id)) errors.push(`${id} belongs to multiple episodes`);
      owners.set(id, episode.id);
      if (trace.conversation !== first.conversation) errors.push(`${episode.id} crosses conversation at ${id}`);
      if (trace.domain !== first.domain) errors.push(`${episode.id} crosses domain at ${id}`);
      if (ids[offset + index] !== id) errors.push(`${episode.id} is not contiguous at ${id}`);
      for (const op of ds.labels.traces[id]?.ops ?? []) {
        if (ds.labels.entries[op.entry]?.topic !== episode.topic) errors.push(`${episode.id} ${id} writes ${op.entry} outside its labelled Topic`);
      }
    }
  }
  for (const trace of original) if (!owners.has(trace.id)) errors.push(`missing episode for ${trace.id}`);
  for (const episode of seen.values()) {
    if (!episode.continues) continue;
    const prior = seen.get(episode.continues);
    const before = traces.get(prior?.traces.at(-1));
    const after = traces.get(episode.traces[0]);
    if (!before || !after || before.conversation !== after.conversation || before.chat_time >= after.chat_time || !episode.topic || episode.topic !== prior.topic) {
      errors.push(`${episode.id} must resume earlier work in the same conversation and Topic`);
    }
  }
  return errors;
}

function closeBatches(ds, events, points) {
  const homes = new Map(ds.corpus.conversations.map((conversation) => [conversation.id, conversation.space_id]));
  const semantic = new Map(ds.episodes.episodes.flatMap((episode) => episode.traces.map((id) => [id, episode])));
  const open = new Map();
  const previous = new Map();
  const batches = [];
  const acceptOrder = ds.corpus.traces.map((trace, index) => ({ trace, index, at: Date.parse(acceptedTime(trace)) }));
  acceptOrder.sort((left, right) => left.at - right.at || left.index - right.index);

  function close(conversation, batch, at, closeReason) {
    open.delete(conversation);
    previous.set(conversation, batch.id);
    const { first, latest, ...finished } = batch;
    const closedAt = timestamp(at);
    batches.push({ ...finished, acceptedAt: timestamp(first), closedAt, closeReason });
    events.push({ kind: "close", at: closedAt, batch: batch.id, reason: closeReason });
  }

  function expire(now) {
    for (const [conversation, batch] of open) {
      const idle = batch.latest + IDLE_MS;
      const maxWait = batch.first + MAX_WAIT_MS;
      const due = Math.min(idle, maxWait);
      if (due <= now) close(conversation, batch, due, idle <= maxWait ? "idle" : "max_wait");
    }
  }

  // A flush closes every open Episode of its Space at the flush time. Adds accepted at the same
  // instant come first: the replay submits them before it asks the question.
  let next = 0;
  function flushBefore(limit) {
    while (next < points.length && points[next].at < limit) {
      const point = points[next++];
      expire(point.at);
      for (const [conversation, batch] of open) {
        if (point.space === null || batch.space === point.space) close(conversation, batch, point.at, "flush");
      }
    }
  }

  for (const { trace, at } of acceptOrder) {
    flushBefore(at);
    expire(at);
    if (trace.resubmitOf) {
      events.push({ kind: "resubmit", at: timestamp(at), trace: trace.id, original: trace.resubmitOf });
      continue;
    }
    const episode = semantic.get(trace.id);
    let batch = open.get(trace.conversation);
    if (batch && batch.episode !== episode.id) {
      close(trace.conversation, batch, at, "task_boundary");
      batch = undefined;
    }
    if (!batch) {
      batch = {
        id: `batch_${trace.id}`, episode: episode.id, conversation: trace.conversation,
        space: homes.get(trace.conversation), topic: episode.topic, previous: previous.get(trace.conversation) ?? null,
        first: at, latest: at, traces: []
      };
      open.set(trace.conversation, batch);
    }
    batch.latest = at;
    batch.traces.push(trace.id);
    events.push({ kind: "accept", at: timestamp(at), trace: trace.id, batch: batch.id });
    if (batch.traces.length >= MAX_TURNS) close(trace.conversation, batch, at, "turn_count");
  }
  flushBefore(Infinity);
  expire(Infinity);
  return batches.sort((left, right) => left.closedAt.localeCompare(right.closedAt) || left.id.localeCompare(right.id));
}

// Questions with per-mode wording. Under flush, `underFlush` replaces the listed fields; a null
// value removes the field (for example `pending`, which flush makes visible).
export function effectiveQuestions(ds, { flush = FLUSH_BY_DEFAULT } = {}) {
  return (ds.questions?.questions ?? []).map(({ underFlush, ...question }) => {
    if (!flush || !underFlush) return question;
    const merged = { ...question, ...underFlush };
    for (const [key, value] of Object.entries(merged)) if (value === null) delete merged[key];
    return merged;
  });
}

// The replay flushes a question's Space right before it searches, so every earlier Add of that
// Space is closed, organized, and formed. The final read flushes every Space.
export function flushPoints(ds, { flush = FLUSH_BY_DEFAULT } = {}) {
  if (!flush) return [];
  return effectiveQuestions(ds, { flush }).filter((question) => !question.excluded)
    .map((question) => ({ at: Date.parse(question.askedAt), space: question.space_id, question: question.id }))
    .sort((left, right) => left.at - right.at);
}

// flush: true models the replay that flushes before each question and before the final read;
// false is the earlier derivation where Episodes close and form only on their own timers.
export function buildEpisodeTimeline(ds, { flush = FLUSH_BY_DEFAULT } = {}) {
  const events = [];
  const points = flushPoints(ds, { flush });
  const batches = closeBatches(ds, events, points);
  const batchByTrace = new Map(batches.flatMap((batch) => batch.traces.map((id) => [id, batch])));
  const commitByTrace = new Map();
  const stagedBySpace = new Map();
  const committedTopics = new Set();
  const draftsByTrace = new Map();
  for (const [trace, label] of Object.entries(ds.labels.traces)) {
    for (const op of label.ops) {
      const release = op.deferredUntil ?? trace;
      const drafts = draftsByTrace.get(release) ?? [];
      drafts.push({ trace, entry: ds.labels.entries[op.entry], op });
      draftsByTrace.set(release, drafts);
    }
  }
  const drafts = (batch) => batch.traces.flatMap((id) => draftsByTrace.get(id) ?? []);

  function commit(batch, at, formation) {
    batch.committedAt = at;
    committedTopics.add(batch.topic);
    for (const id of batch.traces) commitByTrace.set(id, at);
    events.push({ kind: "commit", at, batch: batch.id, topic: batch.topic, ...(formation ? { formation } : {}) });
  }

  function form(pool, now, trigger) {
    const at = timestamp(now);
    const groups = new Map();
    for (const staged of pool.batches.slice(-FORMATION_LIMIT)) {
      const group = groups.get(staged.topic) ?? [];
      group.push(staged);
      groups.set(staged.topic, group);
    }
    const forming = [...groups.values()].filter((group) => {
      const proposals = group.flatMap(drafts);
      // The semantic Topic labels encode distinct deliverables and domain. The remaining gates
      // require durable content and either multiple source Turns or a member's decision.
      const turnIds = new Set(group.flatMap((item) => item.traces).concat(proposals.map((item) => item.trace)));
      const hasDurableContent = proposals.some(({ entry }) => entry.kind !== "timeline") || proposals.length >= 2;
      const hasMemberDecision = proposals.some(({ entry, op }) => entry.kind === "decision" && op.op === "add");
      return hasDurableContent && (turnIds.size >= 2 || hasMemberDecision);
    });
    const moved = new Set(forming.flatMap((group) => group.map((item) => item.id)));
    events.push({ kind: "formation", at, trigger, topics: forming.map((group) => group[0].topic), batches: [...moved] });
    for (const group of forming) for (const staged of group) commit(staged, at, trigger);
    pool.additions = 0;
    pool.since = now;
    pool.batches = pool.batches.filter((item) => !moved.has(item.id));
  }

  function process(batch, now) {
    const at = timestamp(now);
    if (!batch.topic || !drafts(batch).length) {
      events.push({ kind: "skip", at, batch: batch.id });
      return;
    }
    if (committedTopics.has(batch.topic)) {
      commit(batch, at);
      return;
    }
    batch.stagedAt = at;
    const pool = stagedBySpace.get(batch.space) ?? { since: now, additions: 0, batches: [] };
    pool.additions += 1;
    pool.batches.push(batch);
    stagedBySpace.set(batch.space, pool);
    events.push({ kind: "stage", at, batch: batch.id });
    if (pool.additions >= FORMATION_COUNT || now - pool.since >= FORMATION_MS) form(pool, now, batch.id);
  }

  // A closed Episode is organized PROCESS_MS later. A flush waits for Episodes already closed in
  // its Space, so those finish no later than the flush, then a forced Formation runs.
  const work = batches.map((batch) => {
    const closed = Date.parse(batch.closedAt);
    let at = closed + (batch.closeReason === "flush" ? 0 : PROCESS_MS);
    const point = points.find((item) => (item.space === null || item.space === batch.space) && item.at >= closed && item.at < at);
    if (point) at = point.at;
    return { at, order: 0, batch };
  });
  work.push(...points.map((point) => ({ at: point.at, order: 1, point })));
  if (flush) {
    const last = Math.max(...work.map((item) => item.at), ...ds.corpus.traces.map((trace) => Date.parse(acceptedTime(trace))));
    if (Number.isFinite(last)) {
      work.push({ at: last, order: 1, point: { at: last, space: null, question: null } });
    }
  }
  work.sort((left, right) => left.at - right.at || left.order - right.order);
  for (const item of work) {
    if (item.batch) { process(item.batch, item.at); continue; }
    const trigger = `flush:${item.point.question ?? "final"}`;
    events.push({ kind: "flush", at: timestamp(item.at), space: item.point.space, ...(item.point.question ? { question: item.point.question } : { final: true }) });
    for (const [space, pool] of stagedBySpace) {
      if ((item.point.space === null || item.point.space === space) && pool.batches.length) form(pool, item.at, trigger);
    }
  }
  const staged = [...stagedBySpace.values()].flatMap((pool) => pool.batches.map((batch) => batch.id));
  events.sort((left, right) => left.at.localeCompare(right.at));
  return { events, batches, batchByTrace, commitByTrace, flush, staged };
}

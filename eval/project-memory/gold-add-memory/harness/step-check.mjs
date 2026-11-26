// Online checker for the step-by-step v3 review (run-memos-v3-live.mjs --pause-on-bad).
// After each replayed event it compares MemOS with the gold as of that time and returns "pause"
// when a new problem shows up:
// - An Add is checked once both sides finished it: gold has committed the Trace's batch and every
//   MemOS Episode carrying the Trace's Task is done (or the Trace's Space was just flushed for a
//   question). Then each gold op of the Trace must be visible: the entry exists (missing), once
//   (duplicate_entry), in the Topic that holds its gold Topic (wrong_topic), with the gold number
//   of conflicts and history versions (conflict_state, history_state), and not still staged after
//   a flush (not_formed).
// - Every new or changed MemOS entry is attributed against the Space's gold (judge.attribute, as
//   scoreRun does): stale_as_current, conflict_as_entry, negative_write and unattributed writes.
// - A gold Topic spread over several MemOS Topics is topic_split (a wrongly created Topic); several
//   gold Topics in one MemOS Topic is topic_merge, which is only noted (sibling merges are fair).
// - A question is judged with judge.answer; a wrong answer pauses with where its facts were lost.
// Problems already reported are not reported again; known.json ({"skipTypes": [], "skipKeys": []})
// turns confirmed root causes into notes so the same cause does not pause the review again.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { replay } from "../build-gold-baseline.mjs";
import { buildEpisodeTimeline } from "../episode-timeline.mjs";
import { createJudge } from "../judge.mjs";
import { createLlm, resolveModelConfig } from "../llm.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIELDS = [["decisions", "decision"], ["experiences", "experience"], ["timeline", "timeline"]];
const NOTE_TYPES = new Set(["topic_merge", "kind_mismatch", "early_write", "timeline_split", "restates_conflict"]);
const norm = (text) => String(text ?? "").replace(/\s+/g, "").trim();
const short = (text, n = 80) => { const s = String(text ?? ""); return s.length > n ? `${s.slice(0, n)}…` : s; };

// Reads add_jobs through harness/inspect-memos.py; tests inject their own reader.
export function pythonJobsReader(schema, python = process.env.MEMMY_EVAL_STEP_PYTHON ?? "/Users/junfengran/repos/MemOS/.venv/bin/python") {
  return () => JSON.parse(execFileSync(python, [join(here, "inspect-memos.py"), "--schema", schema, "--json", "jobs"], { encoding: "utf8", maxBuffer: 64 << 20 }));
}

function defaultJudge(outDir) {
  const config = resolveModelConfig("MEMMY_EVAL_JUDGE");
  const llm = createLlm({ config, cachePath: join(outDir, "step-judge-cache.json") });
  return { judge: createJudge(llm), save: () => llm.save() };
}

// Flatten get_memory Topics into entries; uid is stable across edits so a rewrite reads as a change.
export function flattenSpace(space, topics) {
  const items = [];
  for (const topic of topics ?? []) {
    for (const [field, kind] of FIELDS) {
      for (const [i, raw] of (topic[field] ?? []).entries()) {
        items.push({ uid: `${space}#${topic.id}#${kind}#${raw.id ?? i}`, space, topicId: topic.id, topicName: topic.topic_name, kind, content: raw.content, raw });
      }
    }
  }
  return items;
}

export function createStepChecker({ ds, gold, outDir, knownPath, judge, saveJudge, readJobs, now = () => new Date().toISOString() }) {
  if (!judge) ({ judge, save: saveJudge } = defaultJudge(outDir));
  readJobs ??= process.env.MEMMY_EVAL_STEP_SCHEMA ? pythonJobsReader(process.env.MEMMY_EVAL_STEP_SCHEMA) : null;
  const known = knownPath && existsSync(knownPath) ? JSON.parse(readFileSync(knownPath, "utf8")) : {};
  const skipTypes = new Set(known.skipTypes ?? []);
  const skipKeys = new Set(known.skipKeys ?? []);
  const timeline = buildEpisodeTimeline(ds, { flush: gold.processing !== "natural" });
  const traces = new Map(ds.corpus.traces.map((t) => [t.id, t]));
  const conversations = new Map(ds.corpus.conversations.map((c) => [c.id, c]));
  const spaceOfTrace = (id) => conversations.get(traces.get(id)?.conversation)?.space_id;
  const labels = new Map(gold.traceLabels.map((label) => [label.trace, label]));
  const goldById = new Map(gold.entries.map((e) => [e.id, e]));
  const entryMeta = ds.labels.entries;
  const goldList = {};
  for (const e of gold.entries) {
    const conflictTexts = [...e.conflicts ?? [], ...(e.alternatives ?? []).flatMap((alt) => alt.conflicts ?? [])].map((c) => c.content);
    (goldList[e.space_id] ??= []).push({ id: e.id, kind: e.kind, text: e.content, staleTexts: e.staleVersions, conflictTexts });
  }
  const negatives = {};
  for (const n of gold.negatives) (negatives[n.space_id] ??= []).push({ id: n.id, text: n.text });
  const questions = new Map(gold.questions.map((q) => [q.id, q]));
  const pausesDir = join(outDir, "pauses");

  const attribute = async (item, cache) => {
    const key = `${item.space}\0${item.kind}\0${norm(item.content)}`;
    if (!cache[key]) cache[key] = await judge.attribute(item, goldList[item.space] ?? [], negatives[item.space] ?? []);
    return cache[key];
  };

  // The final-gold attribution names the entry; whether the text is that entry's current version,
  // a conflict or a superseded version is decided against the entry as of the event (an early
  // version is current until gold rewrites it). Exact text settles it, otherwise one more judge call
  // against that single entry's state.
  const asOf = async (item, goldNow, cache) => {
    const { label, ids } = item.attr;
    if (!["match", "stale", "conflict"].includes(label) || !ids.length) return item.attr;
    // Check the version against a visible entry of the item's own kind first (a timeline that also
    // restates its decision names both); the other visible ids stay attributed.
    const visible = ids.filter((id) => goldNow.has(id))
      .sort((a, b) => Number(goldById.get(b)?.kind === item.kind) - Number(goldById.get(a)?.kind === item.kind));
    const entry = visible[0];
    if (!entry) return { ...item.attr, label: "early" };
    const current = goldNow.get(entry);
    const single = [{ id: entry, kind: goldById.get(entry)?.kind, text: current.content,
      staleTexts: [...current.history.map((h) => h.content), ...current.superseded ?? []], conflictTexts: current.conflicts.map((c) => c.content) }];
    const key = `${item.space}\0${item.kind}\0${norm(item.content)}\0${JSON.stringify(single)}`;
    if (!cache[key]) {
      const verdict = await judge.attribute(item, single, []);
      // No version of the entry as of now: a final-gold match is a version gold has not committed
      // yet (early); a final stale or conflict text keeps its final label.
      cache[key] = verdict.label !== "none" ? verdict
        : { ...item.attr, label: label === "match" ? "early" : label, source: `${verdict.source}:final` };
    }
    let verdict = cache[key];
    // The write is the entry's final current version but gold has not committed it yet (MemOS ran
    // ahead of gold's timers): an early write, not a stale or conflicting one.
    if (label === "match" && ["stale", "conflict"].includes(verdict.label)) verdict = { ...verdict, label: "early", ids: [entry] };
    return { ...verdict, ids: verdict.label === "match" ? [...new Set([...verdict.ids, ...visible])] : verdict.ids, final: item.attr };
  };

  // MemOS Topic -> gold Topics by attributed entries, and the reverse.
  function topicMaps(items) {
    const toGold = new Map();
    const toMemos = new Map();
    for (const item of items) {
      if (item.attr.label !== "match") continue;
      const goldTopic = entryMeta[item.attr.ids[0]]?.topic;
      if (!goldTopic) continue;
      const counts = toGold.get(item.topicId) ?? new Map();
      counts.set(goldTopic, (counts.get(goldTopic) ?? 0) + 1);
      toGold.set(item.topicId, counts);
      (toMemos.get(goldTopic) ?? toMemos.set(goldTopic, new Set()).get(goldTopic)).add(item.topicId);
    }
    const majority = (topicId) => [...(toGold.get(topicId) ?? new Map()).entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { toGold, toMemos, majority };
  }

  function taskIndex(run, jobs) {
    const traceOfTask = new Map();
    for (const task of run.tasks) if (task.task_id) (traceOfTask.get(task.task_id) ?? traceOfTask.set(task.task_id, []).get(task.task_id)).push(task.trace);
    const jobsOfTrace = new Map();
    for (const job of jobs ?? []) {
      for (const taskId of job.task_ids ?? []) {
        for (const trace of traceOfTask.get(taskId) ?? []) (jobsOfTrace.get(trace) ?? jobsOfTrace.set(trace, []).get(trace)).push(job);
      }
    }
    return jobsOfTrace;
  }

  const brief = (job) => ({
    episode: job.episode_id, conversation: job.conversation_key, seq: [job.message_seq_start, job.message_seq_end],
    stage: job.stage, outcome: job.outcome, topics: job.topic_ids, drafts: job.drafts, previous: job.previous_episode_id,
    boundary: job.boundary, warnings: job.warnings, error: job.error ?? job.last_error ?? null
  });

  async function check(run, index, { event, readSpace }) {
    const state = (run.stepCheck ??= { checkedTraces: [], reported: {}, seen: {}, attr: {}, pauses: 0 });
    const at = event.at;
    const spaceIds = ds.corpus.spaces.map((s) => s.space_id);
    const items = [];
    const memosTopics = {};
    for (const space of spaceIds) {
      const topics = await readSpace(space, "check");
      memosTopics[space] = topics;
      items.push(...flattenSpace(space, topics));
    }
    const goldNow = replay(ds, at, { timeline }).state;
    for (const item of items) {
      item.attr = await attribute(item, state.attr);
      item.attr = await asOf(item, goldNow, (state.asOf ??= {}));
    }
    const { toGold, toMemos, majority } = topicMaps(items);
    const jobs = readJobs ? readJobs() : null;
    const jobsOfTrace = taskIndex(run, jobs);
    const question = event.question ? run.questions.at(-1) : null;
    const flushedSpace = question?.flush?.settled ? event.question.space_id : null;
    const issues = [];
    const add = (issue) => issues.push({ ...issue, key: issue.key ?? `${issue.type}:${issue.trace ?? ""}:${issue.entry ?? issue.topic ?? issue.uid ?? ""}` });

    // 1. Adds that both sides finished.
    const checked = new Set(state.checkedTraces);
    for (const task of run.tasks) {
      const trace = task.trace;
      if (checked.has(trace)) continue;
      const committedAt = timeline.commitByTrace.get(trace);
      const label = labels.get(trace);
      const goldDone = !label?.ops?.length || (committedAt && committedAt <= at);
      const memosJobs = jobsOfTrace.get(trace) ?? [];
      const flushed = flushedSpace && spaceOfTrace(trace) === flushedSpace;
      const memosDone = jobs ? memosJobs.length > 0 && memosJobs.every((job) => job.stage === "done" && job.outcome !== "staged") : task.status === "completed";
      if (!goldDone || !(memosDone || flushed)) continue;
      checked.add(trace);
      const context = { trace, jobs: memosJobs.map(brief) };
      if (memosJobs.some((job) => job.outcome === "staged") && label?.ops?.length) {
        add({ type: "not_formed", trace, detail: "gold committed the Trace; MemOS still holds its Episode as staged after the flush", ...context });
      }
      if (memosJobs.some((job) => job.outcome === "failed")) add({ type: "task_failed", trace, ...context });
      for (const op of label?.ops ?? []) {
        const [opName, entry] = op.split(":");
        const expected = goldNow.get(entry);
        if (!expected || entryMeta[entry]?.optional) continue;
        const kind = entryMeta[entry]?.kind;
        const space = spaceOfTrace(trace);
        const hits = items.filter((item) => item.space === space && item.attr.label === "match" && item.attr.ids.includes(entry));
        const expectedTopic = entryMeta[entry]?.topic;
        const base = { trace, op: opName, entry, kind, expected: expected.content, expectedTopic, ...context };
        if (!hits.length) { add({ type: "missing", ...base }); continue; }
        const sameKind = hits.filter((item) => item.kind === kind);
        // One gold timeline entry may be reported as one entry per fact: a note, not a duplicate.
        if (sameKind.length > 1) add({ type: kind === "timeline" ? "timeline_split" : "duplicate_entry", ...base, actual: sameKind.map((item) => ({ topic: item.topicName, content: item.content })) });
        const hit = sameKind[0] ?? hits[0];
        if (hit.kind !== kind) add({ type: "kind_mismatch", ...base, actualKind: hit.kind, actual: hit.content });
        const hostGold = majority(hit.topicId);
        const merged = toGold.get(hit.topicId)?.has(expectedTopic) && [...(toGold.get(hit.topicId)?.keys() ?? [])].every((g) => toMemos.get(g)?.size === 1);
        if (hostGold !== expectedTopic && !merged) {
          add({ type: "wrong_topic", ...base, actualTopic: hit.topicName, actualTopicGold: hostGold, actual: hit.content });
        }
        if (kind === "decision" && hit.kind === "decision") {
          const conflicts = hit.raw.conflicts ?? [];
          const history = hit.raw.history ?? [];
          if (conflicts.length !== expected.conflicts.length) {
            add({ type: "conflict_state", ...base, expectedConflicts: expected.conflicts.map((c) => c.content), actualConflicts: conflicts.map((c) => c.content), actual: hit.content });
          }
          if (history.length !== expected.history.length) {
            add({ type: "history_state", ...base, expectedHistory: expected.history.map((h) => h.content), actualHistory: history.map((h) => h.content), actual: hit.content });
          }
        }
      }
    }
    state.checkedTraces = [...checked];

    // 2. New or changed writes that no current gold entry explains.
    for (const item of items) {
      const signature = norm(`${item.content}|${(item.raw.conflicts ?? []).length}|${(item.raw.history ?? []).length}`);
      if (state.seen[item.uid] === signature) continue;
      state.seen[item.uid] = signature;
      const { label, ids } = item.attr;
      const where = { uid: item.uid, space: item.space, topic: item.topicName, kind: item.kind, actual: item.content, ids, reason: item.attr.reason };
      if (label === "stale") add({ type: "stale_as_current", ...where, key: `stale_as_current:${norm(item.content)}` });
      else if (label === "conflict") add({ type: item.kind === "decision" ? "conflict_as_entry" : "restates_conflict", ...where, key: `conflict_as_entry:${norm(item.content)}` });
      else if (label === "negative") add({ type: "negative_write", ...where, key: `negative_write:${norm(item.content)}` });
      else if (label === "none") add({ type: "unattributed", ...where, key: `unattributed:${norm(item.content)}` });
      else if (label === "early") add({ type: "early_write", ...where, key: `early_write:${ids[0]}` });
    }

    // 3. Topic structure.
    for (const [goldTopic, memosIds] of toMemos) {
      if (memosIds.size < 2) continue;
      const names = [...memosIds].map((id) => items.find((item) => item.topicId === id)?.topicName);
      add({ type: "topic_split", topic: goldTopic, actualTopics: names, key: `topic_split:${goldTopic}:${[...memosIds].sort().join(",")}` });
    }
    for (const [topicId, counts] of toGold) {
      if (counts.size < 2) continue;
      add({ type: "topic_merge", topic: [...counts.keys()].sort().join("+"), actualTopic: items.find((item) => item.topicId === topicId)?.topicName, key: `topic_merge:${topicId}:${[...counts.keys()].sort().join(",")}` });
    }

    // 4. The answer.
    if (question) {
      const q = questions.get(question.id);
      const trapTexts = q.trapItems.filter((trap) => trap.kind !== "space-isolation").flatMap((trap) => trap.texts ?? [trap.text]);
      const verdict = await judge.answer(q, question.answer, trapTexts);
      question.stepVerdict = verdict;
      if (!verdict.correct) {
        const retrieved = (question.topic_detail_list ?? []).map((topic) => topic.id);
        // Search returns only the matched entries of each Topic, so a fact counts as retrieved when
        // its entry (or, for a conflict, its decision with conflicts) came back, not just its Topic.
        const returned = new Set((question.topic_detail_list ?? []).flatMap((topic) => FIELDS.flatMap(([field]) => (topic[field] ?? []).map((raw) => raw.id ?? norm(raw.content)))));
        const facts = q.expectedItems.map((expectedItem) => {
          const stored = items.filter((item) => item.space === q.space_id && item.attr.label === "match" && item.attr.ids.includes(expectedItem.entry) &&
            (expectedItem.part !== "conflicts" || (item.kind === "decision" && (item.raw.conflicts ?? []).length > 0)));
          return {
            entry: expectedItem.entry, part: expectedItem.part, text: expectedItem.text,
            stored: stored.map((item) => ({ topic: item.topicName, content: item.content, conflicts: (item.raw.conflicts ?? []).map((c) => c.content) })),
            retrieved: stored.some((item) => returned.has(item.raw.id ?? norm(item.content))),
            rank: stored.map((item) => retrieved.indexOf(item.topicId)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? null
          };
        });
        const layer = !facts.length ? "unknown"
          : facts.some((fact) => !fact.stored.length) ? "add"
            : facts.some((fact) => !fact.retrieved) ? "search" : "reader";
        add({
          type: "answer_wrong", key: `answer_wrong:${q.id}`, question: q.id, kind: q.kind, text: q.question, goldAnswer: q.goldAnswer,
          answer: question.answer, judge: verdict.reason, layer, facts, trapTexts,
          retrievedTopics: (question.topic_detail_list ?? []).map((topic) => topic.topic_name), flush: question.flush?.settled ?? null
        });
      }
    }

    // Report new problems; pause on any that is not a note or a known cause.
    const fresh = issues.filter((issue) => !state.reported[issue.key]);
    for (const issue of fresh) state.reported[issue.key] = { event: index, at };
    if (!fresh.length) return null;
    mkdirSync(pausesDir, { recursive: true });
    const blocking = fresh.filter((issue) => !NOTE_TYPES.has(issue.type) && !skipTypes.has(issue.type) && !skipKeys.has(issue.key));
    const record = { event_index: index, id: event.trace?.id ?? event.question.id, at, checkedAt: now(), blocking: blocking.length, issues: fresh };
    appendFileSync(join(outDir, "step-issues.jsonl"), `${JSON.stringify(record)}\n`);
    if (!blocking.length) return null;
    state.pauses += 1;
    const subject = event.trace
      ? { trace: event.trace.id, conversation: event.trace.conversation, query: event.trace.query, answer: event.trace.answer, label: labels.get(event.trace.id) ?? null }
      : { question: event.question.id, text: event.question.question };
    const file = join(pausesDir, `${String(state.pauses).padStart(3, "0")}-${record.id}.json`);
    writeFileSync(file, `${JSON.stringify({ ...record, subject, topics: Object.fromEntries(Object.entries(memosTopics).map(([space, topics]) => [space, topics.map((t) => t.topic_name)])) }, null, 2)}\n`);
    console.log(`\n== pause ${state.pauses} after event ${index} ${record.id} @ ${at} -> ${file}`);
    for (const issue of blocking) console.log(`  [${issue.type}] ${issue.trace ?? issue.question ?? issue.topic ?? ""} ${issue.entry ?? ""} ${short(issue.expected ?? issue.actual ?? issue.goldAnswer ?? "")}`);
    return "pause";
  }

  return { check, save: () => saveJudge?.() };
}

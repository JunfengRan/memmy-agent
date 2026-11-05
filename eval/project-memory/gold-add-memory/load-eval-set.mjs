#!/usr/bin/env node
// Validates dataset v2 against the v3 rules it encodes and checks that dataset/gold.json is the
// exact output of build-gold-baseline.mjs. Exit 0 only when there are no errors.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildGold, GOLD_PATH, loadDataset, orderedTraces, renderGold, replay } from "./build-gold-baseline.mjs";

export const LIMITS = { topic_name: 20, topic_summary: 80, topic_description: 400, decision: 100, timeline: 100, experience: 200 };
export const length = (text) => [...String(text ?? "")].length;

const KINDS = new Set(["decision", "experience", "timeline"]);
const CATEGORIES = new Set(["范围", "对外约定", "共同约定"]);
const QUESTION_KINDS = new Set(["plain", "stale", "conflict", "cross-project"]);
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
const ALPHA_FIELDS = ["memoryScope", "level", "supersedes", "needsTodolist", "mergedFrom", "workspacePath", "gitRoot", "projectId", "sessionId", "canSee"];
const LABELED = /决策|主张|\bD\d|\bT\d/;

export function loadGold() {
  return JSON.parse(readFileSync(GOLD_PATH, "utf8"));
}

export function validateDataset(ds) {
  const errors = [];
  const err = (message) => errors.push(message);
  const { corpus, labels, conflicts, questions } = ds;
  for (const [name, file] of Object.entries(ds)) if (file.datasetVersion !== 2) err(`${name}.json datasetVersion must be 2`);

  // Spaces, members, conversations.
  const spaces = new Map(corpus.spaces.map((space) => [space.space_id, space]));
  if (spaces.size !== 2 || spaces.size !== corpus.spaces.length) err("need exactly two distinct spaces");
  for (const space of corpus.spaces) {
    const names = space.domains.map((d) => d.domain);
    if (!names.length || names.length > 20) err(`${space.space_id} must register 1–20 domains`);
    if (new Set(names).size !== names.length || names.some((n) => !String(n).trim())) err(`${space.space_id} domain names must be unique and non-empty`);
  }
  const members = new Map(corpus.members.map((m) => [m.user_id, m]));
  const conversations = new Map(corpus.conversations.map((c) => [c.id, c]));
  if (new Set(corpus.conversations.map((c) => c.conversation_id)).size !== corpus.conversations.length) err("conversation_id must be unique");
  for (const c of corpus.conversations) {
    if (!spaces.has(c.space_id)) err(`${c.id} space ${c.space_id} missing`);
    if (!members.has(c.user_id)) err(`${c.id} user ${c.user_id} missing`);
  }
  const ledgerAuthors = new Set(corpus.conversations.filter((c) => c.id === "ledger-build" || c.id === "ledger-follow").map((c) => c.user_id));
  if (ledgerAuthors.size !== 2) err("ledger-build and ledger-follow must be different members");

  // Traces.
  const traces = new Map();
  const lastTime = new Map();
  for (const trace of corpus.traces) {
    if (traces.has(trace.id)) err(`${trace.id} duplicated`);
    traces.set(trace.id, trace);
    for (const field of ALPHA_FIELDS) if (Object.hasOwn(trace, field)) err(`${trace.id} still has alpha field ${field}`);
    const c = conversations.get(trace.conversation);
    if (!c) { err(`${trace.id} conversation ${trace.conversation} missing`); continue; }
    if (c.askOnly) err(`${trace.id} is in ask-only conversation ${c.id}`);
    if (!spaces.get(c.space_id)?.domains.some((d) => d.domain === trace.domain)) err(`${trace.id} domain ${trace.domain} is not registered in ${c.space_id}`);
    if (!ISO_LOCAL.test(trace.chat_time) || !ISO_LOCAL.test(trace.reply_time)) err(`${trace.id} times must be ISO 8601 with +08:00`);
    if (trace.reply_time <= trace.chat_time) err(`${trace.id} reply must come after the user message`);
    if ((lastTime.get(c.id) ?? "") >= trace.chat_time) err(`${trace.id} is out of order in ${c.id}`);
    lastTime.set(c.id, trace.reply_time);
    if (LABELED.test(`${trace.query}${trace.answer}`)) err(`${trace.id} text carries a label word`);
    for (const note of trace.annotations ?? []) {
      if (!["approval", "informed", "resolve"].includes(note.type)) err(`${trace.id} unknown annotation ${note.type}`);
      if (!`${trace.query}\n${trace.answer}`.includes(note.quote ?? "\u0000")) err(`${trace.id} ${note.type} quote is not in the conversation`);
      for (const who of [note.by, note.pick].filter(Boolean)) if (!members.has(who)) err(`${trace.id} ${note.type} member ${who} missing`);
    }
    if (trace.searchBefore && !trace.searchBefore.query) err(`${trace.id} searchBefore needs a query`);
  }
  for (const c of corpus.conversations.filter((c) => c.askOnly)) {
    if (corpus.traces.some((t) => t.conversation === c.id)) err(`${c.id} must stay empty; it only asks`);
  }

  // Labels.
  const topics = new Map(labels.topics.map((t) => [t.id, t]));
  for (const topic of labels.topics) {
    const space = spaces.get(topic.space_id);
    if (!space) err(`${topic.id} space missing`);
    else if (!space.domains.some((d) => d.domain === topic.domain)) err(`${topic.id} domain ${topic.domain} not registered`);
    if (length(topic.topic_name) > LIMITS.topic_name) err(`${topic.id} topic_name over ${LIMITS.topic_name}`);
    if (length(topic.summaryKeyPoints.join("；")) > LIMITS.topic_summary) err(`${topic.id} summary key points over ${LIMITS.topic_summary}`);
    if (length(topic.descriptionKeyPoints.join("；")) > LIMITS.topic_description) err(`${topic.id} description key points over ${LIMITS.topic_description}`);
    if (!topic.summaryKeyPoints.length || !topic.descriptionKeyPoints.length) err(`${topic.id} needs summary and description key points`);
  }
  for (const [id, meta] of Object.entries(labels.entries)) {
    if (!KINDS.has(meta.kind)) err(`${id} kind ${meta.kind} invalid (timeline, not evolution)`);
    if (meta.kind === "decision" && !CATEGORIES.has(meta.category)) err(`${id} decision category must be 范围 / 对外约定 / 共同约定`);
    if (meta.kind !== "decision" && meta.category) err(`${id} only decisions carry a category`);
    if (!topics.has(meta.topic)) err(`${id} topic ${meta.topic} missing`);
    if (meta.optional && meta.kind === "decision") err(`${id} decisions cannot be optional`);
  }
  const dropReasons = new Set(Object.keys(labels.dropReasons));
  for (const id of Object.keys(labels.traces)) if (!traces.has(id)) err(`label for unknown trace ${id}`);
  for (const trace of corpus.traces) {
    const label = labels.traces[trace.id];
    if (!label) { err(`${trace.id} has no label`); continue; }
    const text = `${trace.query}\n${trace.answer}`;
    const space = conversations.get(trace.conversation)?.space_id;
    if (!label.ops.length && !(label.dropped ?? []).length) err(`${trace.id} writes nothing and gives no reason`);
    for (const drop of label.dropped ?? []) if (!dropReasons.has(drop.reason)) err(`${trace.id} drop reason ${drop.reason} invalid`);
    for (const op of label.ops) {
      const meta = labels.entries[op.entry];
      if (!meta) { err(`${trace.id} op on unknown entry ${op.entry}`); continue; }
      const topic = topics.get(meta.topic);
      if (topic && topic.space_id !== space) err(`${trace.id} writes ${op.entry} into another space`);
      if (topic && topic.domain !== trace.domain) err(`${trace.id} writes ${op.entry} into domain ${topic.domain}, but the caller asked for ${trace.domain}`);
      if (op.content !== undefined && length(op.content) > LIMITS[meta.kind]) err(`${trace.id} ${op.entry} content over ${LIMITS[meta.kind]} chars`);
      if (op.reason && !op.reasonQuote) err(`${trace.id} ${op.entry} reason needs a reasonQuote from the conversation`);
      if (op.reasonQuote && !text.includes(op.reasonQuote)) err(`${trace.id} ${op.entry} reasonQuote is not in the conversation`);
    }
  }

  // Conflict cases: the expected op follows from authorship and signals, and matches the label.
  const covered = new Set();
  for (const item of conflicts.cases) {
    const trace = traces.get(item.incoming);
    if (!trace) { err(`${item.id} incoming ${item.incoming} missing`); continue; }
    const before = replay(ds, trace.chat_time).state.get(item.decision);
    if (!before) { err(`${item.id} ${item.decision} does not exist before ${item.incoming}`); continue; }
    const author = conversations.get(trace.conversation)?.user_id;
    if (author !== item.author) err(`${item.id} author should be ${author}`);
    if (JSON.stringify([...before.user_ids].sort()) !== JSON.stringify([...item.contentAuthors].sort())) err(`${item.id} contentAuthors should be ${before.user_ids.join(",")}`);
    const notes = trace.annotations ?? [];
    const approval = notes.some((n) => n.type === "approval");
    if (approval !== item.approval) err(`${item.id} approval flag disagrees with the conversation`);
    let informed = false;
    if (item.informedBy) {
      const by = traces.get(item.informedBy);
      informed = Boolean(by?.searchBefore) && by.conversation === trace.conversation && (by.annotations ?? []).some((n) => n.type === "informed");
    }
    if (informed !== item.informed) err(`${item.id} informed flag needs a same-conversation trace with searchBefore and an informed signal`);
    const derived = informed && notes.some((n) => n.type === "resolve") ? "resolve"
      : before.user_ids.includes(author) || approval ? "rewrite"
      : before.conflicts.some((c) => c.user_ids.includes(author)) ? "conflict_update"
      : "conflict_append";
    if (derived !== item.expectedOp) err(`${item.id} expectedOp should be ${derived}`);
    const op = labels.traces[item.incoming]?.ops.find((o) => o.entry === item.decision);
    if (op?.op !== item.expectedOp) err(`${item.id} label op is ${op?.op}, case says ${item.expectedOp}`);
    covered.add(`${item.incoming}:${item.decision}`);
  }
  for (const [traceId, label] of Object.entries(labels.traces)) {
    for (const op of label.ops) {
      if (labels.entries[op.entry]?.kind === "decision" && op.op !== "add" && !covered.has(`${traceId}:${op.entry}`)) err(`${traceId}:${op.entry} ${op.op} has no conflicts.json case`);
    }
  }

  // Gold derivation.
  const { gold, errors: goldErrors } = buildGold(ds);
  errors.push(...goldErrors.map((e) => `gold: ${e}`));
  if (!existsSync(GOLD_PATH)) err("dataset/gold.json missing; run build-gold-baseline.mjs");
  else if (readFileSync(GOLD_PATH, "utf8") !== renderGold(gold)) err("dataset/gold.json is out of date; run build-gold-baseline.mjs");
  for (const entry of gold.entries) {
    if (length(entry.content) > LIMITS[entry.kind]) err(`${entry.id} final content over limit`);
    for (const item of [...(entry.conflicts ?? []), ...(entry.history ?? [])]) if (length(item.content) > LIMITS[entry.kind]) err(`${entry.id} item over limit`);
  }

  // Questions.
  const questionIds = new Set();
  const entrySpace = new Map(gold.entries.map((e) => [e.id, e.space_id]));
  const entryTopic = new Map(gold.entries.map((e) => [e.id, e.topic]));
  const replySentences = corpus.traces.flatMap((t) => t.answer.split(/[。！？]/).map((s) => s.trim()).filter((s) => length(s) >= 8));
  for (const question of questions.questions) {
    const where = question.id;
    if (questionIds.has(where)) err(`${where} duplicated`);
    questionIds.add(where);
    if (!QUESTION_KINDS.has(question.kind)) err(`${where} kind ${question.kind} invalid`);
    const asker = conversations.get(question.conversation);
    if (!asker?.askOnly || asker.space_id !== question.space_id) err(`${where} must be asked from an empty ask-only conversation of its space`);
    if (!ISO_LOCAL.test(question.askedAt)) err(`${where} askedAt must be ISO 8601 with +08:00`);
    if (question.excluded && !question.excludedReason) err(`${where} excluded needs a reason`);
    if (!question.mustInclude?.length) err(`${where} needs mustInclude`);
    for (const phrase of question.mustInclude ?? []) if (!question.goldAnswer.includes(phrase)) err(`${where} goldAnswer misses ${phrase}`);
    for (const sentence of replySentences) if (question.question.includes(sentence)) err(`${where} copies a reply`);
    if (question.expect.topics.length !== 1) err(`${where} should expect exactly one topic`);
    for (const topicId of question.expect.topics) if (topics.get(topicId)?.space_id !== question.space_id) err(`${where} expects ${topicId} from another space`);
    for (const want of question.expect.entries) {
      if (!question.expect.topics.includes(entryTopic.get(want.entry))) err(`${where} expects ${want.entry} outside the expected topics`);
    }
    const traps = question.traps ?? [];
    for (const trap of traps) {
      if (trap.kind === "cross-project" && entrySpace.get(trap.entry) === question.space_id) err(`${where} cross-project trap ${trap.entry} is in the same space`);
      if (trap.kind === "stale" && entrySpace.get(trap.entry) !== question.space_id) err(`${where} stale trap ${trap.entry} must be in the same space`);
    }
    if (question.kind === "plain" && traps.length) err(`${where} plain questions carry no trap`);
    if (question.kind === "stale" && !traps.some((t) => t.kind === "stale")) err(`${where} stale question needs a stale trap`);
    if (question.kind === "cross-project" && !traps.some((t) => t.kind === "cross-project")) err(`${where} cross-project question needs a cross-project trap`);
    if (question.kind === "conflict" && !question.expect.entries.some((e) => e.parts.includes("conflicts"))) err(`${where} conflict question must expect conflicts`);
    const asked = question.askedAt;
    const goldQuestion = gold.questions.find((q) => q.id === where);
    for (const item of goldQuestion?.expectedItems ?? []) {
      const sources = gold.entries.find((e) => e.id === item.entry)?.sources ?? [];
      const first = sources.map((id) => traces.get(id)).sort((a, b) => a.reply_time.localeCompare(b.reply_time))[0];
      if (!first || first.reply_time >= asked) err(`${where} evidence for ${item.entry} is not before askedAt`);
    }
  }
  for (const check of questions.apiChecks) {
    for (const id of check.questionTexts ?? []) if (!questionIds.has(id)) err(`${check.id} refers to unknown question ${id}`);
    if (check.space_id && !spaces.has(check.space_id)) err(`${check.id} space missing`);
    if (check.domain && spaces.get(check.space_id)?.domains.some((d) => d.domain === check.domain)) err(`${check.id} domain must be unregistered`);
  }
  return { errors, gold };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ds = loadDataset();
  const { errors, gold } = validateDataset(ds);
  const scored = gold.questions.filter((q) => !q.excluded);
  const byKind = Object.fromEntries([...new Set(scored.map((q) => q.kind))].sort().map((k) => [k, scored.filter((q) => q.kind === k).length]));
  const outcomes = Object.fromEntries(["written", "optional-only", "not-written"].map((o) => [o, gold.traceLabels.filter((t) => t.outcome === o).length]));
  process.stdout.write(`${JSON.stringify({
    errors,
    datasetVersion: 2,
    traces: orderedTraces(ds.corpus).length,
    traceOutcomes: outcomes,
    topics: gold.topics.length,
    entries: gold.entries.filter((e) => !e.optional).length,
    optionalEntries: gold.entries.filter((e) => e.optional).length,
    negatives: gold.negatives.length,
    questions: scored.length,
    questionsByKind: byKind,
    apiChecks: gold.apiChecks.length
  })}\n`);
  process.exit(errors.length ? 1 : 0);
}

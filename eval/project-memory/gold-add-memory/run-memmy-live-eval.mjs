import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const gold = JSON.parse(readFileSync(join(root, "generated/extracted-gold.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(root, "dataset/corpus.json"), "utf8"));
const relay = JSON.parse(readFileSync(join(root, "dataset/relay.json"), "utf8"));
const relayById = new Map(relay.questions.map((question) => [question.id, question]));
const questions = gold.timelines.flatMap((timeline) => timeline.questions)
  .map((question) => ({ ...relayById.get(question.id), ...question }));
const endpoint = (process.env.MEMMY_EVAL_ENDPOINT ?? "http://127.0.0.1:18961").replace(/\/$/, "");
const userId = "project-memory-live-eval";
const headers = {
  "content-type": "application/json",
  ...(process.env.MEMMY_EVAL_TOKEN ? { authorization: `Bearer ${process.env.MEMMY_EVAL_TOKEN}` } : {})
};
async function call(path, body) {
  const response = await fetch(`${endpoint}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}
const addResults = [];
const namespace = { source: "codex", profileId: "default", userId };
const previousRunPath = join(root, "generated/live-memmy-run.json");
const skipAdd = process.env.MEMMY_EVAL_SKIP_ADD === "1";
if (skipAdd && existsSync(previousRunPath)) {
  const previous = JSON.parse(readFileSync(previousRunPath, "utf8"));
  for (const entry of previous?.input?.add?.entries ?? []) addResults.push(entry);
}
const tracesBySession = new Map();
for (const trace of corpus.traces) {
  if (trace.memoryScope !== "project" || !trace.projectId) continue;
  const rows = tracesBySession.get(trace.sessionId) ?? [];
  rows.push(trace);
  tracesBySession.set(trace.sessionId, rows);
}
for (const session of skipAdd ? [] : corpus.sessions.filter((item) => item.projectId)) {
  const traces = (tracesBySession.get(session.id) ?? []).sort((left, right) => left.at.localeCompare(right.at));
  if (traces.length === 0) continue;
  const result = await call("/api/v1/memory/add", {
    user_id: userId,
    conversation_id: session.id,
    agent_id: session.agent,
    space_ids: session.projectId,
    allow_memory_view: ["project"],
    source_trace_ids: traces.map((trace) => trace.id),
    messages: traces.flatMap((trace) => [
      { role: "user", content: trace.query, chat_time: trace.at, source_trace_id: trace.id },
      { role: "assistant", content: trace.answer, chat_time: trace.at, source_trace_id: trace.id }
    ])
  });
  for (const entry of Array.isArray(result?.entries) ? result.entries : []) {
    addResults.push({
      kind: entry.kind,
      topicId: entry.topic_id,
      sourceTraceIds: entry.source_trace_ids,
      text: entry.text,
      sessionId: session.id,
      result
    });
  }
}
for (const trace of skipAdd ? [] : corpus.traces.filter((item) => item.memoryScope !== "project")) {
  await call("/api/v1/memory/add", {
    namespace,
    content: `${trace.query}\n${trace.answer}`,
    layer: "L1",
    title: trace.id,
    tags: ["project-memory-live-global", `gold-trace:${trace.id}`]
  });
}
const searchResults = [];
const answers = [];
for (const question of questions) {
  if (!question.projectId) {
    const result = await call("/api/v1/memory/search", {
      namespace,
      query: question.question,
      limit: 10,
      includeInjectedContext: false,
      verbose: true
    });
    const hits = Array.isArray(result?.hits) ? result.hits : [];
    const recalledTraceIds = hits.flatMap((hit) => Array.isArray(hit.tags)
      ? hit.tags.filter((tag) => tag.startsWith("gold-trace:")).map((tag) => tag.slice("gold-trace:".length))
      : []);
    searchResults.push({ questionId: question.id, recalledTraceIds: [...new Set(recalledTraceIds)], hitCount: hits.length, hits });
    answers.push({ questionId: question.id, answer: hits.map((hit) => hit.snippet ?? "").join("\n") });
    continue;
  }
  const result = await call("/api/v1/memory/search", {
    user_id: userId,
    query: question.question,
    conversation_id: question.sessionId,
    space_ids: question.projectId,
    include_memory_view: ["project"],
    memory_limit_number: 10,
    generate_answer: true
  });
  const topics = Array.isArray(result?.topic_detail_list) ? result.topic_detail_list : [];
  const entries = topics.flatMap((topic) => Array.isArray(topic?.entries) ? topic.entries : []);
  const recalledTraceIds = entries.flatMap((entry) => Array.isArray(entry?.source_trace_ids) ? entry.source_trace_ids : []);
  searchResults.push({ questionId: question.id, recalledTraceIds: [...new Set(recalledTraceIds)], topicCount: topics.length, topics });
  answers.push({ questionId: question.id, answer: typeof result?.answer === "string" ? result.answer : "" });
}
const input = {
  add: { entries: addResults.map(({ kind, topicId, sourceTraceIds, text }) => ({ kind, topicId, sourceTraceIds, text })) },
  search: searchResults.map(({ questionId, recalledTraceIds }) => ({ questionId, recalledTraceIds })),
  answers
};
mkdirSync(join(root, "generated"), { recursive: true });
writeFileSync(join(root, "generated/live-memmy-run.json"), `${JSON.stringify({ endpoint, input, searchResults, addResults }, null, 2)}\n`);
console.log(JSON.stringify({ endpoint, added: addResults.length, searched: searchResults.length, output: "generated/live-memmy-run.json" }));

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

// Replays the corpus against a Local Memmy server in time order: before each question only the
// traces with at <= askedAt are written, so mid-timeline questions see the state they ask about.
// The server must use a fresh SQLite file; project search filters by space, not by user.
const root = dirname(fileURLToPath(import.meta.url));
const gold = JSON.parse(readFileSync(join(root, "generated/extracted-gold.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(root, "dataset/corpus.json"), "utf8"));
const questions = gold.timelines.flatMap((timeline) => timeline.questions)
  .sort((left, right) => left.askedAt.localeCompare(right.askedAt));
const endpoint = (process.env.MEMMY_EVAL_ENDPOINT ?? "http://127.0.0.1:18961").replace(/\/$/, "");
const memoryLimit = Number(process.env.MEMMY_EVAL_MEMORY_LIMIT ?? 10);
const userId = "project-memory-live-eval";
const namespace = { source: "codex", profileId: "default", userId };
const configPath = process.env.MEMMY_CONFIG_PATH ?? join(homedir(), ".memmy/config.yaml");
const token = process.env.MEMMY_EVAL_TOKEN
  ?? (existsSync(configPath) ? YAML.parse(readFileSync(configPath, "utf8"))?.memmyMemory?.storage?.token : undefined);
const headers = {
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {})
};
const sessionsById = new Map(corpus.sessions.map((session) => [session.id, session]));
const requests = [];

async function call(phase, path, body, label) {
  const startedAt = performance.now();
  const response = await fetch(`${endpoint}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  const latencyMs = performance.now() - startedAt;
  const result = text ? JSON.parse(text) : undefined;
  const usage = result?.usage ? {
    model: result.usage.model,
    llmCalls: result.usage.llm_calls ?? 0,
    inputTokens: result.usage.input_tokens ?? 0,
    outputTokens: result.usage.output_tokens ?? 0,
    cachedInputTokens: result.usage.cached_input_tokens ?? 0
  } : null;
  requests.push({ phase, path, label, status: response.status, latencyMs, usage });
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text}`);
  return result;
}

for (const spaceId of new Set(corpus.traces.map((trace) => trace.projectId).filter(Boolean))) {
  const response = await fetch(`${endpoint}/api/v1/memory/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ user_id: userId, query: "?", space_ids: spaceId, include_memory_view: ["project"], memory_limit_number: 1 })
  });
  const probe = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`probe ${spaceId} ${response.status}: ${JSON.stringify(probe)}`);
    process.exit(2);
  }
  if (probe?.topic_detail_list?.length) {
    console.error(`${spaceId} already has project memory; start the server on a fresh SQLite file`);
    process.exit(2);
  }
}

const pending = [...corpus.traces].sort((left, right) => left.at.localeCompare(right.at));
const addResults = [];
const entriesById = new Map();

async function flush(until) {
  const due = [];
  while (pending.length && pending[0].at <= until) due.push(pending.shift());
  const bySession = new Map();
  for (const trace of due) bySession.set(trace.sessionId, [...(bySession.get(trace.sessionId) ?? []), trace]);
  for (const [sessionId, traces] of bySession) {
    if (traces[0].memoryScope !== "project" || !traces[0].projectId) {
      for (const trace of traces) {
        await call("add", "/api/v1/memory/add", {
          namespace,
          content: `${trace.query}\n${trace.answer}`,
          layer: "L1",
          title: trace.id,
          tags: ["project-memory-live-global", `gold-trace:${trace.id}`]
        }, trace.id);
      }
      continue;
    }
    const session = sessionsById.get(sessionId);
    const result = await call("add", "/api/v1/memory/add", {
      user_id: userId,
      conversation_id: sessionId,
      agent_id: session?.agent,
      space_ids: traces[0].projectId,
      allow_memory_view: ["project"],
      source_trace_ids: traces.map((trace) => trace.id),
      messages: traces.flatMap((trace) => [
        { role: "user", content: trace.query, chat_time: trace.at, source_trace_id: trace.id },
        { role: "assistant", content: trace.answer, chat_time: trace.at, source_trace_id: trace.id }
      ])
    }, `${sessionId}@${traces.at(-1).at}`);
    addResults.push({ sessionId, traceIds: traces.map((trace) => trace.id), result });
    for (const entry of Array.isArray(result?.entries) ? result.entries : []) {
      entriesById.set(entry.id ?? `${sessionId}:${entriesById.size}`, {
        kind: entry.kind,
        topicId: entry.topic_id,
        projectId: traces[0].projectId,
        sourceTraceIds: entry.source_trace_ids,
        text: entry.text,
        sessionId
      });
    }
  }
}

const runStartedAt = performance.now();
const searchResults = [];
const answers = [];
for (const question of questions) {
  await flush(question.askedAt);
  if (!question.projectId) {
    const result = await call("search", "/api/v1/memory/search", {
      namespace,
      query: question.question,
      limit: memoryLimit,
      includeInjectedContext: false,
      verbose: true
    }, question.id);
    const hits = Array.isArray(result?.hits) ? result.hits : [];
    const ranked = hits.map((hit) => ({
      text: hit.snippet ?? "",
      sourceTraceIds: (Array.isArray(hit.tags) ? hit.tags : []).filter((tag) => tag.startsWith("gold-trace:")).map((tag) => tag.slice("gold-trace:".length))
    }));
    searchResults.push({ questionId: question.id, ranked, hits });
    answers.push({ questionId: question.id, answer: hits.map((hit) => hit.snippet ?? "").join("\n") });
    continue;
  }
  const result = await call("search", "/api/v1/memory/search", {
    user_id: userId,
    query: question.question,
    conversation_id: question.sessionId,
    space_ids: question.projectId,
    include_memory_view: ["project"],
    memory_limit_number: memoryLimit,
    generate_answer: true
  }, question.id);
  const topics = Array.isArray(result?.topic_detail_list) ? result.topic_detail_list : [];
  const ranked = topics.flatMap((topic) => (Array.isArray(topic?.entries) ? topic.entries : []).map((entry) => ({
    topicId: topic.topic_id,
    kind: entry.kind,
    text: entry.entry,
    sourceTraceIds: Array.isArray(entry.source_trace_ids) ? entry.source_trace_ids : []
  })));
  searchResults.push({ questionId: question.id, ranked, topics });
  answers.push({ questionId: question.id, answer: typeof result?.answer === "string" ? result.answer : "" });
}
await flush("9999");
const wallclockMs = performance.now() - runStartedAt;

const input = {
  add: { entries: [...entriesById.values()] },
  search: searchResults.map(({ questionId, ranked }) => ({ questionId, ranked: ranked.map(({ sourceTraceIds }) => ({ sourceTraceIds })) })),
  answers,
  requests: requests.map(({ phase, latencyMs, usage, status }) => ({ phase, latencyMs, usage, status })),
  wallclockMs
};
mkdirSync(join(root, "generated"), { recursive: true });
writeFileSync(join(root, "generated/live-memmy-run.json"), `${JSON.stringify({
  schemaVersion: 2,
  endpoint,
  replay: "interleaved-by-askedAt",
  memoryLimit,
  input,
  requests,
  searchResults,
  addResults
}, null, 2)}\n`);
console.log(JSON.stringify({ endpoint, addRequests: requests.filter((r) => r.phase === "add").length, entries: entriesById.size, searched: searchResults.length, wallclockMs: Math.round(wallclockMs), output: "generated/live-memmy-run.json" }));

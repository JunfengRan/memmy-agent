// Control replay for the main-branch build, which has no project memory: every trace is
// written as a plain L1 memory tagged with its trace id, and every question is answered by
// the generic search. Output matches the project-memory run shape so the same scorer works.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const gold = JSON.parse(readFileSync(join(root, "generated/extracted-gold.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(root, "dataset/corpus.json"), "utf8"));
const questions = gold.timelines.flatMap((t) => t.questions).sort((a, b) => a.askedAt.localeCompare(b.askedAt));
const endpoint = (process.env.MEMMY_EVAL_ENDPOINT ?? "http://127.0.0.1:18961").replace(/\/$/, "");
const token = process.env.MEMMY_EVAL_TOKEN;
const memoryLimit = Number(process.env.MEMMY_EVAL_MEMORY_LIMIT ?? 10);
const userId = "project-memory-live-eval";
const namespace = { source: "codex", profileId: "default", userId };
const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
const requests = [];

async function call(phase, path, body, label) {
  const startedAt = performance.now();
  const response = await fetch(`${endpoint}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  const latencyMs = performance.now() - startedAt;
  const result = text ? JSON.parse(text) : undefined;
  const usage = result?.usage ? { model: result.usage.model, llmCalls: result.usage.llm_calls ?? 0, inputTokens: result.usage.input_tokens ?? 0, outputTokens: result.usage.output_tokens ?? 0, cachedInputTokens: result.usage.cached_input_tokens ?? 0 } : null;
  requests.push({ phase, path, label, status: response.status, latencyMs, usage });
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text}`);
  return result;
}

const pending = [...corpus.traces].sort((a, b) => a.at.localeCompare(b.at));
async function flush(until) {
  const due = [];
  while (pending.length && pending[0].at <= until) due.push(pending.shift());
  for (const trace of due) {
    const session = corpus.sessions.find((s) => s.id === trace.sessionId);
    await call("add", "/api/v1/memory/add", {
      namespace,
      content: `${trace.query}\n${trace.answer}`,
      layer: "L1",
      title: trace.id,
      createdAt: trace.at,
      // The control build has no space_ids, so the space lives in the tags: the replay filters a
      // question's search to its own space, which is what the spec asks callers to do.
      tags: ["control-replay", "space:" + (trace.projectId ?? "none"), `gold-trace:${trace.id}`, `agent:${session?.agent ?? ""}`]
    }, trace.id);
  }
}

const runStartedAt = performance.now();
const searchResults = [];
const answers = [];
for (const question of questions) {
  await flush(question.askedAt);
  const result = await call("search", "/api/v1/memory/search", {
    namespace,
    query: question.question,
    limit: memoryLimit,
    filter: { tags: ["space:" + (question.projectId ?? "none")] },
    includeInjectedContext: false,
    verbose: true
  }, question.id);
  const hits = Array.isArray(result?.debug?.hits) ? result.debug.hits : [];
  const ranked = hits.map((hit) => ({
    text: hit.snippet ?? "",
    sourceTraceIds: (Array.isArray(hit.tags) ? hit.tags : []).filter((t) => t.startsWith("gold-trace:")).map((t) => t.slice("gold-trace:".length))
  }));
  searchResults.push({ questionId: question.id, ranked });
  answers.push({ questionId: question.id, answer: hits.map((h) => h.snippet ?? "").join("\n") });
}
await flush("9999");
const wallclockMs = performance.now() - runStartedAt;
const out = join(root, "generated/live-control-memmy-run.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({
  schemaVersion: 2, endpoint, variant: "main-branch-no-project-memory", replay: "interleaved-by-askedAt", memoryLimit,
  input: { add: { entries: [] }, search: searchResults, answers,
    requests: requests.map(({ phase, latencyMs, usage, status }) => ({ phase, latencyMs, usage, status })), wallclockMs },
  requests, searchResults
}, null, 2)}\n`);
console.log(JSON.stringify({ addRequests: requests.filter((r) => r.phase === "add").length, searched: searchResults.length, wallclockMs: Math.round(wallclockMs), output: out }));

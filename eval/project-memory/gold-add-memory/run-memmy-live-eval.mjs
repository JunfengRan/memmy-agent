import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const gold = JSON.parse(readFileSync(join(root, "generated/extracted-gold.json"), "utf8"));
const questions = gold.timelines.flatMap((timeline) => timeline.questions);
const endpoint = (process.env.MEMMY_EVAL_ENDPOINT ?? "http://127.0.0.1:18961").replace(/\/$/, "");
const userId = "project-memory-live-eval";
const headers = { "content-type": "application/json" };
async function call(path, body) {
  const response = await fetch(`${endpoint}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}
const namespace = { source: "codex", profileId: "default", userId };
const addResults = [];
for (const entry of gold.entries) {
  const result = await call("/api/v1/memory/add", {
    namespace,
    content: entry.text,
    layer: "L1",
    title: entry.id,
    tags: ["project-memory-live", `gold-kind:${entry.kind}`, `gold-topic:${entry.topicId}`, ...entry.sourceTraceIds.map((id) => `gold-trace:${id}`)]
  });
  addResults.push({ entry, result });
}
for (let i = 0; i < 12; i += 1) {
  const worker = await call("/api/v1/worker/run", { namespace, limit: 200 });
  if (!worker?.leased) break;
}
const searchResults = [];
const answers = [];
for (const question of questions) {
  const result = await call("/api/v1/memory/search", {
    namespace,
    query: question.question,
    limit: 10,
    includeInjectedContext: false,
    verbose: true
  });
  const hits = Array.isArray(result?.hits) ? result.hits : [];
  const recalledTraceIds = hits.flatMap((hit) => Array.isArray(hit.tags) ? hit.tags.filter((tag) => tag.startsWith("gold-trace:")).map((tag) => tag.slice("gold-trace:".length)) : []);
  searchResults.push({ questionId: question.id, recalledTraceIds: [...new Set(recalledTraceIds)], hitCount: hits.length, hits: hits.map((hit) => ({ id: hit.id, score: hit.score, snippet: hit.snippet, tags: hit.tags })) });
  answers.push({ questionId: question.id, answer: hits.map((hit) => hit.snippet ?? "").join("\n") });
}
const input = {
  add: { entries: addResults.map(({ entry, result }) => ({ kind: result?.kind ?? "unknown", topicId: entry.topicId, sourceTraceIds: entry.sourceTraceIds, text: result?.summary ?? entry.text })) },
  search: searchResults.map(({ questionId, recalledTraceIds }) => ({ questionId, recalledTraceIds })),
  answers
};
mkdirSync(join(root, "generated"), { recursive: true });
writeFileSync(join(root, "generated/live-memmy-run.json"), `${JSON.stringify({ endpoint, input, searchResults, addResults }, null, 2)}\n`);
console.log(JSON.stringify({ endpoint, added: addResults.length, searched: searchResults.length, output: "generated/live-memmy-run.json" }));

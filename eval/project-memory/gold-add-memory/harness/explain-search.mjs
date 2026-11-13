// Replays project-path ranking against the sqlite snapshot taken before each question.
//   cd Memory && npx tsx ../eval/project-memory/gold-add-memory/harness/explain-search.mjs --run <run-dir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryDb } from "../../../../Memory/src/storage/db.ts";
import { createEmbedder } from "../../../../Memory/src/model/embedder.ts";
import { PROJECT_MEMORY_LIMITS } from "../../../../Memory/src/service/project-memory/contract/limits.ts";
import { SqliteProjectMemoryStore } from "../../../../Memory/src/service/project-memory/store/sqlite/sqlite-store.ts";
import { scoreProjectTopics } from "../../../../Memory/src/service/project-memory/retrieve/search.ts";
import { normalizeForCompare } from "../../../../Memory/src/service/project-memory/text.ts";
import { loadDataset } from "../build-gold-baseline.mjs";
import { loadGold } from "../load-eval-set.mjs";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const runDir = arg("run");
if (!runDir) { console.error("usage: --run <run-dir>"); process.exit(2); }

const MEMORY_LIMIT = 9;
const live = JSON.parse(readFileSync(join(runDir, "live-run.json"), "utf8"));
const gold = loadGold();
const ds = loadDataset();
const conversations = new Map(ds.corpus.conversations.map((item) => [item.id, item]));
const questions = new Map(gold.questions.map((item) => [item.id, item]));
const entries = new Map(gold.entries.map((item) => [item.id, item]));
const embedder = createEmbedder({
  provider: "local",
  mode: "local",
  model: "Xenova/all-MiniLM-L6-v2",
  batchSize: 32,
  timeoutMs: 60_000,
  maxRetries: 2,
  cache: true,
  normalize: false
});

function sameText(left, right) {
  return normalizeForCompare(String(left ?? "")) === normalizeForCompare(String(right ?? ""));
}

function locate(db, serverSpaceId, text) {
  const hits = [];
  const topics = db.prepare("SELECT id, topic_name, topic_summary, topic_description FROM pm_topics WHERE space_id = ?").all(serverSpaceId);
  for (const topic of topics) {
    if ([topic.topic_name, topic.topic_summary, topic.topic_description].some((field) => sameText(field, text) || String(field ?? "").includes(text))) {
      hits.push({ topicId: topic.id, where: "topic" });
    }
    for (const table of ["pm_decisions", "pm_experiences", "pm_timeline"]) {
      for (const row of db.prepare(`SELECT id, content FROM ${table} WHERE topic_id = ?`).all(topic.id)) {
        if (sameText(row.content, text) || String(row.content).includes(text)) hits.push({ topicId: topic.id, where: table, id: row.id });
      }
    }
    for (const row of db.prepare(`SELECT decision_id, seq, content FROM pm_decision_conflicts WHERE decision_id IN (SELECT id FROM pm_decisions WHERE topic_id = ?)`).all(topic.id)) {
      if (sameText(row.content, text) || String(row.content).includes(text)) hits.push({ topicId: topic.id, where: "pm_decision_conflicts", id: row.decision_id, seq: row.seq });
    }
    for (const row of db.prepare(`SELECT decision_id, seq, content FROM pm_decision_history WHERE decision_id IN (SELECT id FROM pm_decisions WHERE topic_id = ?)`).all(topic.id)) {
      if (sameText(row.content, text) || String(row.content).includes(text)) hits.push({ topicId: topic.id, where: "pm_decision_history", id: row.decision_id, seq: row.seq });
    }
  }
  return hits;
}

const explained = [];
for (const asked of live.questions) {
  const question = questions.get(asked.id);
  const snapshot = join(runDir, "trace", "db", `before-${asked.id}.sqlite`);
  const conversation = conversations.get(question.conversation);
  const serverSpaceId = live.spaceMap[conversation.space_id];
  const conversationId = `${conversation.conversation_id}:${live.runTag}`;
  const memory = new MemoryDb({ path: snapshot, readonly: true });
  try {
    const store = new SqliteProjectMemoryStore({ db: memory.db, embedder: () => embedder });
    const recall = await store.recall({
      spaceIds: [serverSpaceId],
      queries: [{ qid: "q", text: question.question }],
      purpose: "search",
      preferConversationId: conversationId,
      topicK: Math.max(PROJECT_MEMORY_LIMITS.topicK, MEMORY_LIMIT * 2),
      entryK: PROJECT_MEMORY_LIMITS.entryK
    });
    const topics = recall.results[0]?.topics ?? [];
    const scored = scoreProjectTopics(question.question, topics);
    const positive = scored.filter((item) => item.fused > 0);
    explained.push({
      id: asked.id,
      question: question.question,
      degraded: recall.degraded,
      returnedTopicIds: (asked.topic_detail_list ?? []).map((topic) => topic.id),
      topics: positive.map((item, index) => ({
        topicId: item.topic.topicId,
        topicName: item.topic.topicName,
        lexicalScore: item.topic.scores.lexical,
        vectorScore: item.topic.scores.vector,
        lexicalRank: item.lexicalRank,
        vectorRank: item.vectorRank,
        rrf: item.rrf,
        recency: item.recency,
        conversationBoost: item.conversationBoost,
        fused: item.fused,
        rank: index + 1,
        withinLimit: index < MEMORY_LIMIT,
        minEntryHits: item.minEntryHits,
        entries: item.entryScores.map((entry) => ({
          id: entry.entry.id,
          kind: entry.entry.kind,
          lexical: entry.lexical,
          kept: entry.kept
        }))
      })),
      gold: (question.expectedItems ?? []).map((item) => ({
        entry: item.entry,
        part: item.part,
        text: item.text,
        locations: locate(memory.db, serverSpaceId, item.text),
        sources: entries.get(item.entry)?.sources ?? []
      }))
    });
  } finally {
    memory.close();
  }
}

const outDir = join(runDir, "trace");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "search-explain.json");
writeFileSync(out, `${JSON.stringify({ memoryLimit: MEMORY_LIMIT, questions: explained }, null, 2)}\n`);
console.log(JSON.stringify({ out, questions: explained.length }));

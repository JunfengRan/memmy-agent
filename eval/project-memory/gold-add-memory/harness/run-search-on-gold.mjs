#!/usr/bin/env node
// Search on gold memory (dataset v2.1). For each distinct askedAt among scored questions,
// commit the gold project state visible at that time into a fresh temporary sqlite, then call
// MemoryService.handleProjectMemoryRequest — the function behind POST /api/openmem/v1/search/memory.
// The embedder is the local Xenova model resolved from harness/eval-config.yaml. No chat model
// runs inside search, and the run's final state stays empty so this is not a product add.
//
//   cd Memory && npx tsx ../eval/project-memory/gold-add-memory/harness/run-search-on-gold.mjs
//
// Env: MEMMY_EVAL_READER_{PROVIDER,MODEL,BASE_URL,API_KEY}, MEMMY_EVAL_READER_CACHE.
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemmyConfig } from "../../../../Memory/src/config/index.js";
import { createEmbedder } from "../../../../Memory/src/model/embedder.js";
import { MemoryService } from "../../../../Memory/src/service/memory-service.js";
import { MemoryDb } from "../../../../Memory/src/storage/db.js";
import { activePointTexts, loadDataset, replay } from "../build-gold-baseline.mjs";
import { createLlm, resolveModelConfig } from "../llm.mjs";
import { loadGold } from "../load-eval-set.mjs";
import { displayNames, oracleTopics } from "../oracle.mjs";
import { createReader, renderTemplate3 } from "../reader.mjs";
import { RUNS_DIR } from "../run-pipeline-eval.mjs";

const SUT_MODEL = "deepseek-v4.1-flash-1017";
const SEARCH_PATH = "/api/openmem/v1/search/memory";
const MEMORY_LIMIT = 9;
const here = dirname(fileURLToPath(import.meta.url));
const evalConfigPath = join(here, "eval-config.yaml");

const ds = loadDataset();
const gold = loadGold();
const scored = gold.questions.filter((question) => !question.excluded);
const names = displayNames(ds);
const conversations = new Map(ds.corpus.conversations.map((conversation) => [conversation.id, conversation]));
const readerConfig = resolveModelConfig("MEMMY_EVAL_READER");
if (!readerConfig) {
  console.error("reader not configured: set MEMMY_EVAL_READER_PROVIDER / _MODEL / _BASE_URL / _API_KEY");
  process.exit(2);
}
if (readerConfig.model !== SUT_MODEL) {
  console.error(`reader model is ${readerConfig.model}, expected ${SUT_MODEL}`);
  process.exit(2);
}
if (readerConfig.provider !== "openai") {
  console.error(`reader provider is ${readerConfig.provider}, expected openai`);
  process.exit(2);
}

function users(ids, label) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string" || !id)) {
    throw new Error(`${label} has no user_ids`);
  }
  return [...ids];
}

// Same visible state as oracleTopics (replay until askedAt, non-optional entries, active key
// points), with gold entry ids kept so commitChangeSet can address them.
function visibleTopics(until, spaceId) {
  const { state } = replay(ds, until);
  const traces = new Map(ds.corpus.traces.map((trace) => [trace.id, trace]));
  const topics = [];
  for (const topic of ds.labels.topics.filter((item) => item.space_id === spaceId)) {
    const entries = [...state.entries()].filter(([id]) => ds.labels.entries[id].topic === topic.id && !ds.labels.entries[id].optional);
    if (!entries.length) continue;
    const of = (kind) => entries.filter(([id]) => ds.labels.entries[id].kind === kind);
    const times = entries.flatMap(([, entry]) => [entry.time, ...entry.conflicts.map((conflict) => conflict.time)]).sort();
    topics.push({
      id: topic.id,
      space_id: spaceId,
      domain: topic.domain,
      topic_name: topic.topic_name,
      topic_summary: activePointTexts(topic.summaryKeyPoints, traces, until).join("；"),
      topic_description: activePointTexts(topic.descriptionKeyPoints, traces, until).join("；"),
      decisions: of("decision").map(([id, entry]) => ({
        id,
        content: entry.content,
        time: entry.time,
        user_ids: entry.user_ids,
        conflicts: entry.conflicts.map((conflict) => ({ content: conflict.content, time: conflict.time, user_ids: conflict.user_ids })),
        history: entry.history.map((item) => ({ content: item.content, time: item.time, user_ids: item.user_ids, reason: item.reason ?? null }))
      })),
      experiences: of("experience").map(([id, entry]) => ({
        id,
        content: entry.content,
        time: entry.time,
        user_ids: entry.user_ids,
        history: entry.history.map((item) => ({ content: item.content, time: item.time, user_ids: item.user_ids }))
      })),
      timeline: of("timeline").map(([id, entry]) => ({ id, content: entry.content, time: entry.time, user_ids: entry.user_ids })),
      create_time: times[0],
      update_time: times.at(-1)
    });
  }
  return topics.sort((left, right) => right.update_time.localeCompare(left.update_time));
}

function withoutEntryIds(topics) {
  return topics.map((topic) => ({
    ...topic,
    decisions: topic.decisions.map(({ id, ...entry }) => entry),
    experiences: topic.experiences.map(({ id, ...entry }) => entry),
    timeline: topic.timeline.map(({ id, ...entry }) => entry)
  }));
}

function assertMatchesOracle(until) {
  for (const space of ds.corpus.spaces) {
    const visible = visibleTopics(until, space.space_id);
    const oracle = oracleTopics(ds, until, space.space_id);
    if (JSON.stringify(withoutEntryIds(visible)) !== JSON.stringify(oracle)) {
      throw new Error(`visible topics at ${until} in ${space.space_id} differ from oracleTopics`);
    }
  }
}

function decisionOps(decision) {
  const history = [...(decision.history ?? [])].sort((left, right) => left.time.localeCompare(right.time) || left.content.localeCompare(right.content));
  const ops = [];
  if (history.length === 0) {
    ops.push({ op: "add", decisionId: decision.id, content: decision.content, time: decision.time, userIds: users(decision.user_ids, decision.id) });
  } else {
    const first = history[0];
    ops.push({ op: "add", decisionId: decision.id, content: first.content, time: first.time, userIds: users(first.user_ids, `${decision.id} history`) });
    let reason = first.reason ?? null;
    for (const item of history.slice(1)) {
      ops.push({ op: "rewrite", decisionId: decision.id, content: item.content, time: item.time, userIds: users(item.user_ids, `${decision.id} history`), reason });
      reason = item.reason ?? null;
    }
    ops.push({ op: "rewrite", decisionId: decision.id, content: decision.content, time: decision.time, userIds: users(decision.user_ids, decision.id), reason });
  }
  for (const conflict of decision.conflicts ?? []) {
    ops.push({ op: "conflict_append", decisionId: decision.id, content: conflict.content, time: conflict.time, userIds: users(conflict.user_ids, `${decision.id} conflict`) });
  }
  return ops;
}

function topicChange(topic) {
  return {
    op: "create",
    topicId: topic.id,
    domain: topic.domain,
    topicName: topic.topic_name,
    topicSummary: topic.topic_summary,
    topicDescription: topic.topic_description,
    decisions: topic.decisions.flatMap((decision) => decisionOps(decision)),
    experiences: topic.experiences.flatMap((experience) => [
      { op: "add", experienceId: experience.id, content: experience.content, time: experience.time, userIds: users(experience.user_ids, experience.id) },
      ...(experience.history ?? []).map((item) => ({
        op: "history_backfill",
        experienceId: experience.id,
        content: item.content,
        time: item.time,
        userIds: users(item.user_ids, `${experience.id} history`)
      }))
    ]),
    timelineAppend: topic.timeline.map((item) => ({
      timelineId: item.id,
      content: item.content,
      time: item.time,
      userIds: users(item.user_ids, item.id)
    })),
    sourcesAppend: []
  };
}

async function commitTopics(store, topics, askedAt) {
  const grouped = new Map();
  for (const topic of topics) {
    const list = grouped.get(topic.space_id) ?? [];
    list.push(topicChange(topic));
    grouped.set(topic.space_id, list);
  }
  const seq = new Map();
  let batch = 0;
  const topicIds = [];
  for (const [spaceId, changes] of grouped) {
    const byDomain = new Map();
    for (const change of changes) {
      const list = byDomain.get(change.domain) ?? [];
      list.push(change);
      byDomain.set(change.domain, list);
    }
    for (const [domain, group] of byDomain) {
      for (let offset = 0; offset < group.length; offset += 20) {
        const chunk = group.slice(offset, offset + 20);
        const key = `${spaceId}\0${domain}`;
        const expected = seq.get(key) ?? 0;
        batch += 1;
        const result = await store.commitChangeSet({
          spaceId,
          taskId: `gold_task_${batch}`,
          sourceBatchId: `gold_batch_${batch}`,
          idempotencyKey: `gold_${askedAt}_${spaceId}_${domain}_${offset}`,
          topics: chunk.map((change) => ({ ...change, expectedTopicSeq: expected }))
        }, { acceptedAt: new Date(Date.now() + 2_000).toISOString() });
        if (!result.ok) throw new Error(`commit ${spaceId}/${domain} at ${askedAt} failed: ${JSON.stringify(result)}`);
        seq.set(key, expected + chunk.length);
        topicIds.push(...chunk.map((change) => change.topicId));
      }
    }
  }
  return topicIds;
}

function refuseChat() {
  const config = { provider: "", model: "", enableThinking: false, temperature: 0, timeoutMs: 1, maxRetries: 0, malformedRetries: 0 };
  const refuse = async () => {
    throw new Error("search-on-gold does not call a chat model");
  };
  return { config, isConfigured: () => false, status: () => ({ provider: "none", configured: false, remote: false }), complete: refuse, completeJson: refuse };
}

function assertLocalXenova(embedding) {
  const provider = embedding?.provider;
  const mode = embedding?.mode;
  const model = String(embedding?.model ?? "");
  if (provider !== "local" || mode !== "local" || !model.includes("Xenova") || model === "pm23-hash-v1") {
    throw new Error(`eval-config embedder is ${provider}/${mode}/${model || "(none)"}; expected local Xenova, not the hash stub`);
  }
}

function searchBody(question) {
  const conversation = conversations.get(question.conversation);
  if (!conversation) throw new Error(`${question.id} conversation ${question.conversation} is missing`);
  if (conversation.space_id !== question.space_id) throw new Error(`${question.id} space does not match its conversation`);
  return {
    user_id: conversation.user_id,
    query: question.question,
    space_ids: [question.space_id],
    conversation_id: conversation.conversation_id,
    include_memory_view: ["project"],
    memory_limit_number: MEMORY_LIMIT
  };
}

function projectMemoryStore(service) {
  const store = service.projectMemory?.store;
  if (!store?.commitChangeSet || !store?.indexTopics) throw new Error("MemoryService did not expose ProjectMemoryStore");
  return store;
}

async function openService(dbPath, embedder) {
  const loaded = loadMemmyConfig(evalConfigPath);
  const config = structuredClone(loaded.config);
  config.storage.sqlitePath = dbPath;
  config.storage.mode = "local";
  config.storage.backend = "sqlite";
  config.algorithm.enableMemoryAdd = false;
  config.algorithm.enableMemorySearch = true;
  config.algorithm.enableQueryRewrite = false;
  config.algorithm.retrieval.llmFilterEnabled = false;
  config.summary = { ...config.summary, provider: "", model: "", apiKey: undefined, endpoint: undefined };
  config.evolution = { ...config.evolution, provider: "", model: "", apiKey: undefined, endpoint: undefined };
  const db = new MemoryDb({ path: dbPath });
  const llm = refuseChat();
  const service = new MemoryService({
    db,
    mode: "local",
    config,
    llm,
    skillLlm: llm,
    embedder,
    fetchAppMemoryBudget: async () => null,
    tokenUsage: { runtimeConfig: null, runtimeConfigPath: join(dirname(dbPath), "runtime.json") }
  });
  return { db, service, store: projectMemoryStore(service) };
}

async function searchQuestion(service, question) {
  const at = Date.now();
  const started = performance.now();
  let status = 0;
  try {
    const result = await service.handleProjectMemoryRequest({
      method: "POST",
      path: SEARCH_PATH,
      body: searchBody(question),
      timezone: "+08:00"
    });
    status = 200;
    if (!result || result.envelope.code !== 0) {
      throw new Error(`search/memory failed for ${question.id}: ${JSON.stringify(result?.envelope ?? null)}`);
    }
    const data = result.envelope.data ?? {};
    const degraded = Array.isArray(data.degraded) ? data.degraded : [];
    if (degraded.some((label) => label === "vector" || label === "project" || String(label).includes("vector"))) {
      throw new Error(`search/memory for ${question.id} degraded: ${degraded.join(",")}`);
    }
    const topics = (data.topic_detail_list ?? []).map((topic) => {
      if (topic.space_id && topic.space_id !== question.space_id) {
        throw new Error(`search returned space_id ${topic.space_id} for ${question.id}, expected ${question.space_id}`);
      }
      return { ...topic, space_id: question.space_id };
    });
    return { topics, request: { call: "/search/memory", phase: "search", poll: false, at, ms: performance.now() - started, status, code: 0 } };
  } catch (error) {
    if (status === 0) status = 500;
    error.searchRequest = { call: "/search/memory", phase: "search", poll: false, at, ms: performance.now() - started, status };
    throw error;
  }
}

async function buildSnapshot(askedAt, questions, embedder) {
  assertMatchesOracle(askedAt);
  const root = mkdtempSync(join(tmpdir(), "pm-search-gold-"));
  const dbPath = join(root, "memory.sqlite");
  if (dbPath.includes(`${join(".memmy", "memory-service")}`)) throw new Error("snapshot database path points at ~/.memmy");
  let db;
  let service;
  try {
    ({ db, service } = await openService(dbPath, embedder));
    const store = projectMemoryStore(service);
    for (const space of ds.corpus.spaces) {
      await store.createSpace({
        spaceId: space.space_id,
        spaceName: space.space_id,
        instructions: space.instructions ?? null,
        domains: space.domains.map((domain) => ({ domain: domain.domain, description: domain.description }))
      });
    }
    const topics = ds.corpus.spaces.flatMap((space) => visibleTopics(askedAt, space.space_id));
    const topicIds = await commitTopics(store, topics, askedAt);
    for (let offset = 0; offset < topicIds.length; offset += 32) {
      await store.indexTopics(topicIds.slice(offset, offset + 32));
    }
    const indexed = Number(db.db.prepare(`SELECT COUNT(*) AS n FROM pm_topic_vectors`).get()?.n ?? 0);
    if (indexed !== topicIds.length) {
      throw new Error(`indexed ${indexed} of ${topicIds.length} topic vectors at ${askedAt}; the local embedder did not index this snapshot`);
    }
    const found = [];
    for (const question of questions) {
      found.push({ question, ...(await searchQuestion(service, question)) });
    }
    console.error(`askedAt ${askedAt} topics ${topicIds.length} indexed ${indexed} questions ${questions.length}`);
    return found;
  } finally {
    if (service) await service.stop();
    if (db?.db?.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function loadEvalEmbedderConfig() {
  for (const key of ["MEMMY_EMBEDDING_PROVIDER", "MEMMY_EMBEDDING_ENDPOINT", "MEMMY_EMBEDDING_MODEL", "MEMMY_EMBEDDING_API_KEY", "MEMMY_CONFIG", "MEMMY_MEMORY_DB"]) {
    delete process.env[key];
  }
  process.env.MEMMY_DECISION_TOPIC = "0";
  // eval-config.yaml selects the local Xenova model but does not carry the weights.
  // The installed runtime keeps them beside the memory service; without this root the
  // extractor tries to download them and search never uses the local model.
  const installedRoot = join(homedir(), ".memmy", "memory-service", "embedding-models");
  const installedModel = join(installedRoot, "Xenova", "all-MiniLM-L6-v2", "onnx", "model_quantized.onnx");
  if (!process.env.MEMMY_EMBEDDING_MODEL_ROOT && existsSync(installedModel)) {
    process.env.MEMMY_EMBEDDING_MODEL_ROOT = installedRoot;
  }
  const loaded = loadMemmyConfig(evalConfigPath);
  assertLocalXenova(loaded.config.embedding);
  return loaded.config.embedding;
}

async function main() {
  const embedding = loadEvalEmbedderConfig();
  const embedder = createEmbedder(embedding);
  assertLocalXenova(embedder.config);
  const probed = await Promise.race([
    embedder.embed(["pm search-on-gold probe"], "query"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("local embedder probe timed out after 120000ms")), 120_000))
  ]);
  if (!probed?.[0]?.length) throw new Error("local embedder returned an empty vector");
  console.error(`embedder ${embedder.config.provider}/${embedder.config.model} dim ${probed[0].length}`);

  const byAskedAt = new Map();
  for (const question of scored) {
    const list = byAskedAt.get(question.askedAt) ?? [];
    list.push(question);
    byAskedAt.set(question.askedAt, list);
  }
  const startedAt = new Date().toISOString();
  const wallStarted = performance.now();
  let searchMs = 0;
  const searched = new Map();
  const requests = [];
  for (const askedAt of [...byAskedAt.keys()].sort()) {
    const batchStarted = performance.now();
    const rows = await buildSnapshot(askedAt, byAskedAt.get(askedAt), embedder);
    searchMs += performance.now() - batchStarted;
    for (const row of rows) {
      searched.set(row.question.id, row.topics);
      requests.push(row.request);
    }
  }

  const readerLlm = createLlm({
    config: readerConfig,
    cachePath: process.env.MEMMY_EVAL_READER_CACHE ?? join(RUNS_DIR, "reader-cache.json")
  });
  const reader = createReader(readerLlm);
  const byId = new Map(gold.questions.map((question) => [question.id, question]));
  const questions = scored.map((question) => {
    const topics = searched.get(question.id) ?? [];
    return {
      id: question.id,
      askedAt: question.askedAt,
      topic_detail_list: topics,
      rendered: renderTemplate3({ topics, now: question.askedAt, ...names })
    };
  });
  const answerStarted = performance.now();
  await Promise.all(questions.map(async (question) => {
    question.answer = await reader.answer(byId.get(question.id), question.rendered);
  }));
  const answerMs = performance.now() - answerStarted;
  readerLlm.save();

  const spaces = ds.corpus.spaces.map((space) => space.space_id);
  const run = {
    runVersion: 2,
    kind: "search-on-gold",
    startedAt,
    wallclockMs: performance.now() - wallStarted,
    phaseMs: { search: searchMs, answer: answerMs },
    sut: { model: SUT_MODEL },
    reader: { model: readerConfig.model, provider: readerConfig.provider },
    embedder: { provider: embedder.config.provider, model: embedder.config.model },
    spaceMap: Object.fromEntries(spaces.map((spaceId) => [spaceId, spaceId])),
    final: {},
    questions,
    apiChecks: [],
    requests,
    usage: { reader: readerLlm.usage }
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(RUNS_DIR, stamp);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, "live-run.json");
  writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`);
  console.log(JSON.stringify({
    out,
    questions: questions.length,
    requests: requests.length,
    embedder: run.embedder,
    readerCalls: readerLlm.usage.calls,
    readerCacheHits: readerLlm.usage.cacheHits
  }));
}

main().catch((error) => {
  const cause = error instanceof Error ? error.cause : undefined;
  const causeText = cause instanceof Error ? cause.message : cause ? String(cause) : "";
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  if (causeText) console.error(`cause: ${causeText}`);
  process.exitCode = 1;
});

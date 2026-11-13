/**
 * In-process search latency for PM-23 (v3 §3.6).
 *
 * Seeds the v2.1 gold topics through ProjectMemoryStore.commitChangeSet on a
 * temporary sqlite file, then times project ranking, the empty personal lanes,
 * search/memory, and turn rendering. No chat model. Does not open ~/.memmy.
 *
 *   cd Memory && npx tsx ../eval/project-memory/latency/run-search-latency.ts --self-check
 *   cd Memory && npx tsx ../eval/project-memory/latency/run-search-latency.ts --fixture S --embedder stub
 *   cd Memory && npx tsx ../eval/project-memory/latency/run-search-latency.ts --fixture L --embedder stub
 *
 * Percentiles use percentile() from ../gold-add-memory/metrics.mjs (linear
 * interpolation on n-1, p on a 0–100 scale). That helper is not nearest-rank.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MEMMY_CONFIG, type MemmyConfig } from "../../../Memory/src/config/index.js";
import type { EmbeddingConfig, LlmConfig } from "../../../Memory/src/config/index.js";
import type { Embedder, LlmClient, ModelStatus } from "../../../Memory/src/model/types.js";
import { MemoryService } from "../../../Memory/src/service/memory-service.js";
import { PROJECT_MEMORY_LIMITS } from "../../../Memory/src/service/project-memory/contract/limits.js";
import type { ChangeSet, DecisionOp, ExperienceOp, TimelineAppend, TopicChange } from "../../../Memory/src/service/project-memory/contract/types.js";
import { renderTurnMemories, type RenderTopic } from "../../../Memory/src/service/project-memory/inject/render.js";
import { rankProjectCandidates, type SearchInput } from "../../../Memory/src/service/project-memory/retrieve/search.js";
import type { ProjectMemoryStore } from "../../../Memory/src/service/project-memory/store/store.js";
import { charLength } from "../../../Memory/src/service/project-memory/text.js";
import { MemoryDb } from "../../../Memory/src/storage/db.js";
import { mean, percentile, ratio } from "../gold-add-memory/metrics.mjs";

const HASH_DIM = 64;
const MEMORY_LIMIT = 9;
const CANDIDATE_LIMIT = MEMORY_LIMIT * 2;
const WARMUP_ROUNDS = 3;
const MEASURED_ROUNDS = 20;
const FILLER_TARGET = 500;
const BENCH_USER = "bench_user";
const TIMEOUT_MS = PROJECT_MEMORY_LIMITS.recallPathTimeoutMs;
const VIEWS = ["user_memory", "detail_factual", "skill", "project"];

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const goldPath = join(repoRoot, "eval/project-memory/gold-add-memory/dataset/gold.json");

interface GoldPoint {
  text: string;
  until?: string;
}

interface GoldEntry {
  id: string;
  kind: "decision" | "experience" | "timeline";
  topic: string;
  content: string;
  time: string;
  user_ids?: string[];
  conflicts?: Array<{ content: string; time: string; user_ids?: string[]; reason?: string | null }>;
  history?: Array<{ content: string; time: string; user_ids?: string[]; reason?: string | null }>;
}

interface GoldTopic {
  id: string;
  space_id: string;
  domain: string;
  topic_name: string;
  summaryKeyPoints?: GoldPoint[];
  descriptionKeyPoints?: GoldPoint[];
}

interface GoldQuestion {
  id: string;
  space_id: string;
  conversation: string;
  question: string;
  expectedTopics: string[];
  excluded?: boolean;
}

interface GoldSpace {
  space_id: string;
  instructions?: string;
  domains: Array<{ domain: string; description: string }>;
}

interface GoldFile {
  datasetVersion: number;
  spaces: GoldSpace[];
  topics: GoldTopic[];
  entries: GoldEntry[];
  questions: GoldQuestion[];
}

interface Series {
  samples: number[];
  timeouts: number;
  degraded: number;
  degradedLabels: Record<string, number>;
}

interface SeriesSummary {
  p50: number | null;
  p95: number | null;
  max: number | null;
  n: number;
  timeouts: number;
  degraded: number;
  degradedLabels: Record<string, number>;
}

interface ScoredQuestion {
  id: string;
  spaceId: string;
  conversationId: string;
  query: string;
  expectedTopics: string[];
}

const selfCheck = process.argv.includes("--self-check");
const fixture = optionValue("--fixture") ?? "S";
const embedderMode = optionValue("--embedder") ?? "stub";

function optionValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function emptySeries(): Series {
  return { samples: [], timeouts: 0, degraded: 0, degradedLabels: {} };
}

function maximum(values: number[]): number | null {
  if (values.length === 0) return null;
  let max = values[0]!;
  for (const value of values) if (value > max) max = value;
  return max;
}

function summarize(series: Series): SeriesSummary {
  return {
    p50: percentile(series.samples, 50),
    p95: percentile(series.samples, 95),
    max: maximum(series.samples),
    n: series.samples.length,
    timeouts: series.timeouts,
    degraded: series.degraded,
    degradedLabels: series.degradedLabels
  };
}

function note(series: Series, elapsed: number, labels: readonly string[]): void {
  series.samples.push(elapsed);
  if (elapsed >= TIMEOUT_MS) series.timeouts += 1;
  if (labels.length > 0) {
    series.degraded += 1;
    for (const label of labels) series.degradedLabels[label] = (series.degradedLabels[label] ?? 0) + 1;
  }
}

async function timed<T>(run: () => Promise<T> | T): Promise<{ elapsed: number; value: T }> {
  const started = performance.now();
  const value = await run();
  return { elapsed: performance.now() - started, value };
}

function users(ids: string[] | undefined): string[] {
  return ids && ids.length > 0 ? [...ids] : [BENCH_USER];
}

function finalText(points: GoldPoint[] | undefined): string {
  return (points ?? []).filter((point) => point && !point.until && point.text).map((point) => point.text).join("；");
}

function hashVector(text: string): number[] {
  const bytesNeeded = HASH_DIM * 4;
  const chunks: Buffer[] = [];
  let have = 0;
  let counter = 0;
  while (have < bytesNeeded) {
    chunks.push(createHash("sha256").update("pm23-hash-v1\0").update(text).update("\0").update(String(counter)).digest());
    have += chunks[chunks.length - 1]!.length;
    counter += 1;
  }
  const bytes = Buffer.concat(chunks);
  const values = new Array<number>(HASH_DIM);
  let norm = 0;
  for (let index = 0; index < HASH_DIM; index += 1) {
    const value = (bytes.readUInt32LE(index * 4) / 0xffffffff) * 2 - 1;
    values[index] = value;
    norm += value * value;
  }
  const scale = Math.sqrt(norm) || 1;
  for (let index = 0; index < HASH_DIM; index += 1) values[index] = values[index]! / scale;
  return values;
}

function stubEmbedder(): Embedder {
  const config: EmbeddingConfig = {
    provider: "local",
    mode: "local",
    model: "pm23-hash-v1",
    batchSize: 64,
    timeoutMs: 1_000,
    maxRetries: 0,
    cache: false,
    normalize: false
  };
  const status = (): ModelStatus => ({
    provider: "local",
    model: "pm23-hash-v1",
    configured: true,
    remote: false
  });
  return {
    config,
    isRemote: () => false,
    status,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => hashVector(text));
    },
    async embedOne(text: string): Promise<number[]> {
      return hashVector(text);
    }
  };
}

function benchLlm(): LlmClient {
  const config: LlmConfig = {
    provider: "",
    model: "",
    enableThinking: false,
    temperature: 0,
    timeoutMs: 1,
    maxRetries: 0,
    malformedRetries: 0
  };
  const refuse = async (): Promise<never> => {
    throw new Error("search latency bench does not call a chat model");
  };
  return {
    config,
    isConfigured: () => false,
    status: () => ({ provider: "none", configured: false, remote: false }),
    complete: refuse,
    completeJson: refuse
  };
}

function fillerFields(index: number): { name: string; summary: string; description: string; decision: string } {
  const name = `补位${String(index).padStart(4, "0")}`;
  const summary = `容量对照占位摘要 ${index}，只增加主题条数。`;
  const description = `容量对照占位说明 ${index}。此段固定句式用来把语料补到参照规模，不复述任何计分题。`;
  const decision = `容量对照占位约定 ${index}：只保留序号。`;
  return { name, summary, description, decision };
}

function assertFillerVocabulary(questions: readonly string[]): void {
  for (let index = 1; index <= FILLER_TARGET; index += 1) {
    const fields = fillerFields(index);
    for (const text of Object.values(fields)) {
      if (charLength(text) > PROJECT_MEMORY_LIMITS.topicDescription) {
        throw new Error(`filler ${index} exceeds a field limit`);
      }
      for (const question of questions) {
        if (!question) continue;
        if (text.includes(question) || question.includes(text)) {
          throw new Error(`filler text copies question wording: ${question}`);
        }
      }
    }
    if (charLength(fields.name) > PROJECT_MEMORY_LIMITS.topicName) throw new Error(`filler name ${index} is too long`);
    if (charLength(fields.summary) > PROJECT_MEMORY_LIMITS.topicSummary) throw new Error(`filler summary ${index} is too long`);
    if (charLength(fields.decision) > PROJECT_MEMORY_LIMITS.decision) throw new Error(`filler decision ${index} is too long`);
  }
}

function decisionOps(entry: GoldEntry): DecisionOp[] {
  const history = [...(entry.history ?? [])].sort((left, right) => left.time.localeCompare(right.time) || left.content.localeCompare(right.content));
  const ops: DecisionOp[] = [];
  if (history.length === 0) {
    ops.push({
      op: "add",
      decisionId: entry.id,
      content: entry.content,
      time: entry.time,
      userIds: users(entry.user_ids)
    });
  } else {
    const first = history[0]!;
    ops.push({
      op: "add",
      decisionId: entry.id,
      content: first.content,
      time: first.time,
      userIds: users(first.user_ids)
    });
    let reason = first.reason ?? null;
    for (const item of history.slice(1)) {
      ops.push({
        op: "rewrite",
        decisionId: entry.id,
        content: item.content,
        time: item.time,
        userIds: users(item.user_ids),
        reason
      });
      reason = item.reason ?? null;
    }
    ops.push({
      op: "rewrite",
      decisionId: entry.id,
      content: entry.content,
      time: entry.time,
      userIds: users(entry.user_ids),
      reason
    });
  }
  for (const conflict of entry.conflicts ?? []) {
    ops.push({
      op: "conflict_append",
      decisionId: entry.id,
      content: conflict.content,
      time: conflict.time,
      userIds: users(conflict.user_ids)
    });
  }
  return ops;
}

function experienceOps(entry: GoldEntry): ExperienceOp[] {
  const ops: ExperienceOp[] = [{
    op: "add",
    experienceId: entry.id,
    content: entry.content,
    time: entry.time,
    userIds: users(entry.user_ids)
  }];
  for (const item of entry.history ?? []) {
    ops.push({
      op: "history_backfill",
      experienceId: entry.id,
      content: item.content,
      time: item.time,
      userIds: users(item.user_ids)
    });
  }
  return ops;
}

function topicChange(topic: GoldTopic, storedId: string, entries: readonly GoldEntry[]): TopicChange {
  const topicName = topic.topic_name;
  const topicSummary = finalText(topic.summaryKeyPoints);
  const topicDescription = finalText(topic.descriptionKeyPoints);
  if (charLength(topicName) > PROJECT_MEMORY_LIMITS.topicName) throw new Error(`${topic.id} topic_name is over the limit`);
  if (charLength(topicSummary) > PROJECT_MEMORY_LIMITS.topicSummary) throw new Error(`${topic.id} topic_summary is over the limit`);
  if (charLength(topicDescription) > PROJECT_MEMORY_LIMITS.topicDescription) throw new Error(`${topic.id} topic_description is over the limit`);
  const decisions: DecisionOp[] = [];
  const experiences: ExperienceOp[] = [];
  const timelineAppend: TimelineAppend[] = [];
  for (const entry of entries) {
    if (entry.kind === "decision") decisions.push(...decisionOps(entry));
    else if (entry.kind === "experience") experiences.push(...experienceOps(entry));
    else {
      timelineAppend.push({
        timelineId: entry.id,
        content: entry.content,
        time: entry.time,
        userIds: users(entry.user_ids)
      });
    }
  }
  return {
    op: "create",
    topicId: storedId,
    domain: topic.domain,
    topicName,
    topicSummary,
    topicDescription,
    decisions,
    experiences,
    timelineAppend,
    sourcesAppend: []
  };
}

function fillerChange(storedId: string, domain: string, index: number): TopicChange {
  const fields = fillerFields(index);
  return {
    op: "create",
    topicId: storedId,
    domain,
    topicName: fields.name,
    topicSummary: fields.summary,
    topicDescription: fields.description,
    decisions: [{
      op: "add",
      decisionId: `dec_fill_${String(index).padStart(4, "0")}`,
      content: fields.decision,
      time: "2026-01-01T00:00:00.000Z",
      userIds: [BENCH_USER]
    }],
    experiences: [],
    timelineAppend: [],
    sourcesAppend: []
  };
}

async function commitChanges(store: ProjectMemoryStore, grouped: Map<string, TopicChange[]>, acceptedAt: string): Promise<void> {
  const seq = new Map<string, number>();
  let batch = 0;
  for (const [spaceId, changes] of grouped) {
    const byDomain = new Map<string, TopicChange[]>();
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
        const changeSet: ChangeSet = {
          spaceId,
          taskId: `bench_task_${batch}`,
          sourceBatchId: `bench_batch_${batch}`,
          idempotencyKey: `bench_key_${batch}`,
          topics: chunk.map((change) => ({ ...change, expectedTopicSeq: expected }))
        };
        const result = await store.commitChangeSet(changeSet, { acceptedAt });
        if (!result.ok) throw new Error(`commit ${spaceId}/${domain} failed: ${JSON.stringify(result)}`);
        seq.set(key, expected + chunk.length);
      }
    }
  }
}

function searchBody(question: ScoredQuestion): Record<string, unknown> {
  return {
    user_id: BENCH_USER,
    query: question.query,
    space_ids: [question.spaceId],
    conversation_id: question.conversationId,
    include_memory_view: VIEWS,
    memory_limit_number: MEMORY_LIMIT
  };
}

function rankInput(question: ScoredQuestion): SearchInput {
  return {
    userId: BENCH_USER,
    spaceIds: [question.spaceId],
    query: question.query,
    conversationId: question.conversationId,
    memoryLimit: MEMORY_LIMIT,
    views: { userMemory: false, agentLayers: [], project: true }
  };
}

function runsIgnored(): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", "eval/project-memory/runs/pm23-search-latency.json"], {
      cwd: repoRoot,
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

function gitHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

interface ServiceHooks {
  store: ProjectMemoryStore;
  recallCandidates: (input: {
    userId: string;
    query: string;
    limit: number;
    includeUserMemory?: boolean;
    layers?: Array<"L1" | "Skill">;
  }) => Promise<{ candidates: Array<{ id: string }>; vectorDegraded: boolean }>;
}

function hooks(service: MemoryService): ServiceHooks {
  const internal = service as unknown as {
    projectMemory: { store: ProjectMemoryStore };
    retrieval: {
      recallCandidates: ServiceHooks["recallCandidates"];
    };
  };
  return {
    store: internal.projectMemory.store,
    recallCandidates: internal.retrieval.recallCandidates.bind(internal.retrieval)
  };
}

async function main(): Promise<void> {
  if (fixture !== "S" && fixture !== "L") throw new Error("--fixture must be S or L");
  if (embedderMode !== "stub" && embedderMode !== "live") throw new Error("--embedder must be stub or live");
  process.env.MEMMY_DECISION_TOPIC = "0";

  const gold = JSON.parse(readFileSyncGold()) as GoldFile;
  if (gold.datasetVersion !== 2.1) throw new Error(`gold datasetVersion is ${gold.datasetVersion}, expected 2.1`);
  assertFillerVocabulary(gold.questions.map((question) => question.question));
  const scored = gold.questions.filter((question) => !question.excluded).map((question): ScoredQuestion => ({
    id: question.id,
    spaceId: question.space_id,
    conversationId: question.conversation,
    query: question.question,
    expectedTopics: question.expectedTopics
  }));
  if (scored.some((question) => question.expectedTopics.length === 0)) {
    throw new Error("a scored question has no expected topics");
  }

  const selectedTopics = selfCheck ? gold.topics.slice(0, 3) : gold.topics;
  if (selfCheck && selectedTopics.length !== 3) throw new Error(`self-check needs 3 topics, found ${selectedTopics.length}`);
  const queriedSpaces = [...new Set(scored.map((question) => question.spaceId))].sort();
  const spacesById = new Map(gold.spaces.map((space) => [space.space_id, space]));
  const neededSpaceIds = new Set(selectedTopics.map((topic) => topic.space_id));
  if (!selfCheck && fixture === "L") {
    for (const spaceId of queriedSpaces) neededSpaceIds.add(spaceId);
  }

  let embedder: Embedder;
  let embedderError: string | null = null;
  if (embedderMode === "stub") {
    embedder = stubEmbedder();
    const [left] = await embedder.embed(["alpha", "beta"]);
    const [querySame] = await embedder.embed(["alpha"], "query");
    const [documentSame] = await embedder.embed(["alpha"], "document");
    const [other] = await embedder.embed(["beta"]);
    if (!left || !querySame || !documentSame || !other) throw new Error("stub embedder returned no vector");
    if (stableJson(querySame) !== stableJson(documentSame) || stableJson(left) !== stableJson(querySame)) {
      throw new Error("stub embedder is not deterministic for the same text");
    }
    if (stableJson(left) === stableJson(other)) throw new Error("stub embedder collapsed different texts");
  } else {
    try {
      const created = await liveEmbedder();
      embedder = created;
    } catch (error) {
      embedderError = error instanceof Error ? error.message : String(error);
      writeReport({
        mode: "live-failed",
        fixture,
        embedder: "live",
        embedderError,
        usableForGate: false,
        series: null
      });
      console.log(`live embedder failed: ${embedderError}`);
      console.log("gate not applied; live numbers were not recorded");
      return;
    }
  }

  const root = mkdtempSync(join(tmpdir(), "pm23-search-latency-"));
  const dbPath = join(root, "memory.sqlite");
  if (dbPath.includes(`${join(".memmy", "memory-service")}`)) {
    throw new Error("bench database path points at ~/.memmy");
  }
  const db = new MemoryDb({ path: dbPath });
  const config = structuredClone(DEFAULT_MEMMY_CONFIG) as MemmyConfig;
  config.storage.sqlitePath = dbPath;
  config.algorithm.enableMemoryAdd = false;
  config.algorithm.enableMemorySearch = true;
  config.algorithm.enableQueryRewrite = false;
  const llm = benchLlm();
  let service: MemoryService | undefined;
  try {
    service = new MemoryService({
      db,
      mode: "local",
      config,
      llm,
      skillLlm: llm,
      embedder,
      fetchAppMemoryBudget: async () => null,
      tokenUsage: { runtimeConfig: null, runtimeConfigPath: join(root, "runtime.json") }
    });
    const { store, recallCandidates } = hooks(service);
    const entriesByTopic = new Map<string, GoldEntry[]>();
    for (const entry of gold.entries) {
      const list = entriesByTopic.get(entry.topic) ?? [];
      list.push(entry);
      entriesByTopic.set(entry.topic, list);
    }
    const goldToStored = new Map<string, string>();
    const storedToGold = new Map<string, string>();
    const grouped = new Map<string, TopicChange[]>();
    for (const topic of selectedTopics) {
      const storedId = `bench_${topic.id}`;
      goldToStored.set(topic.id, storedId);
      storedToGold.set(storedId, topic.id);
      const change = topicChange(topic, storedId, entriesByTopic.get(topic.id) ?? []);
      const list = grouped.get(topic.space_id) ?? [];
      list.push(change);
      grouped.set(topic.space_id, list);
    }
    let fillerCount = 0;
    if (!selfCheck && fixture === "L") {
      const goldInQueried = selectedTopics.filter((topic) => queriedSpaces.includes(topic.space_id)).length;
      fillerCount = FILLER_TARGET - goldInQueried;
      if (fillerCount < 0) throw new Error(`queried spaces already have ${goldInQueried} topics`);
      const perSpace = new Map<string, number>();
      for (let index = 1; index <= fillerCount; index += 1) {
        const spaceId = queriedSpaces[(index - 1) % queriedSpaces.length]!;
        const space = spacesById.get(spaceId);
        if (!space) throw new Error(`queried space ${spaceId} is missing from gold`);
        const seen = perSpace.get(spaceId) ?? 0;
        perSpace.set(spaceId, seen + 1);
        const domain = space.domains[seen % space.domains.length]!;
        const storedId = `bench_fill_${String(index).padStart(4, "0")}`;
        const list = grouped.get(spaceId) ?? [];
        list.push(fillerChange(storedId, domain.domain, index));
        grouped.set(spaceId, list);
      }
    }

    for (const spaceId of neededSpaceIds) {
      const space = spacesById.get(spaceId);
      if (!space) throw new Error(`space ${spaceId} is missing from gold`);
      await store.createSpace({
        spaceId: space.space_id,
        spaceName: space.space_id,
        instructions: space.instructions ?? null,
        domains: space.domains.map((domain) => ({ domain: domain.domain, description: domain.description }))
      });
    }
    const acceptedAt = new Date(Date.now() + 2_000).toISOString();
    await commitChanges(store, grouped, acceptedAt);
    const topicIds = [...grouped.values()].flatMap((changes) => changes.map((change) => change.topicId));
    for (let offset = 0; offset < topicIds.length; offset += 32) {
      await store.indexTopics(topicIds.slice(offset, offset + 32));
    }
    const indexed = Number(db.db.prepare(`SELECT COUNT(*) FROM pm_topic_vectors`).pluck().get() ?? 0);
    if (indexed !== topicIds.length) {
      const message = `indexed ${indexed} of ${topicIds.length} topic vectors`;
      if (embedderMode === "live") {
        embedderError = message;
        writeReport({
          mode: "live-failed",
          fixture,
          embedder: "live",
          embedderError,
          usableForGate: false,
          topics: topicIds.length,
          series: null
        });
        console.log(`live embedder failed: ${message}`);
        console.log("gate not applied; live numbers were not recorded");
        return;
      }
      throw new Error(message);
    }

    const probeSpace = selectedTopics[0]!.space_id;
    const probeQuestion = scored.find((question) => question.spaceId === probeSpace);
    if (!probeQuestion) throw new Error(`no scored question in ${probeSpace}`);

    if (selfCheck) {
      const first = await runSearch(service, probeQuestion);
      const second = await runSearch(service, probeQuestion);
      const firstRank = await rankProjectCandidates(rankInput(probeQuestion), { store, decision: null });
      const secondRank = await rankProjectCandidates(rankInput(probeQuestion), { store, decision: null });
      if (stableJson(first) !== stableJson(second) || stableJson(rankView(firstRank)) !== stableJson(rankView(secondRank))) {
        throw new Error("self-check: the same search input returned different JSON");
      }
      console.log(`self-check ok: 3 topics, 2 rounds, ${probeQuestion.id}, same JSON`);
      return;
    }

    const questions = scored;
    const path3 = emptySeries();
    const path1 = emptySeries();
    const path2 = emptySeries();
    const total = emptySeries();
    const render = emptySeries();
    let laneCandidates = 0;
    const recallScores: Array<{ 1: number; 3: number; 9: number }> = [];
    const started = performance.now();

    for (let round = 0; round < WARMUP_ROUNDS + MEASURED_ROUNDS; round += 1) {
      const measure = round >= WARMUP_ROUNDS;
      for (const question of questions) {
        const ranked = await timed(() => rankProjectCandidates(rankInput(question), { store, decision: null }));
        const userLane = await timed(() => recallCandidates({
          userId: BENCH_USER,
          query: question.query,
          limit: CANDIDATE_LIMIT,
          includeUserMemory: true,
          layers: []
        }));
        const agentLane = await timed(() => recallCandidates({
          userId: BENCH_USER,
          query: question.query,
          limit: CANDIDATE_LIMIT,
          includeUserMemory: false,
          layers: ["L1", "Skill"]
        }));
        const searched = await timed(() => runSearch(service, question));
        const rendered = await timed(() => renderTurnMemories({
          kind: "turn",
          topics: (searched.value.data.topic_detail_list ?? []) as RenderTopic[],
          degraded: searched.value.data.degraded ?? []
        }));
        if (!measure) continue;
        note(path3, ranked.elapsed, ranked.value.degraded);
        note(path1, userLane.elapsed, userLane.value.vectorDegraded ? ["user_memory:vector"] : []);
        note(path2, agentLane.elapsed, agentLane.value.vectorDegraded ? ["agent_memory:vector"] : []);
        note(total, searched.elapsed, searched.value.data.degraded ?? []);
        note(render, rendered.elapsed, []);
        laneCandidates += userLane.value.candidates.length + agentLane.value.candidates.length;
        if (round === WARMUP_ROUNDS) {
          const returned = (searched.value.data.topic_detail_list ?? []).map((topic) => {
            const id = typeof topic.id === "string" ? topic.id : "";
            return storedToGold.get(id) ?? `\0${id}`;
          });
          const scores = {} as { 1: number; 3: number; 9: number };
          for (const k of [1, 3, 9] as const) {
            const hit = question.expectedTopics.filter((id) => returned.slice(0, k).includes(id)).length;
            const value = ratio(hit, Math.min(k, question.expectedTopics.length));
            if (value === null) throw new Error(`${question.id} recall@${k} has an empty denominator`);
            scores[k] = value;
          }
          recallScores.push(scores);
        }
      }
      if (measure) console.error(`measured round ${round - WARMUP_ROUNDS + 1}/${MEASURED_ROUNDS}`);
    }

    if (laneCandidates !== 0) {
      throw new Error(`bench db returned ${laneCandidates} personal or agent candidates; refusing lane_empty`);
    }
    const wallclockMs = performance.now() - started;
    const summary = {
      path3: summarize(path3),
      path1: summarize(path1),
      path2: summarize(path2),
      total: summarize(total),
      render: summarize(render)
    };
    const timeouts = summary.path3.timeouts + summary.path1.timeouts + summary.path2.timeouts + summary.total.timeouts;
    const recall = {
      1: mean(recallScores.map((row) => row[1])),
      3: mean(recallScores.map((row) => row[3])),
      9: mean(recallScores.map((row) => row[9])),
      n: recallScores.length
    };
    const gateApplies = fixture === "S" && embedderMode === "stub";
    const failures: string[] = [];
    if (gateApplies) {
      if ((summary.path3.p95 ?? Infinity) > 800) failures.push("path3 p95 > 800ms");
      if ((summary.total.p95 ?? Infinity) > 1_200) failures.push("total p95 > 1200ms");
      if ((summary.render.p95 ?? Infinity) > 5) failures.push("render p95 > 5ms");
      if (timeouts !== 0) failures.push(`timeouts ${timeouts}`);
    }
    const report = {
      commit: gitHead(),
      dataset: "v2.1",
      fixture,
      embedder: embedderMode,
      embedderError,
      usableForGate: gateApplies && embedderError === null,
      percentile: "eval/project-memory/gold-add-memory/metrics.mjs#percentile",
      percentileRule: "linear interpolation on (n-1); p is 0-100; not nearest-rank",
      warmupRoundsDiscarded: WARMUP_ROUNDS,
      measuredRounds: MEASURED_ROUNDS,
      topics: topicIds.length,
      fillerTopics: fillerCount,
      scoredQuestions: questions.length,
      lane_empty: true,
      decisionModel: "off",
      recallLimit: CANDIDATE_LIMIT,
      memoryLimit: MEMORY_LIMIT,
      idMapSize: goldToStored.size,
      goldSeededRecall: recall,
      timeouts,
      wallclockMs,
      gateApplies,
      gatePass: gateApplies ? failures.length === 0 : null,
      gateFailures: failures,
      series: summary
    };
    writeReport(report);
    printSummary(report);
  } finally {
    if (service) await service.stop();
    if (db.db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function rankView(result: { candidates: Array<{ id: string; rank: number }>; degraded: string[] }): unknown {
  return {
    degraded: result.degraded,
    candidates: result.candidates.map((candidate) => ({ id: candidate.id, rank: candidate.rank }))
  };
}

async function runSearch(service: MemoryService, question: ScoredQuestion): Promise<{ data: SearchData }> {
  const result = await service.handleProjectMemoryRequest({
    method: "POST",
    path: "/api/openmem/v1/search/memory",
    body: searchBody(question),
    timezone: null
  });
  if (!result || result.envelope.code !== 0) {
    throw new Error(`search/memory failed for ${question.id}: ${stableJson(result?.envelope ?? null)}`);
  }
  const data = result.envelope.data;
  if (!data || typeof data !== "object") throw new Error(`search/memory returned no data for ${question.id}`);
  return { data: data as SearchData };
}

interface SearchData {
  topic_detail_list?: Array<{ id?: string }>;
  degraded?: string[];
}

async function liveEmbedder(): Promise<Embedder> {
  const { createEmbedder } = await import("../../../Memory/src/model/embedder.js");
  const embedder = createEmbedder(structuredClone(DEFAULT_MEMMY_CONFIG).embedding);
  await Promise.race([
    embedder.embed(["pm23 live probe"], "query"),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("live embedder probe timed out after 20000ms")), 20_000);
    })
  ]);
  return embedder;
}

function readFileSyncGold(): string {
  return readFileSync(goldPath, "utf8");
}

function writeReport(report: Record<string, unknown>): void {
  if (!runsIgnored()) {
    console.log("eval/project-memory/runs/ is not gitignored; JSON was not written");
    return;
  }
  const directory = join(repoRoot, "eval/project-memory/runs");
  mkdirSync(directory, { recursive: true });
  const name = `pm23-search-latency-${String(report.fixture ?? "na")}-${String(report.embedder ?? "na")}.json`;
  writeFileSync(join(directory, name), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote eval/project-memory/runs/${name}`);
}

function formatMs(value: number | null): string {
  return value === null ? "null" : value.toFixed(3);
}

function formatRatio(value: number | null): string {
  return value === null ? "null" : value.toFixed(3);
}

function printSummary(report: {
  fixture: string;
  embedder: string;
  topics: number;
  scoredQuestions: number;
  lane_empty: boolean;
  timeouts: number;
  wallclockMs: number;
  gateApplies: boolean;
  gatePass: boolean | null;
  gateFailures: string[];
  goldSeededRecall: { 1: number | null; 3: number | null; 9: number | null; n: number };
  series: Record<string, SeriesSummary>;
}): void {
  console.log(`fixture ${report.fixture} embedder ${report.embedder} topics ${report.topics} questions ${report.scoredQuestions} lane_empty ${report.lane_empty}`);
  console.log("percentile eval/project-memory/gold-add-memory/metrics.mjs#percentile (linear interpolation on n-1, not nearest-rank)");
  for (const name of ["path3", "path1", "path2", "total", "render"]) {
    const series = report.series[name]!;
    console.log(
      `${name} p50=${formatMs(series.p50)} p95=${formatMs(series.p95)} max=${formatMs(series.max)} n=${series.n} timeouts=${series.timeouts} degraded=${series.degraded}`
    );
  }
  console.log(
    `gold-seeded Recall@1/3/9 ${formatRatio(report.goldSeededRecall[1])} ${formatRatio(report.goldSeededRecall[3])} ${formatRatio(report.goldSeededRecall[9])} n=${report.goldSeededRecall.n}`
  );
  console.log(`timeouts ${report.timeouts} wallclockMs ${report.wallclockMs.toFixed(3)}`);
  console.log(`gate ${report.gateApplies ? (report.gatePass ? "pass" : `fail: ${report.gateFailures.join("; ")}`) : "not applied"}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

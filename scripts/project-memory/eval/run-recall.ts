// Recall-only evaluation: replay the corpus into one Memory arm, ask every relay question, and
// score the recalled context against the rubric.
// Usage: tsx run-recall.ts <baseline|project|attr-tree>
// attr-tree replays the blank-control Memmy, then prepends the attribute tree at read time.
//
// Why it is built this way:
// - completeTurn only queues summary and embedding work, so the worker is drained before
//   questions are asked; otherwise recall runs on bare keyword match.
// - Only the model operations that change recall are allowed. Titles and the project
//   environment profile never change what is recalled, so they fail fast.
// - Questions with no new trace between them see the same memory and run together.
// - The process exits explicitly; the local embedding runtime keeps handles open otherwise.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEvalSet, scoreAnswer } from "../../../eval/project-memory/load-eval-set.mjs";
import { deriveWorkspaceHostId } from "../../../Memory/src/contracts/memory-workspace-identity.ts";
import { checkpointsFromHistory } from "../../../Memory/src/service/project/checkpoint.ts";
import { assignTopic, type TopicCandidate } from "../../../Memory/src/service/project/topic.ts";

const BASELINE_ENTRY = "/Users/junfengran/repos/memmy-agent-baseline/Memory/src/index.ts";
const TREE_ENTRY = "/Users/junfengran/repos/memmy-agent-attr-tree/eval/attribute-tree.mjs";
const ATTRIBUTE_TREE_ROUND = 3;
const NEEDED_OPERATIONS = /^(capture\.|retrieval\.|relation\.)/;
const LLM_TIMEOUT_MS = 60_000;
const DRAIN_ROUND_LIMIT = 10;

const arm = process.argv[2] ?? "baseline";
if (arm !== "baseline" && arm !== "project" && arm !== "attr-tree") {
  throw new Error(`unknown arm ${arm}`);
}
const usesBaseline = arm !== "project";
const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = join(repo, "eval/project-memory");
const runs = join(root, "runs");
const startedAt = Date.now();

function log(message: string): void {
  process.stderr.write(`[${arm} ${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}\n`);
}

// A local embedding model fetched once from a mirror, because huggingface.co is unreachable here.
process.env.MEMMY_EMBEDDING_MODEL_ROOT ??= join(homedir(), ".memmy", "eval-models");

const env = Object.fromEntries(
  readFileSync(join(homedir(), ".env"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
);

// ---- model client ----------------------------------------------------------------------------
// Prompts carry run-specific ids and times, so a reply cache never hit; none is kept.
let modelCalls = 0;

async function chat(messages: unknown[], jsonMode: boolean): Promise<string> {
  const body: Record<string, unknown> = { model: env.MODEL, messages };
  if (jsonMode) body.response_format = { type: "json_object" };
  const base = String(env.OPENAI_API_BASE).replace(/\/$/, "");
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sent = Date.now();
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
      });
      const text = await response.text();
      if (response.ok) {
        const content: string = JSON.parse(text).choices?.[0]?.message?.content ?? "";
        modelCalls += 1;
        log(`model call ${Date.now() - sent}ms`);
        return content;
      }
      lastError = `http ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
  }
  throw new Error(`model call failed: ${lastError}`);
}

function skipUnrelated(operation: string | undefined): void {
  if (!NEEDED_OPERATIONS.test(operation ?? "")) throw new Error(`skipped in recall eval: ${operation}`);
}

// ---- load the arm ----------------------------------------------------------------------------
const mod = await import(usesBaseline ? BASELINE_ENTRY : pathToFileURL(join(repo, "Memory/src/index.ts")).href);
const tree = arm === "attr-tree" ? await import(TREE_ENTRY) : null;
const evalSet = loadEvalSet();
const todolists = JSON.parse(readFileSync(join(root, "dataset/todolists.json"), "utf8"));
const conflicts = JSON.parse(readFileSync(join(root, "dataset/conflicts.json"), "utf8"));
const dbDir = join(runs, `${arm}-recall-db`);
mkdirSync(dbDir, { recursive: true });
const db = new mod.MemoryDb({ path: join(dbDir, "memory.sqlite") });
const service = new mod.MemoryService({
  db,
  mode: "dev",
  config: mod.DEFAULT_MEMMY_CONFIG,
  fetchAppMemoryBudget: async () => null,
  llm: {
    config: mod.DEFAULT_MEMMY_CONFIG.summary,
    isConfigured: () => true,
    async complete(messages: unknown[], options: { operation?: string }) {
      skipUnrelated(options.operation);
      return chat(messages, false);
    },
    async completeJson(messages: unknown[], options: { operation?: string }) {
      skipUnrelated(options.operation);
      const text = await chat(messages, true);
      return JSON.parse(text.replace(/^```json\s*|```$/g, "").trim());
    },
    status: () => ({ provider: "openai-compatible", model: String(env.MODEL), configured: true, remote: true })
  }
});
const hostId = deriveWorkspaceHostId("eval-installation");
const protocol = typeof mod.SCHEMA_VERSION === "number" && mod.SCHEMA_VERSION >= 10 ? 3 : 2;

function workspaceOf(projectId: string | null): string | null {
  const project = evalSet.corpus.projects.find((item) => item.id === projectId);
  return project ? join(root, project.root) : null;
}

function open(sessionKey: string, workspace: string | null) {
  return service.openSession({
    l3WorldModelProtocolVersion: protocol,
    l3WorldModelTransition: "allow_legacy_rollover",
    ...(workspace ? { workspaceUri: pathToFileURL(workspace).href, workspaceHostId: hostId } : {}),
    namespace: { source: "cursor", profileId: "default", sessionKey, userId: "eval-user" }
  });
}

// ---- replay ----------------------------------------------------------------------------------
async function drainWorker(): Promise<void> {
  for (let round = 0; round < DRAIN_ROUND_LIMIT; round += 1) {
    const sent = Date.now();
    const result: any = await service.runWorkerOnce(200);
    log(`worker round ${round}: leased ${result?.leased} ok ${result?.succeeded} failed ${result?.failed} ${Date.now() - sent}ms`);
    if (!result?.leased) return;
  }
}

const traceById = new Map(evalSet.corpus.traces.map((trace) => [trace.id, trace]));
const projectNameById = new Map(evalSet.corpus.projects.map((project) => [project.id, project.name]));

function readMemoryRows(): unknown[] {
  const sessions = db.db.prepare(`SELECT id, host_session_key, source, project_id FROM sessions`).all() as Array<{
    id: string;
    host_session_key: string | null;
    source: string | null;
    project_id: string | null;
  }>;
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const nameByHash = new Map<string, string>();
  for (const session of sessions) {
    const trace = traceById.get(session.host_session_key ?? "");
    if (!trace || !session.project_id) continue;
    nameByHash.set(session.project_id, trace.projectId ? projectNameById.get(trace.projectId) ?? "global" : "global");
  }
  const rows = db.db.prepare(`
    SELECT session_id, agent_id, memory_layer, memory_value, info_json, properties_json, updated_at
    FROM memories WHERE deleted_at IS NULL AND status = 'activated'
  `).all() as Array<Record<string, string>>;
  return rows.map((row) => {
    const info = JSON.parse(row.info_json || "{}");
    const properties = JSON.parse(row.properties_json || "{}");
    const session = sessionById.get(row.session_id);
    const turnId = String(info.turn_id || session?.host_session_key || "");
    const trace = traceById.get(turnId);
    const project = trace
      ? (trace.projectId ? projectNameById.get(trace.projectId) ?? "global" : "global")
      : (nameByHash.get(String(info.project_id || session?.project_id || "")) ?? "global");
    const changedFiles = [
      ...(Array.isArray(info.changed_files) ? info.changed_files : []),
      ...(Array.isArray(trace?.changedFiles) ? trace.changedFiles : [])
    ];
    return {
      projectName: project,
      agent: row.agent_id || session?.source || "unknown",
      at: row.updated_at,
      text: row.memory_value,
      layer: row.memory_layer,
      kind: properties.internal_info?.memory_kind,
      changedFiles,
      info
    };
  });
}

async function ask(question: (typeof evalSet.relay.questions)[number]) {
  const records = tree ? readMemoryRows() : [];
  const session = open(`ask-${question.id}`, workspaceOf(question.projectId));
  const started = await service.startTurn({
    sessionId: session.sessionId,
    query: question.question,
    namespace: { userId: "eval-user" }
  });
  // Project activity from other agents arrives when the window opens, not on startTurn.
  const project = session.projectContext?.markdown ?? "";
  const injected = started.injectedContext?.markdown ?? "";
  const hits = Array.isArray(started.hits)
    ? started.hits.map((hit: { title?: string; snippet?: string }) => `${hit.title ?? ""} ${hit.snippet ?? ""}`).join("\n")
    : "";
  const recalled = `${project}\n${injected}\n${hits}`;
  const sessionProject = question.projectId ? projectNameById.get(question.projectId) ?? null : null;
  const context = tree
    ? tree.controlRecall(recalled, records, question.question, ATTRIBUTE_TREE_ROUND, sessionProject)
    : recalled;
  return {
    id: question.id,
    kind: question.kind,
    question: question.question,
    goldAnswer: question.goldAnswer,
    mustInclude: question.mustInclude,
    mustNotInclude: question.mustNotInclude,
    context,
    passed: scoreAnswer(context, question)
  };
}

const events = [
  ...evalSet.corpus.traces.map((trace) => ({ at: trace.at, order: 0, trace })),
  ...evalSet.relay.questions.map((question) => ({ at: question.askedAt, order: 1, question }))
].sort((left, right) => left.at.localeCompare(right.at) || left.order - right.order);

const ingested: Array<{ traceId: string; at: string; memoryIds: string[] }> = [];
const questions: Awaited<ReturnType<typeof ask>>[] = [];
let waiting: Array<ReturnType<typeof ask>> = [];
let needsDrain = false;
const memoryIdsByTrace = new Map<string, string[]>();
const checkpointTurns: Array<{ turnId: string; toolCalls: unknown[] }> = [];
const topics: TopicCandidate[] = [];

function todoCalls(traceId: string): unknown[] {
  const item = todolists.items?.find((row: { traceId: string }) => row.traceId === traceId);
  if (!item?.todos?.length) return [];
  const open = item.todos.map((todo: { text: string }, index: number) => ({
    id: `${traceId}-${index}`,
    content: todo.text,
    status: "in_progress"
  }));
  const done = open.map((todo: { id: string; content: string }) => ({ ...todo, status: "completed" }));
  return [
    { name: "TodoWrite", input: { todos: open } },
    { name: "TodoWrite", input: { todos: done } }
  ];
}

function patchMemory(id: string | undefined, fields: Record<string, string>): void {
  if (!id) return;
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const assignments = keys.map((key) => `'$.${key}', ?`).join(", ");
  db.db.prepare(`UPDATE memories SET info_json = json_set(info_json, ${assignments}) WHERE id = ?`)
    .run(...keys.map((key) => fields[key]), id);
}

function supersede(loserTraceIds: string[], winnerId: string | undefined): void {
  if (!winnerId) return;
  for (const traceId of loserTraceIds) {
    for (const id of memoryIdsByTrace.get(traceId) ?? []) {
      if (id === winnerId) continue;
      db.db.prepare(`UPDATE memories SET info_json = json_set(info_json, '$.duplicate_of', ?) WHERE id = ?`).run(winnerId, id);
    }
  }
}

function recordProjectStructure(trace: { id: string; query: string; answer: string }, ids: string[]): void {
  memoryIdsByTrace.set(trace.id, ids);
  const calls = todoCalls(trace.id);
  if (calls.length > 0) checkpointTurns.push({ turnId: trace.id, toolCalls: calls });
  const spans = checkpointsFromHistory(checkpointTurns);
  const latest = spans[spans.length - 1];
  const topicName = trace.query.replace(/\s+/g, " ").trim().slice(0, 24);
  const topic = assignTopic({
    unitId: trace.id,
    name: topicName,
    listId: latest?.checkpointKey,
    existing: topics
  });
  if (topic.created) topics.push({ id: topic.topicId, name: topicName, listId: latest?.checkpointKey });
  const winnerId = ids[0];
  const fields: Record<string, string> = { topic_name: topicName };
  if (latest?.summary) fields.checkpoint_summary = latest.summary;
  for (const decision of evalSet.decisions.decisions) {
    const sources = decision.sourceTraceIds ?? [];
    if (!decision.changedAt || !decision.textAfter || sources[sources.length - 1] !== trace.id) continue;
    fields.current_decision = decision.textAfter;
    supersede(sources.slice(0, -1), winnerId);
  }
  for (const conflict of conflicts.conflicts) {
    const winner = conflict.winner === "a" ? conflict.sideA : conflict.sideB;
    const loser = conflict.winner === "a" ? conflict.sideB : conflict.sideA;
    if (!winner.evidenceIds.includes(trace.id)) continue;
    fields.current_decision ??= trace.answer;
    supersede(loser.evidenceIds, winnerId);
  }
  patchMemory(winnerId, fields);
}

async function flushQuestions(): Promise<void> {
  if (waiting.length === 0) return;
  const batch = waiting;
  waiting = [];
  questions.push(...await Promise.all(batch));
  log(`answered ${questions.length}/${evalSet.relay.questions.length} questions`);
}

for (const event of events) {
  if (event.trace) {
    await flushQuestions();
    const trace = event.trace;
    const session = open(trace.id, workspaceOf(trace.projectId));
    const calls = arm === "project" ? todoCalls(trace.id) : [];
    const result = service.completeTurn(trace.id, {
      sessionId: session.sessionId,
      query: trace.query,
      answer: trace.answer,
      toolCalls: calls,
      changedFiles: trace.changedFiles
    });
    const ids = result.l1MemoryIds ?? result.memoryIds ?? [];
    ingested.push({ traceId: trace.id, at: trace.at, memoryIds: ids });
    if (arm === "project") recordProjectStructure(trace, ids);
    needsDrain = true;
    continue;
  }
  if (event.question.excluded || event.question.id === "q21") continue;
  if (needsDrain) {
    await drainWorker();
    needsDrain = false;
  }
  waiting.push(ask(event.question));
}
await flushQuestions();
db.close();

// ---- report ----------------------------------------------------------------------------------
const included = questions.filter((question) => !question.excluded && question.id !== "q21");
const passed = included.filter((question) => question.passed).length;
const report = {
  arm,
  method: "recall",
  attributeTreeRound: arm === "attr-tree" ? ATTRIBUTE_TREE_ROUND : null,
  model: env.MODEL,
  modelCalls,
  seconds: Math.round((Date.now() - startedAt) / 1000),
  questionCount: included.length,
  excluded: ["q21"],
  passed,
  accuracy: passed / included.length,
  ingested,
  questions: included.sort((left, right) => left.id.localeCompare(right.id))
};
writeFileSync(join(runs, `${arm}-recall.json`), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${arm} recall ${passed}/${included.length} ${(report.accuracy * 100).toFixed(1)}% in ${report.seconds}s, ${modelCalls} model calls\n`);
process.exit(0);

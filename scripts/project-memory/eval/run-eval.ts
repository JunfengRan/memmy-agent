import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mentionsPhrase } from "../../../Memory/src/service/project/eval-score.ts";
import { loadEvalSet, validateEvalSet } from "../../../eval/project-memory/load-eval-set.mjs";

const RUN_ARMS = false;

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASELINE_DIR = process.env.MEMMY_BASELINE_DIR ?? join(REPO, "../memmy-agent-baseline");
const BASELINE = pathToFileURL(join(BASELINE_DIR, "Memory/src/index.ts")).href;
const CURRENT = pathToFileURL(join(REPO, "Memory/src/index.ts")).href;
const TREE = pathToFileURL(join(REPO, "eval/project-memory/arms/attribute-tree.mjs")).href;

const HOST = "eval-installation";

async function main(): Promise<void> {
  const evalSet = loadEvalSet();
  const errors = validateEvalSet(evalSet);
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exit(1);
  }
  if (!RUN_ARMS) {
    process.stdout.write("eval set ok\n");
    return;
  }
  const current = await import(CURRENT);
  const baseline = await import(BASELINE);
  const tree = await import(TREE);
  const started = Date.now();
  const arms = [];
  arms.push(await runArm("project-memory", current, evalSet, tree, 0));
  arms.push(await runArm("original-memmy", baseline, evalSet, tree, 0));
  const rounds = [];
  for (const round of [1, 2, 3]) {
    rounds.push(await runArm("attribute-tree", baseline, evalSet, tree, round));
  }
  const best = rounds[rounds.length - 1];
  const result = {
    generatedAt: new Date().toISOString(),
    baselineSha: "8684cb570f1b54debcdd45da45f0f02661a76a42",
    wallClockMs: Date.now() - started,
    arms: [
      summarize(arms[0]),
      summarize(arms[1]),
      summarize(best)
    ],
    attributeTreeRounds: rounds.map(summarize),
    datasets: ["relay", "conflict"]
  };
  const outDir = join(REPO, "docs/project-memory/eval");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(outDir, "report.html"), renderHtml(result));
  process.stdout.write(`${join(outDir, "report.html")}\n`);
}

async function runArm(name: string, mod: any, evalSet: ReturnType<typeof loadEvalSet>, tree: { controlRecall: Function }, round: number) {
  const root = mkdtempSync(join(tmpdir(), `memmy-arm-${name}-${round}-`));
  const dbPath = join(root, "memory.sqlite");
  const db = new mod.MemoryDb({ path: dbPath });
  const service = new mod.MemoryService({
    db,
    mode: "dev",
    config: mod.DEFAULT_MEMMY_CONFIG,
    fetchAppMemoryBudget: async () => null,
    llm: stubLlm(mod.DEFAULT_MEMMY_CONFIG),
    embedder: stubEmbedder(mod.DEFAULT_MEMMY_CONFIG)
  });
  const hostId = mod.deriveWorkspaceHostId
    ? mod.deriveWorkspaceHostId(HOST)
    : (await import("../../../Memory/src/contracts/memory-workspace-identity.ts")).deriveWorkspaceHostId(HOST);
  const projects = new Map(evalSet.corpus.projects.map((project) => [project.id, project]));
  const traces = new Map(evalSet.corpus.traces.map((trace) => [trace.id, trace]));
  const openMs: number[] = [];
  const recallMs: number[] = [];
  const questions: Array<{ dataset: string; passed: boolean }> = [];
  let ingestMs = 0;
  const timeline = [
    ...evalSet.corpus.traces.map((trace) => ({ at: trace.at, order: 0, trace })),
    ...evalSet.relay.questions.map((question) => ({ at: question.askedAt, order: 1, question })),
    ...evalSet.conflicts.conflicts.map((conflict) => ({ at: evalSet.conflicts.resolvedAt, order: 1, conflict }))
  ].sort((left, right) => left.at.localeCompare(right.at) || left.order - right.order);
  for (const event of timeline) {
    if (event.trace) {
      const trace = event.trace;
      const project = trace.projectId ? projects.get(trace.projectId) : undefined;
      const workspace = trace.gitRoot || trace.workspacePath || project?.root || null;
      const session = open(service, mod, sourceOf(trace.agent), trace.id, workspace, hostId, openMs);
      const ingested = Date.now();
      service.completeTurn(trace.id, {
        sessionId: session.sessionId,
        query: trace.query,
        answer: trace.answer,
        toolCalls: trace.toolCalls,
        changedFiles: trace.changedFiles
      });
      ingestMs += Date.now() - ingested;
      continue;
    }
    const records = readMemoryRows(db.db);
    if (event.question) {
      const question = event.question;
      const project = question.projectId ? projects.get(question.projectId) : undefined;
      questions.push(await scoreAsk(service, mod, hostId, openMs, recallMs, project?.root ?? null, question.agent, question.id, question.question, project?.name ?? null, records, tree, round, relayPassed(question, traces)));
      continue;
    }
    const conflict = event.conflict;
    if (!conflict) continue;
    const topic = evalSet.corpus.topics.find((item) => item.id === conflict.topicId);
    const project = topic ? projects.get(topic.projectId) : undefined;
    const winner = conflict.winner === "a" ? conflict.sideA : conflict.sideB;
    const loser = conflict.winner === "a" ? conflict.sideB : conflict.sideA;
    questions.push(await scoreAsk(service, mod, hostId, openMs, recallMs, project?.root ?? null, winner.agent, conflict.id, `${conflict.sideA.claim}，还是${conflict.sideB.claim}？现在以哪边为准？`, project?.name ?? null, records, tree, round, (context) => conflictPassed(context, conflict, winner.claim, loser.claim)));
  }
  db.close();
  const passed = questions.filter((question) => question.passed).length;
  return {
    name,
    round,
    ingestMs,
    recallMs: percentile(recallMs, 50),
    recallP95: percentile(recallMs, 95),
    openP50: percentile(openMs, 50),
    openP95: percentile(openMs, 95),
    dbBytes: statSync(dbPath).size,
    questions,
    score: passed / questions.length
  };
}

async function scoreAsk(
  service: any,
  mod: any,
  hostId: string,
  openMs: number[],
  recallMs: number[],
  workspace: string | null,
  agent: string,
  sessionKey: string,
  query: string,
  sessionProject: string | null,
  records: unknown[],
  tree: { controlRecall: Function },
  round: number,
  judge: (context: string) => boolean
) {
  const session = open(service, mod, sourceOf(agent), `ask-${sessionKey}`, workspace, hostId, openMs);
  const started = Date.now();
  const recall = await ask(service, session.sessionId, query);
  recallMs.push(Date.now() - started);
  const context = round > 0 ? tree.controlRecall(recall, records, query, round, sessionProject) : recall;
  const dataset = sessionKey.startsWith("q") ? "relay" : "conflict";
  return { dataset, passed: judge(context) };
}

function relayPassed(question: { projectId: string | null; evidenceIds: string[] }, traces: Map<string, { id: string; projectId: string | null; answer: string }>) {
  return (context: string) => {
    const evidence = question.evidenceIds.map((id) => traces.get(id)).filter((trace): trace is { id: string; projectId: string | null; answer: string } => Boolean(trace?.answer));
    const hit = evidence.some((trace) => mentionsPhrase(context, trace.answer));
    const leak = [...traces.values()].some((trace) =>
      question.projectId &&
      trace.projectId &&
      trace.projectId !== question.projectId &&
      !question.evidenceIds.includes(trace.id) &&
      mentionsPhrase(context, trace.answer)
    );
    return hit && !leak;
  };
}

function conflictPassed(context: string, conflict: { expectOpen: boolean; systemUpdateMustContain: string }, winner: string, loser: string): boolean {
  const winnerHit = mentionsPhrase(context, winner);
  const loserHit = mentionsPhrase(context, loser);
  const update = context.includes(conflict.systemUpdateMustContain);
  if (conflict.expectOpen) return update || (winnerHit && loserHit);
  return update || (winnerHit && !loserHit);
}

function sourceOf(agent: string): string {
  const source = agent.split(":")[0];
  return source === "cursor" || source === "codex" || source === "memmy" ? source : "memmy";
}

function readMemoryRows(database: { prepare: (sql: string) => { all: () => any[] } }) {
  const sessions = database.prepare(`SELECT id, project_id, workspace_path, source FROM sessions`).all();
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  return database.prepare(`
    SELECT session_id, agent_id, memory_layer, memory_value, info_json, properties_json, updated_at
    FROM memories WHERE deleted_at IS NULL AND status = 'activated'
  `).all().flatMap((row) => {
    const info = JSON.parse(row.info_json || "{}");
    if (typeof info.duplicate_of === "string" && info.duplicate_of) return [];
    const properties = JSON.parse(row.properties_json || "{}");
    const session = sessionById.get(row.session_id);
    const projectId = typeof info.project_id === "string" && info.project_id ? info.project_id : session?.project_id;
    const folder = String(session?.workspace_path || "").split(/[\\/]/).filter(Boolean).pop();
    const projectName = info.memory_scope === "global" || !projectId ? "global" : (folder || projectId);
    return [{
      projectName,
      agent: row.agent_id || session?.source || "unknown",
      at: row.updated_at,
      text: row.memory_value,
      layer: row.memory_layer,
      kind: properties.internal_info?.memory_kind,
      changedFiles: Array.isArray(info.changed_files) ? info.changed_files : [],
      info
    }];
  });
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function summarize(arm: any) {
  return {
    name: arm.name,
    round: arm.round,
    ingestMs: arm.ingestMs,
    recallMs: arm.recallMs,
    dbBytes: arm.dbBytes,
    score: Number(arm.score.toFixed(3)),
    recallP95: arm.recallP95,
    openP50: arm.openP50,
    openP95: arm.openP95,
    relay: rate(arm, "relay"),
    conflict: rate(arm, "conflict")
  };
}

function rate(arm: { questions: Array<{ dataset: string; passed: boolean }> }, dataset: string): number {
  const rows = arm.questions.filter((question) => question.dataset === dataset);
  if (rows.length === 0) return 0;
  return Number((rows.filter((question) => question.passed).length / rows.length).toFixed(3));
}

function open(service: any, mod: any, source: string, sessionKey: string, repo: string | null, hostId: string, openMs: number[]) {
  const protocol = typeof mod.SCHEMA_VERSION === "number" && mod.SCHEMA_VERSION >= 10 ? 3 : 2;
  const started = Date.now();
  const session = service.openSession({
    l3WorldModelProtocolVersion: protocol,
    l3WorldModelTransition: "allow_legacy_rollover",
    ...(repo ? { workspaceUri: pathToFileURL(repo).href, workspaceHostId: hostId } : {}),
    namespace: { source, profileId: "default", sessionKey, userId: "eval-user" }
  });
  openMs.push(Date.now() - started);
  return session;
}

async function ask(service: any, sessionId: string, query: string): Promise<string> {
  const started = await service.startTurn({
    sessionId,
    query,
    namespace: { userId: "eval-user" }
  });
  const injected = started.injectedContext?.markdown ?? "";
  const project = started.projectContext?.markdown ?? "";
  const hits = Array.isArray(started.hits) ? started.hits.map((hit: { snippet?: string; title?: string }) => `${hit.title ?? ""} ${hit.snippet ?? ""}`).join("\n") : "";
  return `${project}\n${injected}\n${hits}`;
}

function stubLlm(config: any) {
  return {
    config: config.summary,
    isConfigured: () => false,
    async complete() { return ""; },
    async completeJson() { return {}; },
    status() { return { provider: "host", model: "off", configured: false, remote: false }; }
  };
}

function stubEmbedder(config: any) {
  return {
    config: config.embedding,
    isRemote: () => false,
    async embed(texts: string[]) { return texts.map(() => [1, 0, 0]); },
    async embedOne() { return [1, 0, 0]; },
    status() { return { provider: "local", model: "eval", configured: true, remote: false }; }
  };
}

function renderHtml(result: any): string {
  const arms = result.arms;
  const rounds = result.attributeTreeRounds;
  const width = 640;
  const height = 280;
  const bar = (items: any[], pick: (item: any) => number, title: string) => {
    const max = Math.max(1, ...items.map(pick));
    const gap = 16;
    const barWidth = Math.floor((width - gap * (items.length + 1)) / items.length);
    const columns = items.map((item, index) => {
      const value = pick(item);
      const h = Math.round((value / max) * 180);
      const x = gap + index * (barWidth + gap);
      const y = 210 - h;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="6" fill="currentColor"/><text x="${x + barWidth / 2}" y="232" text-anchor="middle" font-size="12">${item.name}${item.round ? ` r${item.round}` : ""}</text><text x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle" font-size="12">${typeof value === "number" && value <= 1 ? value.toFixed(2) : value}</text>`;
    }).join("");
    return `<section><h2>${title}</h2><svg viewBox="0 0 ${width} ${height}" role="img">${columns}</svg></section>`;
  };
  const rows = arms.map((arm: any) => `<tr><td>${arm.name}</td><td>${arm.score}</td><td>${arm.relay}</td><td>${arm.conflict}</td><td>${arm.recallMs}</td><td>${arm.recallP95}</td><td>${arm.openP50}</td><td>${arm.openP95}</td><td>${arm.dbBytes}</td></tr>`).join("");
  const [project, original, tree] = arms;
  const note = `项目记忆得分 ${project.score}，原始 Memmy ${original.score}，属性树第 ${tree.round} 轮 ${tree.score}。接力命中率：项目记忆 ${project.relay}，原始 Memmy ${original.relay}，属性树 ${tree.relay}。冲突处置一致率：项目记忆 ${project.conflict}，原始 Memmy ${original.conflict}，属性树 ${tree.conflict}。`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>项目记忆三臂对照</title><style>body{font-family:sans-serif;margin:32px;color:#1d1d1f;background:#f6f5f2}section{margin:24px 0}svg{width:100%;max-width:720px;color:#315f4b}table{border-collapse:collapse}td,th{border-bottom:1px solid #ccc;padding:6px 10px;text-align:left}</style></head><body><h1>本地多 Agent 对照</h1><p>本页是 M5 闸门用的合成三臂对照，不是正式评测。正式评测报告见仓库里的 eval/project-memory/report.html。</p><p>基线 ${result.baselineSha}。数字来自本次运行写入的 results.json。总墙钟 ${result.wallClockMs} ms。</p><p>${note}</p>${bar(arms, (item) => item.score, "综合得分")}${bar(rounds, (item) => item.score, "属性树三轮")}${bar(arms, (item) => item.recallMs, "召回 P50 ms")}<table><thead><tr><th>臂</th><th>得分</th><th>接力</th><th>冲突</th><th>召回 P50</th><th>召回 P95</th><th>开会话 P50</th><th>开会话 P95</th><th>库字节</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

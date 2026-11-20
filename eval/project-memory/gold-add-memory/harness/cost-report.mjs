// Time, token and cost breakdown of one MemOS v3 replay, by phase (Add, Search, Reader, Judge)
// and by model step.
//   node harness/cost-report.mjs <run-dir>
// Reads <run-dir>/live-run.json (or live-run.partial.json), usage/sut-calls.jsonl written by
// harness/usage-proxy.mjs, models.json and score.json when present. Writes cost-report.json and
// cost-report.md. Prices come from pricing.json, per call, with DeepSeek peak windows and cached
// input priced apart. Local embeddings cost 0.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { costUsd, percentile, resolveModelPrice, tokenBuckets } from "../metrics.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
const readLines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
}) : []);
const sum = (values) => values.reduce((total, value) => total + (value ?? 0), 0);
const round = (value, digits = 10) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

function emptyBucket() {
  return { calls: 0, failedCalls: 0, uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, unpricedCalls: 0, modelMs: [], peakCalls: 0 };
}

function addCall(bucket, call) {
  bucket.calls += 1;
  if (call.failed) { bucket.failedCalls += 1; return; }
  bucket.uncachedInputTokens += call.uncached;
  bucket.cachedInputTokens += call.cached;
  bucket.outputTokens += call.output;
  bucket.reasoningTokens += call.reasoning;
  if (typeof call.latencyMs === "number") bucket.modelMs.push(call.latencyMs);
  if (call.costUsd === null) bucket.unpricedCalls += 1;
  else bucket.costUsd += call.costUsd;
  if (call.peak) bucket.peakCalls += 1;
}

function finish(bucket) {
  const { modelMs, ...rest } = bucket;
  return {
    ...rest,
    costUsd: round(bucket.costUsd),
    modelMs: { sum: Math.round(sum(modelMs)), p50: round(percentile(modelMs, 50), 1), p95: round(percentile(modelMs, 95), 1) }
  };
}

function isPeak(model, at, pricing) {
  const price = resolveModelPrice(model, pricing);
  if (!price?.peak) return false;
  return costUsd({ model, at, cacheWriteTokens: 1e6, outputTokens: 0 }, pricing) !== costUsd({ model, at, cacheWriteTokens: 1e6, outputTokens: 0 }, pricing, { tiered: false });
}

// One normalized model call. reasoning tokens are part of output tokens and are billed as output.
export function normalizeProxyCall(line, pricing, fallbackModel) {
  const failed = Boolean(line.error) || !(line.status >= 200 && line.status < 300);
  const buckets = tokenBuckets(line.usage) ?? { cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const model = [line.model, line.requestedModel, fallbackModel].find((name) => name && resolveModelPrice(name, pricing)) ?? line.model ?? line.requestedModel ?? fallbackModel ?? null;
  const call = {
    at: line.at, model, failed, latencyMs: line.latencyMs,
    uncached: buckets.cacheWriteTokens ?? 0, cached: buckets.cacheReadTokens ?? 0, output: buckets.outputTokens ?? 0,
    reasoning: line.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    phase: line.context?.phase ?? "unknown", step: line.stage ?? line.operation ?? "other",
    event: line.context?.event ?? null
  };
  call.costUsd = failed ? 0 : costUsd({ model, at: line.at, cacheWriteTokens: call.uncached, cacheReadTokens: call.cached, outputTokens: call.output }, pricing);
  call.peak = !failed && isPeak(model, line.at, pricing);
  return call;
}

export function normalizeClientCalls(usage, pricing, phase) {
  return (usage?.perCall ?? []).map((row) => {
    const uncached = row.cacheWriteTokens ?? row.inputTokens ?? 0;
    const cached = row.cacheReadTokens ?? row.cachedInputTokens ?? 0;
    const output = row.outputTokens ?? 0;
    const at = row.at;
    return {
      at, model: usage.model, failed: false, latencyMs: row.latencyMs, uncached, cached, output, reasoning: 0,
      phase, step: phase, event: null,
      costUsd: costUsd({ model: usage.model, at, cacheWriteTokens: uncached, cacheReadTokens: cached, outputTokens: output }, pricing),
      peak: isPeak(usage.model, at, pricing)
    };
  });
}

export function buildReport({ run, proxyLines, judgeUsage, models, pricing }) {
  const sutModel = run.sut?.model ?? models?.roles?.sut?.model ?? null;
  const chat = proxyLines.filter((line) => line.kind === "chat" || /chat\/completions/.test(line.path ?? ""));
  const embeddings = proxyLines.filter((line) => line.kind === "embedding");
  const calls = [
    ...chat.map((line) => normalizeProxyCall(line, pricing, sutModel)),
    ...normalizeClientCalls(run.usage?.reader, pricing, "reader"),
    ...normalizeClientCalls(judgeUsage, pricing, "judge")
  ];
  // Attribute reader calls to the question whose event window contains them.
  const windows = (run.events ?? []).map((event) => [Date.parse(event.startedAt), Date.parse(event.endedAt), event.event]);
  for (const call of calls) {
    if (call.phase !== "reader" || call.event) continue;
    const at = Date.parse(call.at);
    call.event = windows.find(([start, end]) => at >= start && at <= end + 1)?.[2] ?? null;
  }

  const byPhase = {};
  const byStep = {};
  const byEvent = {};
  for (const call of calls) {
    addCall(byPhase[call.phase] ??= emptyBucket(), call);
    addCall(byStep[`${call.phase}/${call.step}`] ??= emptyBucket(), call);
    if (call.event) addCall(byEvent[call.event] ??= emptyBucket(), call);
  }

  const requests = run.requests ?? [];
  const requestMs = (phase) => requests.filter((r) => r.phase === phase).map((r) => r.ms ?? 0);
  const wall = {
    add_accept: Math.round(sum(requestMs("add"))),
    add_processing_clock: Math.round(sum(requestMs("clock"))),
    search: Math.round(sum(requestMs("search"))),
    reader: Math.round(run.phaseMs?.reader ?? 0),
    final_read: Math.round(sum(requestMs("final"))),
    api_checks: Math.round(sum(requestMs("check"))),
    setup: Math.round(sum(requestMs("setup"))),
    replay_total: run.wallclockMs ?? null,
    judge: judgeUsage?.latencyMs ? Math.round(sum(judgeUsage.latencyMs)) : null
  };
  const latency = (values) => ({ n: values.length, p50: round(percentile(values, 50), 1), p95: round(percentile(values, 95), 1) });
  const requestLatency = Object.fromEntries(["add", "clock", "search", "final", "check"].map((phase) => [phase, latency(requestMs(phase))]));

  const embeddingByPhase = {};
  for (const line of embeddings) {
    const phase = line.context?.phase ?? "unknown";
    const bucket = embeddingByPhase[phase] ??= { calls: 0, failedCalls: 0, inputs: 0, ms: [] };
    bucket.calls += 1;
    if (line.error || !(line.status >= 200 && line.status < 300)) bucket.failedCalls += 1;
    bucket.inputs += line.inputs ?? 0;
    if (typeof line.latencyMs === "number") bucket.ms.push(line.latencyMs);
  }

  const phases = Object.fromEntries(Object.entries(byPhase).map(([key, bucket]) => [key, finish(bucket)]));
  const system = ["add", "search", "reader"].map((phase) => phases[phase]?.costUsd ?? 0);
  const events = Object.fromEntries(Object.entries(byEvent).map(([key, bucket]) => [key, finish(bucket)]));
  return {
    generatedAt: new Date().toISOString(),
    run: { runTag: run.runTag, state: run.state, startedAt: run.startedAt, sutModel, readerModel: run.reader?.model ?? null, judgeModel: judgeUsage?.model ?? models?.roles?.judge?.model ?? null },
    pricing: { source: pricing.sources ?? pricing.source, note: pricing.unit },
    totals: {
      systemCostUsd: round(sum(system)),
      judgeCostUsd: phases.judge?.costUsd ?? null,
      allCostUsd: round(sum(Object.values(phases).map((phase) => phase.costUsd ?? 0))),
      unpricedCalls: sum(Object.values(phases).map((phase) => phase.unpricedCalls)),
      failedCalls: sum(Object.values(phases).map((phase) => phase.failedCalls))
    },
    wallMs: wall,
    requestLatencyMs: requestLatency,
    phases,
    steps: Object.fromEntries(Object.entries(byStep).sort().map(([key, bucket]) => [key, finish(bucket)])),
    embeddings: Object.fromEntries(Object.entries(embeddingByPhase).map(([key, bucket]) => [key, { calls: bucket.calls, failedCalls: bucket.failedCalls, inputs: bucket.inputs, ms: { sum: Math.round(sum(bucket.ms)), p95: round(percentile(bucket.ms, 95), 1) }, costUsd: 0 }])),
    events,
    unattributedChatCalls: calls.filter((call) => call.phase === "unknown").length
  };
}

const fmt = (value, digits = 0) => (value === null || value === undefined ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const usd = (value) => (value === null || value === undefined ? "—" : `$${Number(value).toFixed(4)}`);

export function renderMarkdown(report) {
  const row = (name, b) => `| ${name} | ${fmt(b.calls)} | ${fmt(b.failedCalls)} | ${fmt(b.uncachedInputTokens)} | ${fmt(b.cachedInputTokens)} | ${fmt(b.outputTokens)} | ${fmt(b.reasoningTokens)} | ${fmt(b.modelMs.sum / 1000, 1)} | ${fmt(b.modelMs.p95)} | ${usd(b.costUsd)} |`;
  const head = "| 项 | 调用 | 失败 | 未命中输入 | 命中输入 | 输出 | 其中推理 | 模型耗时合计 s | 单次 P95 ms | 费用 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const w = report.wallMs;
  const lines = [
    `# 评测开销 ${report.run.runTag ?? ""}`,
    "",
    `被测与阅读模型 ${report.run.sutModel} / ${report.run.readerModel}，评委 ${report.run.judgeModel ?? "未评分"}。费用按 pricing.json 逐次计价，区分缓存命中与 DeepSeek 高峰时段；本地向量记 0。`,
    "",
    `合计：被测系统（Add + Search + 阅读）${usd(report.totals.systemCostUsd)}，评委 ${usd(report.totals.judgeCostUsd)}，全部 ${usd(report.totals.allCostUsd)}。未计价调用 ${report.totals.unpricedCalls}，失败调用 ${report.totals.failedCalls}，未归属阶段的聊天调用 ${report.unattributedChatCalls}。`,
    "",
    "## 墙钟",
    "",
    "| 阶段 | 墙钟 s |",
    "| --- | --- |",
    `| Add 受理（add + status 请求） | ${fmt(w.add_accept / 1000, 1)} |`,
    `| Add 整理（时钟推进内完成的抽取、归类、合并、提交） | ${fmt(w.add_processing_clock / 1000, 1)} |`,
    `| Search（search 请求） | ${fmt(w.search / 1000, 1)} |`,
    `| 阅读模型 | ${fmt(w.reader / 1000, 1)} |`,
    `| 终态读取 / 接口检查 | ${fmt(w.final_read / 1000, 1)} / ${fmt(w.api_checks / 1000, 1)} |`,
    `| 回放总计 | ${fmt((w.replay_total ?? 0) / 1000, 1)} |`,
    `| 评委（模型耗时合计） | ${fmt((w.judge ?? 0) / 1000, 1)} |`,
    "",
    "请求延迟（ms）：" + Object.entries(report.requestLatencyMs).map(([key, value]) => `${key} n=${value.n} P50 ${fmt(value.p50)} P95 ${fmt(value.p95)}`).join("；"),
    "",
    "## 按阶段",
    "",
    head,
    ...Object.entries(report.phases).map(([key, bucket]) => row(key, bucket)),
    "",
    "## 按步骤",
    "",
    head,
    ...Object.entries(report.steps).map(([key, bucket]) => row(key, bucket)),
    "",
    "## 向量调用（本地，不计费）",
    "",
    "| 阶段 | 调用 | 失败 | 文本数 | 耗时合计 ms | P95 ms |",
    "| --- | --- | --- | --- | --- | --- |",
    ...Object.entries(report.embeddings).map(([key, b]) => `| ${key} | ${b.calls} | ${b.failedCalls} | ${b.inputs} | ${fmt(b.ms.sum)} | ${fmt(b.ms.p95)} |`),
    "",
    "## 开销最高的 15 个事件",
    "",
    head,
    ...Object.entries(report.events).sort((a, b) => (b[1].costUsd ?? 0) - (a[1].costUsd ?? 0)).slice(0, 15).map(([key, bucket]) => row(key, bucket)),
    ""
  ];
  return lines.join("\n");
}

function main() {
  const dir = resolve(process.argv[2] ?? ".");
  const run = readJson(join(dir, "live-run.json")) ?? readJson(join(dir, "live-run.partial.json"));
  if (!run) throw new Error(`No live-run.json in ${dir}`);
  const pricing = readJson(join(here, "..", "pricing.json"));
  const score = readJson(join(dir, "score.json"));
  const judgeUsage = readJson(join(dir, "judge-usage.json")) ?? null;
  const report = buildReport({ run, proxyLines: readLines(join(dir, "usage", "sut-calls.jsonl")), judgeUsage, models: readJson(join(dir, "models.json")), pricing, score });
  writeFileSync(join(dir, "cost-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, "cost-report.md"), renderMarkdown(report));
  console.log(JSON.stringify(report.totals));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();

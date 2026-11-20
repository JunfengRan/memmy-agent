import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildReport } from "./cost-report.mjs";
import { chooseModels } from "./model-env.mjs";
import { contextTag, stageOf } from "./usage-proxy.mjs";

const pricing = {
  models: {
    "deepseek-flash": { input: 0.15, cachedInput: 0.003, output: 0.6, peak: { input: 0.3, cachedInput: 0.006, output: 1.2, utcMinutes: [[60, 240]] } },
    "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 }
  },
  aliases: { "deepseek-v4.1-flash-1017": "deepseek-flash" }
};

function home(profiles) {
  const dir = mkdtempSync(join(tmpdir(), "pm-models-"));
  for (const [name, model] of Object.entries(profiles)) {
    writeFileSync(join(dir, `.${name}.env`), `MODEL=${model}\nOPENAI_API_BASE=https://gateway/v1\nOPENAI_API_KEY=secret-${name}\n`);
  }
  return dir;
}

test("a failing profile falls through to the next profile, never to another model of the same profile", async () => {
  const dir = home({ deepseek: "deepseek-v4.1-flash-1017", openai: "gpt-6-luna", claude: "claude-haiku-5-5" });
  const probeImpl = async (config) => ({ ok: config.profile !== "openai", status: config.profile === "openai" ? 400 : 200, ms: 1 });
  const { chosen, attempts } = await chooseModels({ home: dir, probeImpl });
  assert.equal(chosen.sut.model, "deepseek-v4.1-flash-1017");
  assert.equal(chosen.reader.model, "deepseek-v4.1-flash-1017");
  assert.equal(chosen.judge.model, "claude-haiku-5-5");
  assert.deepEqual(attempts.map((row) => row.profile), ["deepseek", "openai", "claude"]);
});

test("the judge never shares the system under test's family", async () => {
  const dir = home({ deepseek: "deepseek-v4.1-flash-1017" });
  await assert.rejects(chooseModels({ home: dir, probeImpl: async () => ({ ok: true, status: 200, ms: 1 }) }), /No working model for judge/);
});

test("proxy tags keep scalars only and stages match the system prompt start", () => {
  assert.deepEqual(contextTag({ phase: "add", event: "t1", nested: { secret: 1 }, long: "x".repeat(500) }), { phase: "add", event: "t1" });
  const stages = [{ stage: "extract", operation: "extract", marker: "你为项目整理" }];
  assert.equal(stageOf({ messages: [{ role: "system", content: "你为项目整理一段" }] }, stages).stage, "extract");
  assert.equal(stageOf({ messages: [{ role: "user", content: "你为项目整理一段" }] }, stages), null);
});

test("the report prices each call and separates phases, steps and events", () => {
  const run = {
    runTag: "r", sut: { model: "deepseek-v4.1-flash-1017" }, reader: { model: "deepseek-v4.1-flash-1017" },
    requests: [{ phase: "clock", ms: 1000 }, { phase: "search", ms: 20 }],
    phaseMs: { reader: 500 },
    events: [{ event: "q1", startedAt: "2026-11-21T00:00:00.000Z", endedAt: "2026-11-21T00:00:10.000Z" }],
    usage: { reader: { model: "deepseek-v4.1-flash-1017", calls: 1, perCall: [{ at: "2026-11-21T00:00:05.000Z", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, latencyMs: 400 }] } }
  };
  const proxyLines = [
    // Saturday: off-peak.
    { kind: "chat", at: "2026-11-21T02:00:00.000Z", status: 200, latencyMs: 900, model: "deepseek-v4-1-flash-261017", requestedModel: "deepseek-v4.1-flash-1017", stage: "extract", operation: "extract",
      usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600, completion_tokens_details: { reasoning_tokens: 50 } }, context: { phase: "add", event: "t1" } },
    // Friday 02:00 UTC: peak.
    { kind: "chat", at: "2026-11-20T02:00:00.000Z", status: 200, latencyMs: 700, requestedModel: "deepseek-v4.1-flash-1017", stage: "assign",
      usage: { prompt_tokens: 1000, completion_tokens: 0, prompt_cache_miss_tokens: 1000 }, context: { phase: "add", event: "t1" } },
    { kind: "chat", at: "2026-11-20T02:00:01.000Z", status: 500, error: "boom", requestedModel: "deepseek-v4.1-flash-1017", context: { phase: "add", event: "t1" } },
    { kind: "embedding", at: "2026-11-20T02:00:02.000Z", status: 200, latencyMs: 12, inputs: 3, context: { phase: "search" } }
  ];
  const judgeUsage = { model: "gpt-6-luna", calls: 1, latencyMs: [300], perCall: [{ at: "2026-11-20T03:00:00.000Z", inputTokens: 2000, cachedInputTokens: 0, outputTokens: 10, latencyMs: 300 }] };
  const report = buildReport({ run, proxyLines, judgeUsage, models: null, pricing });
  const extract = (600 * 0.15 + 400 * 0.003 + 200 * 0.6) / 1e6;
  const assign = (1000 * 0.3) / 1e6;
  assert.ok(Math.abs(report.steps["add/extract"].costUsd - extract) < 1e-9);
  assert.ok(Math.abs(report.steps["add/assign"].costUsd - assign) < 1e-9);
  assert.equal(report.steps["add/assign"].peakCalls, 1);
  assert.equal(report.phases.add.failedCalls, 1);
  assert.equal(report.phases.add.reasoningTokens, 50);
  assert.equal(report.events.q1.calls, 1); // reader call attributed by its event window
  assert.ok(Math.abs(report.totals.judgeCostUsd - (2000 * 0.1 + 10 * 0.5) / 1e6) < 1e-9);
  assert.equal(report.embeddings.search.inputs, 3);
  assert.equal(report.wallMs.add_processing_clock, 1000);
});

#!/usr/bin/env node
// Reader ceiling: feed the gold (oracle) topic_detail_list to the fixed reader at every askedAt and
// write a run that run-pipeline-eval.mjs scores with the same judge. A perfect memory system should
// score here; whatever is missed is reader / judge / question noise, not implementation.
//
// Env: MEMMY_EVAL_READER_{PROVIDER,MODEL,BASE_URL,API_KEY}.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDataset } from "../build-gold-baseline.mjs";
import { createLlm, resolveModelConfig } from "../llm.mjs";
import { loadGold } from "../load-eval-set.mjs";
import { buildOracleRun } from "../oracle.mjs";
import { createReader } from "../reader.mjs";
import { RUNS_DIR } from "../run-pipeline-eval.mjs";

const ds = loadDataset();
const gold = loadGold();
const readerConfig = resolveModelConfig("MEMMY_EVAL_READER");
if (!readerConfig) { console.error("reader not configured: set MEMMY_EVAL_READER_PROVIDER / _MODEL / _BASE_URL / _API_KEY"); process.exit(2); }
const readerLlm = createLlm({ config: readerConfig, cachePath: join(RUNS_DIR, "reader-cache.json") });
const reader = createReader(readerLlm);

const run = buildOracleRun(ds, gold);
const byId = new Map(gold.questions.map((q) => [q.id, q]));
for (const question of run.questions) question.answer = await reader.answer(byId.get(question.id), question.rendered);
run.kind = "reader-ceiling";
run.sut = { model: process.env.MEMMY_EVAL_SUT_MODEL ?? "oracle" };
run.reader = { model: readerConfig.model, provider: readerConfig.provider };
run.usage = { reader: { ...readerLlm.usage, latencyMs: undefined } };
readerLlm.save();

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(RUNS_DIR, stamp);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "live-run.json"), `${JSON.stringify(run, null, 2)}\n`);
console.log(JSON.stringify({ out: join(outDir, "live-run.json"), questions: run.questions.length }));

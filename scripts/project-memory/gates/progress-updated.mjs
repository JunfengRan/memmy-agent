#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, pass, readJson, readWorkflowYaml } from "../gate-utils.mjs";

const phase = process.argv[2];
if (!phase) fail("usage: progress-updated.mjs <phase>");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const progressPath = join(root, "docs/project-memory/PROGRESS.md");
if (!existsSync(progressPath)) fail("missing PROGRESS.md");
const progress = readFileSync(progressPath, "utf8");
const workflow = readWorkflowYaml(readFileSync(join(root, "spec/project-memory/workflow.yaml"), "utf8"));
if (!progress.includes(workflow.baselineSha)) fail("PROGRESS.md must record baselineSha");
if (!progress.includes(`## ${phase}`)) fail(`PROGRESS.md missing section ## ${phase}`);
const state = readJson(join(root, "docs/project-memory/state.json"));
if (state.baselineSha !== workflow.baselineSha) fail("state.json baselineSha drifted from workflow.yaml");
pass(`progress-updated: ${phase} ok`);

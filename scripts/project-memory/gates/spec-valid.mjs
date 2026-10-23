#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, pass, readJson, readWorkflowYaml } from "../gate-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workflowPath = join(root, "spec/project-memory/workflow.yaml");
if (!existsSync(workflowPath)) fail(`missing ${workflowPath}`);
const workflow = readWorkflowYaml(readFileSync(workflowPath, "utf8"));
const expected = ["spec", "m1", "retro", "m2", "m3", "m4", "m5", "eval", "done"];
if (workflow.states.join(",") !== expected.join(",")) {
  fail(`workflow states must be ${expected.join(" -> ")}`);
}
if (!/^[0-9a-f]{40}$/.test(workflow.baselineSha ?? "")) {
  fail("workflow.yaml baselineSha must be a 40-char git sha");
}
const phases = ["m1", "m2", "m3", "m4", "m5", "eval"];
for (const phase of phases) {
  const path = join(root, "spec/project-memory/phases", `${phase}.json`);
  if (!existsSync(path)) fail(`missing ${path}`);
  const spec = readJson(path);
  if (spec.phase !== phase) fail(`${path} phase must be ${phase}`);
  if (!Array.isArray(spec.requirements) || spec.requirements.length === 0) {
    fail(`${path} needs requirements`);
  }
  const ids = spec.requirements.map((item) => item.id);
  if (ids.some((id) => typeof id !== "string" || !id.trim())) fail(`${path} has an empty requirement id`);
  if (new Set(ids).size !== ids.length) fail(`${path} requirement ids must be unique`);
}
if (!existsSync(join(root, "docs/project-memory/PROGRESS.md"))) {
  fail("missing docs/project-memory/PROGRESS.md");
}
pass("spec-valid: ok");

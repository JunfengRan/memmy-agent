#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, readWorkflowYaml } from "./gate-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const statePath = join(root, "docs/project-memory/state.json");
const workflow = readWorkflowYaml(readFileSync(join(root, "spec/project-memory/workflow.yaml"), "utf8"));
const command = process.argv[2] ?? "status";

function loadState() {
  if (!existsSync(statePath)) {
    return { currentState: workflow.initial, baselineSha: workflow.baselineSha, history: [] };
  }
  return readJson(statePath);
}

function saveState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function runGate(name, phase) {
  const script = join(root, "scripts/project-memory/gates", `${name}.mjs`);
  const result = spawnSync(process.execPath, [script, phase], { cwd: root, encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

const state = loadState();
if (command === "status") {
  process.stdout.write(`${state.currentState}\n`);
  process.exit(0);
}
if (command === "verify") {
  runGate("spec-valid", state.currentState);
  process.exit(0);
}
if (command !== "advance") {
  process.stderr.write("usage: cli.mjs status|verify|advance\n");
  process.exit(1);
}
const transition = workflow.transitions.find((item) => item.from === state.currentState);
if (!transition) {
  process.stderr.write(`no transition from ${state.currentState}\n`);
  process.exit(1);
}
for (const gate of transition.gates) runGate(gate, state.currentState);
state.history.push({ from: state.currentState, to: transition.to, at: new Date().toISOString() });
state.currentState = transition.to;
saveState(state);
process.stdout.write(`${transition.to}\n`);

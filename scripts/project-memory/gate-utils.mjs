import { readFileSync } from "node:fs";

export function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export function pass(message) {
  process.stdout.write(`${message}\n`);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Reads the small workflow YAML this repo owns. Not a general parser. */
export function readWorkflowYaml(text) {
  const root = { states: [], transitions: [] };
  const lines = text.split(/\r?\n/);
  let mode = null;
  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      mode = null;
      current = null;
      const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
      if (!match) fail(`workflow.yaml: bad line ${line}`);
      const [, key, value] = match;
      if (value === "") {
        mode = key;
        continue;
      }
      root[key] = value;
      continue;
    }
    const trimmed = line.trim();
    if (mode === "states" && trimmed.startsWith("- ")) {
      root.states.push(trimmed.slice(2).trim());
      continue;
    }
    if (mode === "transitions" && trimmed.startsWith("- ")) {
      current = {};
      root.transitions.push(current);
      const inline = trimmed.slice(2);
      if (inline) assignTransitionField(current, inline);
      continue;
    }
    if (mode === "transitions" && current) assignTransitionField(current, trimmed);
  }
  return root;
}

function assignTransitionField(current, text) {
  const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(text);
  if (!match) fail(`workflow.yaml: bad transition field ${text}`);
  const [, key, value] = match;
  if (key === "gates") {
    const body = value.replace(/^\[/, "").replace(/\]$/, "");
    current.gates = body.split(",").map((item) => item.trim()).filter(Boolean);
    return;
  }
  current[key] = value;
}

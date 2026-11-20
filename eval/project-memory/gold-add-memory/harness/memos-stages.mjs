// Writes the stage map for harness/usage-proxy.mjs from MemOS project-memory prompt sources.
//   node harness/memos-stages.mjs <MemOS>/src/memos/project_memory > stages.json
// Each prompt "NAME = \"\"\"[系统]\n<first line>" becomes {stage, operation, marker}.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAMES = {
  _EXTRACT: ["extract", "extract"],
  _ASSIGN: ["assign", "assign"],
  _ASSIGN_BATCH: ["assign_batch", "assign"],
  _FORMATION: ["formation", "other"],
  _METADATA: ["metadata", "other"],
  DECISION_EXTRACT: ["decision_extract", "extract"],
  DECISION_UPDATE: ["decision_update", "other"],
  JUDGE_LLM: ["internal_judge", "judge"],
  TOPIC_ASSIGN: ["topic_assign", "assign"]
};

export function memosStages(directory) {
  const stages = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".py")).sort()) {
    const source = readFileSync(join(directory, file), "utf8");
    for (const match of source.matchAll(/^([A-Z_]+) = """\[系统\]\n([^\n]+)/gm)) {
      const [stage, operation] = NAMES[match[1]] ?? [match[1].replace(/^_/, "").toLowerCase(), "other"];
      stages.push({ stage, operation, marker: match[2].trim().replace(/\\"/g, "\""), source: `${file}:${match[1]}` });
    }
  }
  return stages;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(JSON.stringify(memosStages(resolve(process.argv[2])), null, 2));
}

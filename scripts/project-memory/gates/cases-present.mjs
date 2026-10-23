#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, pass, readJson } from "../gate-utils.mjs";

const phase = process.argv[2];
if (!phase) fail("usage: cases-present.mjs <phase>");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const specPath = join(root, "spec/project-memory/phases", `${phase}.json`);
if (!existsSync(specPath)) fail(`no phase spec for ${phase}`);
const spec = readJson(specPath);
const caseDir = join(root, "Memory/tests/project-memory/cases", phase);
if (!existsSync(caseDir)) fail(`missing cases at ${caseDir}`);
const files = readdirSync(caseDir).filter((name) => name.endsWith(".json"));
if (files.length === 0) fail(`${caseDir} has no cases`);
const covered = new Set();
for (const file of files) {
  const body = readJson(join(caseDir, file));
  const cases = Array.isArray(body) ? body : [body];
  for (const item of cases) {
    if (!item.id || !item.requirement || item.expect === undefined) {
      fail(`${file} cases need id, requirement, and expect`);
    }
    covered.add(item.requirement);
  }
}
const missing = spec.requirements.map((item) => item.id).filter((id) => !covered.has(id));
if (missing.length > 0) fail(`${phase} requirements without cases: ${missing.join(", ")}`);
pass(`cases-present: ${phase} ok`);

#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, pass, readJson } from "../gate-utils.mjs";

const phase = process.argv[2];
if (!phase) fail("usage: tests-green.mjs <phase>");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const reportPath = join(root, "docs/project-memory/runs", phase, "vitest.json");
if (!existsSync(reportPath)) fail(`missing vitest report ${reportPath}`);
const report = readJson(reportPath);
const failed = Number(report.numFailedTests ?? report.failed ?? 0);
const passed = Number(report.numPassedTests ?? report.passed ?? 0);
if (!Number.isFinite(failed) || !Number.isFinite(passed)) fail("vitest report needs numFailedTests and numPassedTests");
if (failed !== 0) fail(`${phase} vitest failed tests: ${failed}`);
if (passed < 1) fail(`${phase} vitest passed nothing`);
const caseIds = Array.isArray(report.caseIds) ? report.caseIds : [];
if (phase === "eval") {
  if (!existsSync(join(root, "docs/project-memory/eval/results.json"))) {
    fail("eval report missing docs/project-memory/eval/results.json");
  }
  if (!existsSync(join(root, "docs/project-memory/eval/report.html"))) {
    fail("eval report missing docs/project-memory/eval/report.html");
  }
} else if (existsSync(join(root, "spec/project-memory/phases", `${phase}.json`))) {
  const spec = readJson(join(root, "spec/project-memory/phases", `${phase}.json`));
  const required = new Set(spec.requirements.map((item) => item.id));
  const seen = new Set(caseIds);
  const missing = [...required].filter((id) => !seen.has(id));
  if (missing.length > 0) fail(`${phase} vitest report missing case ids: ${missing.join(", ")}`);
}
pass(`tests-green: ${phase} ${passed} passed`);

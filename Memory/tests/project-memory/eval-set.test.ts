import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const relay = JSON.parse(readFileSync(join(repo, "eval/project-memory/dataset/relay.json"), "utf8"));
const report = JSON.parse(execFileSync(process.execPath, ["eval/project-memory/load-eval-set.mjs"], {
  cwd: repo,
  encoding: "utf8"
}));

describe("project memory eval set", () => {
  it("reads the standalone ledger and catalog set", () => {
    expect(relay.questions).toHaveLength(30);
    expect(relay.questions.every((question: { kind: string; trapEvidenceIds: string[] }) => question.kind === "plain" || question.trapEvidenceIds.length > 0)).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("keeps the amount decision different before and after the rewrite", () => {
    expect(report.amountPairGold).toBe(2);
  });

  it("scores an empty answer as zero and the gold answer as full", () => {
    expect(report.rubricSound).toBe(true);
  });

  it("asks every question as a user would, with a trap on every non-plain kind", () => {
    const kinds = new Set(relay.questions.map((question: { kind: string }) => question.kind));
    expect([...kinds].sort()).toEqual(["cross-project", "overridden", "plain", "scope-leak", "stale"]);
    expect(new Set(relay.questions.map((question: { id: string }) => question.id)).size).toBe(30);
  });
});

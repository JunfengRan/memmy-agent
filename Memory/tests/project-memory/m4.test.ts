import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { factScore, scoreContext } from "../../src/service/project/eval-score.js";

const cases = JSON.parse(readFileSync(new URL("./cases/m4/cases.json", import.meta.url), "utf8")) as Array<{ id: string; requirement: string; kind: string }>;
const results = JSON.parse(readFileSync(new URL("../../../docs/project-memory/eval/results.json", import.meta.url), "utf8")) as {
  datasets: string[];
  arms: Array<{ name: string; recallMs: number; dbBytes: number; ingestMs: number }>;
};

describe("project memory M4 cases", () => {
  for (const item of cases) it(`${item.id} ${item.requirement}`, () => {
    if (item.kind === "datasets") {
      expect(results.datasets).toEqual(["relay", "conflict"]);
      return;
    }
    if (item.kind === "metrics") {
      for (const arm of results.arms) {
        expect(arm.recallMs).toBeGreaterThanOrEqual(0);
        expect(arm.ingestMs).toBeGreaterThanOrEqual(0);
        expect(arm.dbBytes).toBeGreaterThan(0);
      }
      expect(factScore(scoreContext("cursor:main src/pool.ts scope coefficient return Task list run tests before commit"))).toBe(1);
      return;
    }
    const sizes = new Set(results.arms.map((arm) => arm.dbBytes));
    expect(sizes.size).toBeGreaterThan(1);
  });
});

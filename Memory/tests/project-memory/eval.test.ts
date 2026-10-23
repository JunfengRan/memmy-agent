import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cases = JSON.parse(readFileSync(new URL("./cases/eval/cases.json", import.meta.url), "utf8")) as Array<{ id: string; requirement: string; kind: string }>;
const results = JSON.parse(readFileSync(new URL("../../../docs/project-memory/eval/results.json", import.meta.url), "utf8")) as { arms: Array<{ name: string; score: number }> };
const html = readFileSync(new URL("../../../docs/project-memory/eval/report.html", import.meta.url), "utf8");

describe("project memory eval cases", () => {
  for (const item of cases) it(`${item.id} ${item.requirement}`, () => {
    if (item.kind === "json") {
      expect(results.arms.every((arm) => typeof arm.score === "number")).toBe(true);
      return;
    }
    if (item.kind === "html") {
      expect(html).toContain("<svg");
      expect(html).not.toContain("http://");
      expect(html).not.toContain("https://");
      return;
    }
    expect(results.arms.map((arm) => arm.name)).toEqual(["project-memory", "original-memmy", "attribute-tree"]);
  });
});

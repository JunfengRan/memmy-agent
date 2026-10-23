import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cases = JSON.parse(readFileSync(new URL("./cases/m5/cases.json", import.meta.url), "utf8")) as Array<{ id: string; requirement: string; kind: string }>;
// @ts-expect-error attribute-tree eval module has no declarations
const tree = await import("/Users/junfengran/repos/memmy-agent-attr-tree/eval/attribute-tree.mjs") as {
  renderAttributeTree: (records: unknown[], query: string, round: number) => string;
  controlRecall: (recall: string, records: unknown[], query: string, round: number) => string;
};
const records = [
  { project: "alpha", file: "src/pool.ts", kind: "recent_edit", agent: "cursor:main", at: "2026-10-22T00:00:00.000Z", text: "cursor:main edited src/pool.ts and chose scope coefficient" },
  { project: "alpha", file: "src/pool.ts", kind: "recent_edit", agent: "cursor:main", at: "2026-10-21T00:00:00.000Z", text: "OLD_EDIT src/pool.ts" },
  { project: "beta", file: "src/secret.ts", kind: "recent_edit", agent: "codex:main", at: "2026-10-22T00:01:00.000Z", text: "OTHER_PROJECT_SECRET" },
  { project: "alpha", file: "src/storage/json_store.py", kind: "convention", agent: "cursor:main", at: "2026-10-22T00:02:00.000Z", text: "json yaml and sqlite stores return Task list" },
  { project: "global", file: "", kind: "convention", agent: "memmy:main", at: "2026-10-22T00:03:00.000Z", text: "run tests before commit" }
];
const results = JSON.parse(readFileSync(new URL("../../../docs/project-memory/eval/results.json", import.meta.url), "utf8")) as {
  baselineSha: string;
  attributeTreeRounds: Array<{ round: number }>;
};

describe("project memory M5 cases", () => {
  for (const item of cases) it(`${item.id} ${item.requirement}`, () => {
    if (item.kind === "baseline") {
      expect(results.baselineSha).toBe("8684cb570f1b54debcdd45da45f0f02661a76a42");
      return;
    }
    if (item.kind === "inject") {
      const rendered = tree.renderAttributeTree(records, "Who edited src/pool.ts in alpha?", 3);
      expect(rendered).toContain("project/alpha/module/src/file/src/pool.ts/recent_edit");
      expect(rendered).toContain("scope coefficient");
      expect(rendered).not.toContain("OLD_EDIT");
      expect(rendered).not.toContain("OTHER_PROJECT_SECRET");
      const convention = tree.renderAttributeTree(records, "parquet store convention in alpha", 3);
      expect(convention).toContain("return Task list");
      expect(convention).not.toContain("OTHER_PROJECT_SECRET");
      const cold = tree.renderAttributeTree(records, "What should a new project do before commit?", 3);
      expect(cold).toContain("run tests before commit");
      expect(cold).not.toContain("OTHER_PROJECT_SECRET");
      return;
    }
    expect(results.attributeTreeRounds.map((round) => round.round)).toEqual([1, 2, 3]);
    const controlled = tree.controlRecall("see OTHER_PROJECT_SECRET and src/pool.ts", records, "src/pool.ts in alpha", 3);
    expect(controlled).toContain("src/pool.ts");
    expect(controlled).toContain("OTHER_PROJECT_SECRET");
    expect(controlled.split("see OTHER_PROJECT_SECRET")[0]).not.toContain("OTHER_PROJECT_SECRET");
  });
});

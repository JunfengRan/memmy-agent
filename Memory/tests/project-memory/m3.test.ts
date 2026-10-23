import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aclAllows, canReadMemory, effectiveLevel } from "../../src/service/project/access.js";
import { adjudicate, deliverOnce, dreamCanResolve, revalidateOneLayer } from "../../src/service/project/conflict.js";

const cases = JSON.parse(readFileSync(new URL("./cases/m3/cases.json", import.meta.url), "utf8")) as Array<{
  id: string;
  requirement: string;
  kind: string;
}>;

describe("project memory M3 cases", () => {
  for (const item of cases) it(`${item.id} ${item.requirement}`, () => run(item.kind));
});

function run(kind: string): void {
  if (kind === "level") {
    expect(effectiveLevel("read", "admin")).toBe("read");
    return;
  }
  if (kind === "default") {
    expect(effectiveLevel()).toBe("write");
    return;
  }
  if (kind === "read") {
    expect(canReadMemory("none", "restricted")).toBe(false);
    expect(canReadMemory("read", "restricted")).toBe(true);
    expect(canReadMemory("write", "private")).toBe(true);
    return;
  }
  if (kind === "acl") {
    expect(aclAllows("read", "write").allow).toBe(false);
    expect(aclAllows("none", "read").allow).toBe(false);
    return;
  }
  if (kind === "same") {
    expect(adjudicate({ levelA: "write", levelB: "write" }).status).toBe("open");
    return;
  }
  if (kind === "higher") {
    expect(adjudicate({ levelA: "admin", levelB: "write" }).winner).toBe("a");
    return;
  }
  if (kind === "user") {
    expect(adjudicate({ userWinner: "b", levelA: "admin", levelB: "read" })).toMatchObject({ winner: "b", resolvedBy: "user" });
    return;
  }
  if (kind === "deliver") {
    const first = deliverOnce([{ id: "u1", markdown: "更新" }], "t1");
    expect(first.deliver.map((item) => item.id)).toEqual(["u1"]);
    const second = deliverOnce(first.rest, "t2");
    expect(second.deliver).toEqual([]);
    return;
  }
  if (kind === "review") {
    expect(revalidateOneLayer(Array.from({ length: 40 }, (_, index) => `id${index}`))).toHaveLength(30);
    return;
  }
  expect(dreamCanResolve("claim", true)).toBe(true);
  expect(dreamCanResolve("change", true)).toBe(false);
  expect(dreamCanResolve("claim", false)).toBe(false);
}

import { describe, expect, it } from "vitest";
import { RRF_K, fuseRanked, type FuseCandidate, type FusePath } from "../../../src/service/project-memory/retrieve/fuse.js";

function ownOf(rank: number): number {
  return Math.round(((RRF_K + 1) / (RRF_K + rank)) * 10_000) / 10_000;
}

function item(path: FusePath, id: string, rank: number, text: string, score?: number): FuseCandidate & { score?: number } {
  return { id, path, rank, text, ...(score !== undefined ? { score } : {}) };
}

function ids(candidates: readonly FuseCandidate[], options: { limit: number; relativity?: number } = { limit: 25 }): string[] {
  return fuseRanked(candidates, options).map((hit) => hit.id);
}

function monotonic(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value <= values[index - 1]!);
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = state + 0x6D2B79F5 | 0;
    let next = Math.imul(state ^ state >>> 15, 1 | state);
    next = next + Math.imul(next ^ next >>> 7, 61 | next) ^ next;
    return ((next ^ next >>> 14) >>> 0) / 4294967296;
  };
}

describe("project memory rank fusion", () => {
  it("ignores raw scores, including a scaled path", () => {
    const base = [
      item("user_memory", "low", 1, "alpha", 0.01),
      item("user_memory", "high", 2, "beta", 100),
      item("agent_memory", "agent", 1, "alpha", 0.2),
      item("project", "topic", 1, "gamma", 0.4)
    ];
    const scaled = base.map((candidate) => (
      candidate.path === "user_memory" ? { ...candidate, score: (candidate.score ?? 0) * 1_000 } : candidate
    ));
    expect(fuseRanked(scaled, { limit: 10 })).toEqual(fuseRanked(base, { limit: 10 }));
    expect(ids(base)[0]).toBe("low");
    expect(ids(base).indexOf("low")).toBeLessThan(ids(base).indexOf("high"));
  });

  it("gives rank r own relativity round4(61/(60+r)) and rank 1 relativity 1", () => {
    const ranks = [1, 2, 3, 5, 10];
    const hits = fuseRanked(ranks.map((rank) => item("project", `p${rank}`, rank, "same topic")), { limit: 25 });
    expect(hits.map((hit) => hit.relativity)).toEqual(ranks.map((rank) => ownOf(rank)));
    expect(hits[0]!.relativity).toBe(1);
    expect(ownOf(1)).toBe(1);
  });

  it("keeps every returned list monotonic over 200 seeded inputs, and repeats the same input", () => {
    const random = mulberry32(20261110);
    const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    const paths: FusePath[] = ["user_memory", "agent_memory", "project"];
    const thresholds = [undefined, 0, 0.5, 0.95, 1] as const;
    for (let trial = 0; trial < 200; trial += 1) {
      const candidates: FuseCandidate[] = [];
      for (const path of paths) {
        const count = Math.floor(random() * 6);
        for (let index = 0; index < count; index += 1) {
          const text = words.filter(() => random() < 0.45).join(" ") || words[Math.floor(random() * words.length)]!;
          candidates.push(item(path, `${path}-${trial}-${index}`, index + 1, text, random()));
        }
      }
      const options = {
        limit: 1 + Math.floor(random() * 8),
        ...(thresholds[trial % thresholds.length] !== undefined ? { relativity: thresholds[trial % thresholds.length] } : {})
      };
      const once = fuseRanked(candidates, options);
      expect(fuseRanked(candidates, options), `trial ${trial}`).toEqual(once);
      const lists = [
        once.map((hit) => hit.relativity),
        ...paths.map((path) => once.filter((hit) => hit.path === path).map((hit) => hit.relativity))
      ];
      for (const list of lists) {
        expect(monotonic(list), `trial ${trial} ${list.join(",")}`).toBe(true);
      }
      expect(once.length).toBeLessThanOrEqual(options.limit);
      for (const hit of once) expect(hit).not.toHaveProperty("score");
    }
  });

  it("breaks a remaining tie by id", () => {
    const tied = [
      item("project", "m", 2, "same"),
      item("user_memory", "b", 2, "same"),
      item("user_memory", "a", 2, "same")
    ];
    const once = fuseRanked(tied, { limit: 10 });
    expect(fuseRanked(tied, { limit: 10 })).toEqual(once);
    expect(once.map((hit) => hit.id)).toEqual(["a", "b", "m"]);
  });

  it("keeps a strong item that MMR would place behind a weak one", () => {
    const candidates = [
      item("user_memory", "anchor", 1, "alpha beta"),
      item("user_memory", "strong", 2, "alpha beta"),
      item("agent_memory", "weak", 8, "other topic")
    ];
    expect(ids(candidates)).toEqual(["anchor", "weak", "strong"]);
    const kept = fuseRanked(candidates, { limit: 10, relativity: 0.95 });
    expect(kept.map((hit) => hit.id)).toEqual(["anchor", "strong"]);
    expect(kept.map((hit) => hit.relativity)).toEqual([1, ownOf(2)]);
    expect(ownOf(2)).toBeGreaterThanOrEqual(0.95);
    expect(ownOf(8)).toBeLessThan(0.95);
  });

  it("caps the combined list and counts each project topic once", () => {
    const projects = Array.from({ length: 30 }, (_, index) => item("project", `topic-${index}`, index + 1, "same topic"));
    expect(fuseRanked(projects, { limit: 25 })).toHaveLength(25);
    const mixed = [
      ...Array.from({ length: 20 }, (_, index) => ({ ...item("user_memory", `user-${index}`, index + 1, "same"), entries: 4 })),
      ...Array.from({ length: 15 }, (_, index) => ({ ...item("project", `topic-${index}`, index + 1, "same"), entries: 4 }))
    ];
    const capped = fuseRanked(mixed, { limit: 25 });
    expect(capped).toHaveLength(25);
    expect(capped.filter((hit) => hit.path === "project").length + capped.filter((hit) => hit.path === "user_memory").length).toBe(25);
  });

  it("orders three rank-1 items as user, then agent, then project", () => {
    const hits = fuseRanked([
      item("project", "p", 1, "same"),
      item("agent_memory", "a", 1, "same"),
      item("user_memory", "u", 1, "same")
    ], { limit: 10 });
    expect(hits.map((hit) => hit.path)).toEqual(["user_memory", "agent_memory", "project"]);
    expect(hits.map((hit) => hit.relativity)).toEqual([1, 1, 1]);
  });

  it("does not copy a score onto the fused hit", () => {
    const hits = fuseRanked([item("user_memory", "u", 1, "alpha", 0.77)], { limit: 5 });
    expect(hits).toEqual([{ id: "u", path: "user_memory", relativity: 1 }]);
    expect(hits[0]).not.toHaveProperty("score");
  });

  it("keeps the relative order of the other paths when one path is left out", () => {
    const candidates = [
      item("user_memory", "u1", 1, "same"),
      item("user_memory", "u2", 2, "same"),
      item("agent_memory", "a1", 1, "same"),
      item("agent_memory", "a2", 2, "same"),
      item("project", "p1", 1, "same"),
      item("project", "p2", 2, "same")
    ];
    const all = fuseRanked(candidates, { limit: 25 }).map((hit) => `${hit.path}:${hit.id}`);
    for (const path of ["user_memory", "agent_memory", "project"] as const) {
      const without = fuseRanked(candidates.filter((candidate) => candidate.path !== path), { limit: 25 })
        .map((hit) => `${hit.path}:${hit.id}`);
      expect(without).toEqual(all.filter((key) => !key.startsWith(`${path}:`)));
    }
  });
});

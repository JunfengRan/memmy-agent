import { describe, expect, it } from "vitest";
import {
  applyRouteDecision,
  createRouterState,
  parseRouteDecision,
  routerSystemPrompt,
  routerUserPrompt,
  summarizeSession,
  SUPERAGENT_ROUTER_PROMPT_VERSION,
  type RouterState,
} from "../../../src/core/session/superagent-session-router.js";

function snapshot(state: RouterState): string {
  return JSON.stringify(state);
}

describe("superagent session router", () => {
  it("accepts a message as a new session and keeps only that turn", () => {
    const state = createRouterState();
    const applied = applyRouteDecision(state, "fix the login", "done", {
      kind: "accept",
      title: "Fix the login",
    });
    expect(applied).toEqual({
      kind: "accept",
      sessionId: "s1",
      title: "Fix the login",
      reason: "Accepted as a new session",
    });
    expect(state.sessions).toEqual([
      { id: "s1", title: "Fix the login", stopped: false, turns: [{ query: "fix the login", answer: "done" }] },
    ]);
  });

  it("attaches only to the named open session", () => {
    const state = createRouterState();
    applyRouteDecision(state, "fix the login", "opened a patch", { kind: "accept", title: "Fix the login" });
    applyRouteDecision(state, "add a dark mode", "filed separately", { kind: "accept", title: "Add a dark mode" });
    const applied = applyRouteDecision(state, "continue the login fix", "pushed", {
      kind: "attach",
      sessionId: "s1",
    });
    expect(applied).toMatchObject({ kind: "attach", sessionId: "s1" });
    expect(state.sessions[0]?.turns).toHaveLength(2);
    expect(state.sessions[1]?.turns).toHaveLength(1);
  });

  it("refuses an attach that misses or names a stopped session without changing state", () => {
    const state = createRouterState();
    applyRouteDecision(state, "fix the login", "done", { kind: "accept", title: "Fix the login" });
    applyRouteDecision(state, "stop that", "", { kind: "stop", sessionId: "s1", reason: "user asked to stop" });
    const before = snapshot(state);

    expect(applyRouteDecision(state, "continue it", "x", { kind: "attach", sessionId: "s1" })).toEqual({
      refused: "A person stopped s1; new work needs an accept",
    });
    expect(applyRouteDecision(state, "continue it", "x", { kind: "attach", sessionId: "s9" })).toEqual({
      refused: "Unknown session s9",
    });
    expect(snapshot(state)).toBe(before);
    expect(state.sessions[0]?.stopped).toBe(true);
    expect(state.sessions[0]?.turns).toHaveLength(1);
  });

  it("refuses an accept without a title, an ignore without a reason, and an overlong title", () => {
    const state = createRouterState();
    expect(applyRouteDecision(state, "hi", "", { kind: "accept" })).toEqual({ refused: "accept needs title" });
    expect(applyRouteDecision(state, "thanks", "", { kind: "ignore" })).toEqual({ refused: "ignore needs reason" });
    expect(applyRouteDecision(state, "hi", "", { kind: "accept", title: "x".repeat(201) })).toEqual({
      refused: "title exceeds 200 characters",
    });
    expect(state.sessions).toEqual([]);
  });

  it("ignores chatter without opening a session", () => {
    const state = createRouterState();
    const applied = applyRouteDecision(state, "thanks", "", { kind: "ignore", reason: "thanks" });
    expect(applied).toEqual({ kind: "ignore", sessionId: null, title: null, reason: "thanks" });
    expect(state.sessions).toEqual([]);
  });

  it("summarizes the latest turn only", () => {
    const state = createRouterState();
    applyRouteDecision(state, "q".repeat(300), "a".repeat(300), { kind: "accept", title: "Long" });
    applyRouteDecision(state, "second question", "second answer", { kind: "attach", sessionId: "s1" });
    const summary = summarizeSession(state.sessions[0]!);
    expect(summary.turns).toBe(2);
    expect(summary.lastQuery).toBe("second question");
    expect(summary.lastAnswer).toBe("second answer");
    expect(summary.lastQuery.length).toBeLessThan(300);
  });

  it("parses a fenced decision and drops thinking text", () => {
    const decision = parseRouteDecision(`<think>maybe attach</think>\n\`\`\`json\n{"kind":"accept","title":"Fix the login"}\n\`\`\``);
    expect(decision).toEqual({ kind: "accept", title: "Fix the login" });
  });

  it("states the dispatch rule that a similar subject is a new session", () => {
    const prompt = routerSystemPrompt();
    expect(SUPERAGENT_ROUTER_PROMPT_VERSION).toBe("2026-11-06.1");
    expect(prompt).toContain("similar subject is a new request");
    expect(prompt).toContain("exactly one open session");
    expect(prompt).toContain("stopped session cannot be attached");
    const user = routerUserPrompt(
      [{ id: "s1", title: "Fix the login", stopped: false, turns: 1, lastQuery: "fix the login", lastAnswer: "done" }],
      "add a dark mode",
    );
    expect(user).toContain("s1");
    expect(user).toContain("add a dark mode");
    expect(user).not.toContain("fix the login fix");
  });
});

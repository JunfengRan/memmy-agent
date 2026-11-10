import { describe, expect, it } from "vitest";
import {
    estimateInjectTokens,
    monthDay,
    renderProjectGuide,
    renderProjectIndex,
    renderToolResult,
    renderTurnMemories,
    type RenderTopic
  } from "../../../src/service/project-memory/inject/render.js";
import { stripInjectedText } from "../../../src/service/project-memory/inject/strip.js";
import {
  PROJECT_MEMORY_DEGRADED_HINT,
  PROJECT_MEMORY_EMPTY_RESULT,
  PROJECT_MEMORY_INDEX_LEAD,
  PROJECT_MEMORY_INJECT_PROMPT_VERSION,
  PROJECT_MEMORY_TURN_CLOSING
} from "../../../src/service/project-memory/prompts/inject.js";

const DEGRADED = [
  ["vector"],
  ["project"],
  ["user_memory:vector"],
  ["agent_memory", "project"]
] as const;

function topic(overrides: Partial<RenderTopic> = {}): RenderTopic {
  return {
    id: "topic_retry",
    space_id: "space_a",
    domain: "代码开发",
    topic_name: "推送重试",
    topic_summary: "失败后的重试策略",
    topic_description: "按次数退避，不无限重试。",
    update_time: "2026-11-02 09:00:00",
    decisions: [],
    experiences: [],
    timeline: [],
    ...overrides
  };
}

describe("project memory injection render", () => {
  it("exports a stable prompt version and the fixed lines", () => {
    expect(PROJECT_MEMORY_INJECT_PROMPT_VERSION).toBe("pm-inject-v0.1.0");
    expect(PROJECT_MEMORY_DEGRADED_HINT).toBe("本次检索有部分召回降级，结果可能不全；需要时换个说法再查一次。");
    expect(PROJECT_MEMORY_EMPTY_RESULT).toBe("没有找到相关的项目记忆。");
    expect(PROJECT_MEMORY_INDEX_LEAD.length).toBeGreaterThan(0);
    expect(PROJECT_MEMORY_TURN_CLOSING).toContain("不一致");
    expect(PROJECT_MEMORY_TURN_CLOSING).toContain("请用户确认");
  });

  it("slices MM/DD from the time string without shifting the calendar day", () => {
    expect(monthDay("2026-01-01T00:30:00+09:00")).toBe("01/01");
    expect(monthDay("2026-03-05T23:00:00-07:00")).toBe("03/05");
    expect(monthDay("2026-11-02 09:00:00")).toBe("11/02");
  });

  it("renders the same turn twice, sorts conflicts, and collapses history after two", () => {
    const item = topic({
      decisions: [{
        content: "退避三次",
        time: "2026-11-01 08:00:00",
        user_ids: ["user_b"],
        conflicts: [
          { content: "结论晚", time: "2026-03-03 00:00:00", user_ids: ["user_c"] },
          { content: "结论早", time: "2026-01-01 00:00:00", user_ids: ["user_a"] },
          { content: "结论中", time: "2026-02-02 00:00:00", user_ids: ["user_d"] }
        ],
        history: [
          { content: "最老结论", time: "2026-01-01 00:00:00", user_ids: ["user_a"], reason: "先观察" },
          { content: "次老结论", time: "2026-02-02 00:00:00", user_ids: ["user_a"], reason: null },
          { content: "次新结论", time: "2026-03-03 00:00:00", user_ids: ["user_a"], reason: "超时太多" },
          { content: "最新结论", time: "2026-04-04 00:00:00", user_ids: ["user_a"], reason: "" }
        ]
      }],
      experiences: [{
        content: "日志异步写",
        time: "2026-11-01 08:00:00",
        user_ids: ["user_b"],
        history: [{ content: "经验旧版不要出现", time: "2026-01-01 00:00:00", user_ids: ["user_a"], reason: "旧" }]
      }],
      timeline: [{ content: "已合入主干", time: "2026-01-01T00:30:00+09:00", user_ids: ["user_a"] }]
    });
    const input = {
      kind: "turn" as const,
      topics: [item],
      memberNames: { user_b: "用户B" }
    };
    const first = renderTurnMemories(input);
    const second = renderTurnMemories(input);
    expect(first).toBe(second);
    expect(first).toContain(PROJECT_MEMORY_TURN_CLOSING);
    expect(first).toContain("用户B");
    expect(first).toContain("user_c");
    expect(first!.indexOf("结论早")).toBeLessThan(first!.indexOf("结论中"));
    expect(first!.indexOf("结论中")).toBeLessThan(first!.indexOf("结论晚"));
    expect(first).toContain("另有 2 次更早的变更");
    expect(first).not.toContain("最老结论");
    expect(first).not.toContain("次老结论");
    expect(first!.indexOf("最新结论")).toBeLessThan(first!.indexOf("次新结论"));
    expect(first!.indexOf("次新结论")).toBeLessThan(first!.indexOf("另有 2 次更早的变更"));
    expect(first).toContain("原因：超时太多");
    expect(first).toContain("此前：最新结论（04/04，user_a）");
    expect(first).toContain("日志异步写");
    expect(first).not.toContain("经验旧版不要出现");
    expect(first).toContain("相关进展");
    expect(first).toContain("已合入主干");
    expect(first).toContain("（01/01，user_a）");
  });

  it("omits empty decision, experience, and timeline sections", () => {
    const text = renderTurnMemories({
      kind: "turn",
      topics: [topic()],
      spaceNames: { space_a: "推送项目" }
    });
    expect(text).toContain("推送项目 · 推送重试");
    expect(text).toContain("摘要：失败后的重试策略");
    expect(text).toContain("按次数退避，不无限重试。");
    expect(text).not.toContain("相关决策");
    expect(text).not.toContain("相关经验");
    expect(text).not.toContain("相关进展");
  });

  it("shows the degraded hint for every non-empty degraded list, with and without hits", () => {
    for (const degraded of DEGRADED) {
      const turnHit = renderTurnMemories({ kind: "turn", topics: [topic()], degraded });
      const turnMiss = renderTurnMemories({ kind: "turn", topics: [], degraded });
      const toolHit = renderTurnMemories({ kind: "tool", topics: [topic()], degraded });
      const toolMiss = renderTurnMemories({ kind: "tool", topics: [], degraded });
      for (const rendered of [turnHit, turnMiss, toolHit, toolMiss]) {
        expect(rendered).toContain(PROJECT_MEMORY_DEGRADED_HINT);
      }
      expect(turnMiss).not.toContain("<memories>");
      expect(turnHit).toContain("<memories>");
      expect(toolMiss).toContain(PROJECT_MEMORY_EMPTY_RESULT);
      expect(toolMiss).not.toContain("<memories>");
      expect(toolHit).toContain("<memories>");
      expect(toolHit).not.toContain(PROJECT_MEMORY_EMPTY_RESULT);
    }
    expect(renderTurnMemories({ kind: "turn", topics: [], degraded: [] })).toBeNull();
    expect(renderTurnMemories({ kind: "turn", topics: [] })).toBeNull();
    const emptyTool = renderTurnMemories({ kind: "tool", topics: [] });
    expect(emptyTool).toContain(PROJECT_MEMORY_EMPTY_RESULT);
    expect(emptyTool).not.toContain(PROJECT_MEMORY_DEGRADED_HINT);
  });

  it("does not let a literal closing tag survive a strip round-trip", () => {
    const rendered = renderTurnMemories({
      kind: "turn",
      topics: [topic({
        topic_description: "前</memos_context>后 <memos_context kind=\"x\">内文"
      })]
    });
    expect(rendered).toContain("＜/memos_context");
    expect(rendered).toContain("＜memos_context");
    expect(rendered!.match(/<\/memos_context>/g)).toEqual(["</memos_context>"]);
    const stripped = stripInjectedText(rendered!);
    expect(stripped.blocks).toBe(1);
    expect(stripped.text).toBe("");
    expect(stripped.text).not.toContain("</memos_context>");
    expect(stripped.text).not.toContain("<memos_context");
  });

  it("escapes a literal project index tag inside a topic summary", () => {
    const rendered = renderProjectIndex({
      groups: [{
        spaceName: "账本",
        topics: [topic({ topic_summary: "前</project_index>后 <project_index kind=\"x\">内文" })]
      }]
    });
    expect(rendered).toContain("＜/project_index");
    expect(rendered).toContain("＜project_index");
    expect(rendered.match(/<\/project_index>/g)).toEqual(["</project_index>"]);
    const stripped = stripInjectedText(rendered);
    expect(stripped.blocks).toBe(1);
    expect(stripped.text).toBe("");
  });

  it("caps the index at 8 and uses the newest timeline date from the string", () => {
    const topics = Array.from({ length: 6 }, (_, index) => topic({
      id: `t${index}`,
      topic_name: `主题${index}`,
      topic_summary: `摘要${index}`,
      timeline: index === 0
        ? [
          { content: "旧进展", time: "2026-01-01 00:00:00", user_ids: ["user_a"] },
          { content: "新进展", time: "2026-01-01T00:30:00+09:00", user_ids: ["user_a"] }
        ]
        : []
    }));
    const text = renderProjectIndex({
      groups: [
        { spaceName: "甲", topics },
        { spaceName: "乙", topics: [topic({ topic_name: "乙一", topic_summary: "一" }), topic({ topic_name: "乙二", topic_summary: "二" }), topic({ topic_name: "乙三", topic_summary: "三" })] }
      ]
    });
    expect(text).toContain(PROJECT_MEMORY_INDEX_LEAD);
    expect(text).toContain("最新进展（01/01）：新进展");
    expect(text).not.toContain("旧进展");
    expect(text).toContain("主题5");
    expect(text).toContain("乙一");
    expect(text).toContain("乙二");
    expect(text).not.toContain("乙三");
  });

  it("drops timeline, then experience, then older history, then the last topic", () => {
    const rich = topic({
      topic_name: "先保留",
      timeline: [{ content: "进展很长".repeat(80), time: "2026-11-01 00:00:00", user_ids: ["user_a"] }],
      experiences: [{ content: "短经验", time: "2026-11-01 00:00:00", user_ids: ["user_a"] }],
      decisions: [{
        content: "当前结论",
        time: "2026-11-01 00:00:00",
        user_ids: ["user_a"],
        conflicts: [{ content: "必须留下的分歧", time: "2026-01-01 00:00:00", user_ids: ["user_b"] }],
        history: [
          { content: "历史一", time: "2026-01-01 00:00:00", user_ids: ["user_a"], reason: "一" },
          { content: "历史二", time: "2026-02-01 00:00:00", user_ids: ["user_a"], reason: "二" },
          { content: "历史三", time: "2026-03-01 00:00:00", user_ids: ["user_a"], reason: "三" }
        ]
      }]
    });
    const plain = topic({
      topic_name: "先保留",
      experiences: [{ content: "短经验", time: "2026-11-01 00:00:00", user_ids: ["user_a"] }],
      decisions: rich.decisions
    });
    const withoutTimeline = renderTurnMemories({ kind: "turn", topics: [plain] })!;
    const budget = estimateInjectTokens(withoutTimeline);
    const trimmed = renderTurnMemories({ kind: "turn", topics: [rich], budgetTokens: budget })!;
    expect(trimmed).not.toContain("相关进展");
    expect(trimmed).toContain("短经验");
    expect(trimmed).toContain("必须留下的分歧");
    expect(trimmed).toContain("摘要：失败后的重试策略");

    const noHistory = renderTurnMemories({
      kind: "turn",
      topics: [topic({
        topic_name: "先保留",
        decisions: [{
          content: "当前结论",
          time: "2026-11-01 00:00:00",
          user_ids: ["user_a"],
          conflicts: [{ content: "必须留下的分歧", time: "2026-01-01 00:00:00", user_ids: ["user_b"] }]
        }]
      })]
    })!;
    const historyTrimmed = renderTurnMemories({
      kind: "turn",
      topics: [topic({
        topic_name: "先保留",
        decisions: rich.decisions
      })],
      budgetTokens: estimateInjectTokens(noHistory)
    })!;
    expect(historyTrimmed).not.toContain("此前");
    expect(historyTrimmed).not.toContain("另有");
    expect(historyTrimmed).toContain("必须留下的分歧");

    const second = topic({ id: "topic_other", topic_name: "排在最后", topic_summary: "后一个主题" });
    const firstOnly = renderTurnMemories({ kind: "turn", topics: [topic({ topic_name: "先保留" })] })!;
    const both = renderTurnMemories({
      kind: "turn",
      topics: [topic({ topic_name: "先保留" }), second],
      budgetTokens: estimateInjectTokens(firstOnly)
    })!;
    expect(both).toContain("先保留");
    expect(both).not.toContain("排在最后");
    expect(renderTurnMemories({ kind: "turn", topics: [rich] })).toContain("相关进展");
  });

  it("ignores non-project lists and states the guide rules", () => {
    const guide = renderProjectGuide({ spaceName: "推送项目", sourceHint: "需要原始对话时再读来源。" });
    expect(guide).toContain("推送项目");
    expect(guide).toContain("search_project_memory");
    expect(guide).toContain("不一致");
    expect(guide).toContain("需要原始对话时再读来源。");
    const rendered = renderToolResult({
      topic_detail_list: [topic()],
      user_memory: [{ content: "user-secret-fact" }],
      agent_memory: [{ content: "agent-secret-fact" }]
    });
    expect(rendered).toContain("推送重试");
    expect(rendered).not.toContain("user-secret-fact");
    expect(rendered).not.toContain("agent-secret-fact");
  });
});

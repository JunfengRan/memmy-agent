import { describe, expect, it } from "vitest";
import { parseDisclosures } from "../../../src/service/project-memory/organize/evidence.js";
import type { RawTurnRecord } from "../../../src/service/project-memory/contract/types.js";
import { adoptedBy } from "../../../src/service/project-memory/organize/evidence.js";
import { parseJudgeOutput, type JudgeInput } from "../../../src/service/project-memory/merge/judge.js";

const turn = (role: "assistant" | "user", content: string): RawTurnRecord => ({
  turnId: "turn1", taskId: "task1", conversationId: "c1", role, roleId: role === "user" ? "u1" : null,
  roleName: null, chatTime: "2026-11-16T10:00:00+08:00", chatTimeInferred: false, content, toolCalls: []
});
describe("conversation disclosure evidence", () => {
  it("accepts assistant quotes from real context and keeps provenance", () => {
    const context = [turn("assistant", "当前方案：异步重试；另一项：立即停止。请确认。")];
    expect(parseDisclosures([{ context_idx: 0, conclusions: ["异步重试", "立即停止"] }], [], context))
      .toEqual([{ turnId: "turn1", time: context[0]!.chatTime, conclusions: ["异步重试", "立即停止"] }]);
  });
  it("rejects user text, invented quotes and stripped injection blocks", () => {
    const rows = [{ message_idx: 0, conclusions: ["异步重试"] }];
    expect(parseDisclosures(rows, [turn("user", "异步重试")], [])).toEqual([]);
    expect(parseDisclosures(rows, [turn("assistant", "请确认")], [])).toEqual([]);
    expect(parseDisclosures(rows, [turn("assistant", "<memos_context>异步重试</memos_context>")], [])).toEqual([]);
  });
  it("requires actual later member text before classifying an assistant statement as adopted", () => {
    const assistant = turn("assistant", "异步重试");
    const member = { ...turn("user", "我采纳异步重试"), chatTime: "2026-11-16T10:01:00+08:00" };
    expect(adoptedBy({ message_idx: 1, quote: "我采纳异步重试" }, assistant, [assistant, member], [])).toEqual(["u1"]);
    expect(adoptedBy({ message_idx: 1, quote: "我同意立即停止" }, assistant, [assistant, member], [])).toEqual([]);
    expect(adoptedBy({ message_idx: 1, quote: "我采纳异步重试" }, { ...assistant, chatTime: "2026-11-16T11:00:00+08:00" }, [assistant, member], [])).toEqual([]);
  });
  it("rejects missing targets, fabricated references and disclosures made after the member's statement", () => {
    const input: JudgeInput = {
      drafts: [{ draftId: "d1", kind: "decision", category: null, content: "立即停止", messageIdx: 0,
        time: "2026-11-16T10:01:00+08:00", userIds: ["u1"], role: "user", reason: null, signals: [], topicId: "t1" }],
      topics: [{ topicId: "t1", spaceId: "s1", domain: "工程", topicName: "推送", topicSummary: "", topicDescription: "",
        revision: 1, createTime: "", updateTime: "", experiences: [], timeline: [], sources: [],
        decisions: [{ id: "dec1", content: "异步重试", time: "", userIds: ["u1"], history: [],
          conflicts: [{ seq: 1, content: "立即停止", time: "", userIds: ["u2"] }] }] }],
      stateHints: [], disclosures: [{ turnId: "a1", time: "2026-11-16T10:00:00+08:00", conclusions: ["停止当前推送"] }]
    };
    const result = (targets: unknown[]) => parseJudgeOutput({ drafts: [{ draft_id: "d1", same_question_as: "dec1", informed_targets: targets }] }, input).labels.get("d1")!.informedTargets;
    expect(result([{ target: "conflict:1", disclosure_idx: 0, conclusion_idx: 0 }])).toEqual([{ target: "conflict:1", content: "立即停止" }]);
    expect(result([{ target: "conflict:99", disclosure_idx: 0, conclusion_idx: 0 },
      { target: "conflict:1", disclosure_idx: 5, conclusion_idx: 0 }])).toEqual([]);
    input.disclosures![0]!.conclusions = ["异步重试", "立即停止"];
    expect(result([])).toEqual([{ target: "content", content: "异步重试" }, { target: "conflict:1", content: "立即停止" }]);
    input.topics[0]!.decisions[0]!.content = "重试条件 x>3";
    input.topics[0]!.decisions[0]!.conflicts[0]!.content = "重试条件 x<3";
    input.disclosures![0]!.conclusions = ["重试条件 x>3"];
    expect(result([])).toEqual([{ target: "content", content: "重试条件 x>3" }]);
    input.disclosures![0]!.time = "2026-11-16T10:02:00+08:00";
    expect(result([{ target: "conflict:1", disclosure_idx: 0, conclusion_idx: 0 }])).toEqual([]);
  });
});

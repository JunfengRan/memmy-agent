import { describe, expect, it } from "vitest";
import type { RawTurnRecord, TopicSnapshot } from "../../../src/service/project-memory/contract/types.js";
import { parseOrganizeOutput, type OrganizeInput } from "../../../src/service/project-memory/organize/organizer.js";
import { parseRetrieveRoute, parseWriteRoute, type SessionCard } from "../../../src/service/project-memory/route/router.js";

const session: SessionCard = {
  topicId: "topic_push",
  spaceId: "space_a",
  domain: "代码开发",
  topicName: "推送服务重试",
  topicSummary: "推送失败后的重试策略",
  topicDescription: "",
  decisions: ["推送失败后指数退避重试三次。"]
};

function turn(): RawTurnRecord {
  return {
    turnId: "t1",
    taskId: "task",
    conversationId: "c",
    role: "user",
    roleId: "u",
    roleName: "林",
    chatTime: "2026-10-29T10:00:00+08:00",
    chatTimeInferred: false,
    content: "推送失败就指数退避重试三次。",
    toolCalls: []
  };
}

function organizeInput(locked: OrganizeInput["lockedTopic"], candidates: TopicSnapshot[] = []): OrganizeInput {
  return {
    instructions: null,
    domains: [{ domain: "代码开发", description: "" }],
    requestDomains: ["代码开发"],
    messages: [turn()],
    context: [],
    candidates,
    conflictsShown: new Set(),
    lockedTopic: locked
  };
}

describe("superagent session router", () => {
  it("accepts a new session and clamps the title", () => {
    expect(parseWriteRoute({ kind: "accept", title: "一二三四五六七八九十一二三四五六七八九十多", summary: "失败后的重试" }, [session])).toEqual({
      kind: "accept",
      title: "一二三四五六七八九十一二三四五六七八九十",
      summary: "失败后的重试"
    });
  });

  it("refuses to attach a session that is not in the list", () => {
    expect(() => parseWriteRoute({ kind: "attach", topic_id: "topic_missing" }, [session])).toThrow(/session/);
  });

  it("keeps a retrieve selection in the router's order and drops unknown ids only when some remain", () => {
    expect(parseRetrieveRoute({ kind: "retrieve", topic_ids: ["topic_push", "topic_missing", "topic_push"] }, [session])).toEqual({
      kind: "retrieve",
      topicIds: ["topic_push"]
    });
    expect(parseRetrieveRoute({ kind: "retrieve", topic_ids: [] }, [session])).toEqual({ kind: "retrieve", topicIds: [] });
    expect(() => parseRetrieveRoute({ kind: "retrieve", topic_ids: ["topic_missing"] }, [session])).toThrow(/session/);
  });

  it("puts an organizer draft on the new session the router accepted", () => {
    const result = parseOrganizeOutput({
      drafts: [{ kind: "decision", content: "推送失败后指数退避重试三次。", message_idx: 0, user_ids: ["u"], topic: { topic_id: "topic_missing" } }],
      new_topics: [{ ref: "n1", topic_name: "推送服务重试", topic_summary: "推送失败后的重试策略", topic_description: "间隔逐渐加长。" }]
    }, organizeInput({ mode: "new", title: "路由器标题", summary: "路由器摘要" }));

    expect(result.deferred).toEqual([]);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.target).toEqual({ newTopicRef: "session" });
    expect(result.newTopics.size).toBe(1);
    expect(result.newTopics.get("session")).toMatchObject({
      topicName: "推送服务重试",
      topicSummary: "推送失败后的重试策略",
      topicDescription: "间隔逐渐加长。"
    });
  });

  it("keeps an attached draft on the router session when the organizer tries to open another topic", () => {
    const candidate = {
      topicId: "topic_push",
      spaceId: "space_a",
      domain: "代码开发",
      topicName: "推送服务重试",
      topicSummary: "推送失败后的重试策略",
      topicDescription: "",
      revision: 1,
      createTime: "2026-10-29T10:00:00+08:00",
      updateTime: "2026-10-29T10:00:00+08:00",
      decisions: [{ id: "dec_1", content: "推送失败后指数退避重试三次。", time: "2026-10-29T10:00:00+08:00", userIds: ["u"], conflicts: [], history: [] }],
      experiences: [],
      timeline: [],
      sources: []
    } satisfies TopicSnapshot;
    const result = parseOrganizeOutput({
      drafts: [{
        kind: "decision",
        content: "推送失败后改为重试五次。",
        message_idx: 0,
        user_ids: ["u"],
        topic: { new_topic: "n1" },
        same_question_as: "dec_1"
      }],
      new_topics: [{ ref: "n1", topic_name: "另一个主题", topic_summary: "不该出现", topic_description: "" }]
    }, organizeInput({ mode: "existing", topicId: "topic_push" }, [candidate]));

    expect(result.newTopics.size).toBe(0);
    expect(result.drafts[0]).toMatchObject({ target: { topicId: "topic_push" }, sameQuestionAs: "dec_1" });
  });
});

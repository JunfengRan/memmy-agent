import { afterEach, describe, expect, it } from "vitest";
import { call, combinedStages, createProjectMemoryHarness, drain, setupSpace, stubStages, type OrganizePayload } from "./helpers.js";

const harness = createProjectMemoryHarness();
afterEach(() => harness.cleanup());

const SPACE = "space_memos_cloud";
const BASE = "本机整理结果存入 SQLite，每个 Space 一个库文件。";
const SINGLE_DB = "本机整理结果存入单个 SQLite 库，按 space_id 分表。";
const LANCEDB = "本机整理结果改用 LanceDB 统一存储，不再使用 SQLite。";

type Turn = { user: string; name: string; conversation: string; time: string; content: string };

function decisionDraft(payload: OrganizePayload, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const topic = payload.candidate_topics[0];
  const decision = topic?.decisions?.[0];
  return {
    kind: "decision",
    content,
    message_idx: 0,
    user_ids: [payload.messages[0]!.user_id],
    reason: null,
    topic: topic ? { topic_id: topic.topic_id } : { new_topic: "n1" },
    same_question_as: decision?.id ?? null,
    same_as: null,
    approved_by: [],
    resolve: null,
    same_experience_as: null,
    experience_change: null,
    ...extra
  };
}

function reply(drafts: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { drafts, new_topics: [], topic_updates: [], informed_decision_ids: [], deferred: [], ...extra };
}

async function add(service: Parameters<typeof call>[0], turn: Turn): Promise<string> {
  const accepted = await call(service, "add/message", {
    user_id: turn.user,
    agent_id: "codex",
    conversation_id: turn.conversation,
    space_ids: [SPACE],
    allow_memory_view: ["project"],
    messages: [{ role: "user", role_id: turn.user, role_name: turn.name, chat_time: turn.time, content: turn.content }]
  });
  expect(accepted.code).toBe(0);
  await drain(service);
  const status = await call(service, "get/status", { task_id: accepted.data.task_id });
  expect(status.data.status).toBe("completed");
  return accepted.data.task_id as string;
}

async function onlyDecision(service: Parameters<typeof call>[0]) {
  const listed = await call(service, "get/memory", { space_id: SPACE });
  expect(listed.data.topic_detail_list).toHaveLength(1);
  const decisions = listed.data.topic_detail_list[0].decisions as Array<Record<string, unknown>>;
  expect(decisions).toHaveLength(1);
  return decisions[0]!;
}

/** PRD「决策的维护」/ v3 §2.2.9 四轮分歧示例. */
describe("project memory decision golden", () => {
  async function seedBase(rounds: Array<(payload: OrganizePayload) => Record<string, unknown>>) {
    const stub = stubStages(combinedStages((payload, callIndex) => rounds[callIndex - 1]!(payload)));
    const { service } = harness.createService();
    await setupSpace(service, SPACE);
    await add(service, { user: "user_b", name: "用户B", conversation: "codex:b", time: "2026-10-29 10:20:00", content: "本机整理结果就存 SQLite，每个 Space 一个库文件。" });
    return { service, stub };
  }

  const baseRound = (payload: OrganizePayload) => reply([decisionDraft(payload, BASE)], {
    new_topics: [{ ref: "n1", topic_name: "项目记忆接口开发", topic_summary: "实现项目记忆的存储与读写接口", topic_description: "本机整理结果的存储方式在讨论中。" }]
  });

  it("appends conflicts, joins, and resolves only after the member was informed", async () => {
    const { service, stub } = await seedBase([
      baseRound,
      (payload) => reply([decisionDraft(payload, SINGLE_DB)]),
      (payload) => reply([decisionDraft(payload, "同意单库按 space_id 分表", { same_as: "conflict:1" })]),
      (payload) => reply([decisionDraft(payload, LANCEDB)]),
      (payload) => {
        const decisionId = payload.candidate_topics[0]?.decisions?.[0]?.id;
        return reply([decisionDraft(payload, SINGLE_DB, { resolve: { pick: "conflict:1" } })], {
          informed_decision_ids: decisionId ? [decisionId] : []
        });
      }
    ]);

    await add(service, { user: "user_c", name: "用户C", conversation: "codex:c", time: "2026-10-30 14:05:00", content: SINGLE_DB });
    let decision = await onlyDecision(service);
    expect(decision).toMatchObject({
      content: BASE,
      user_ids: ["user_b"],
      conflicts: [{ content: SINGLE_DB, time: "2026-10-30T14:05:00+08:00", user_ids: ["user_c"] }]
    });

    await add(service, { user: "user_d", name: "用户D", conversation: "codex:d", time: "2026-10-30 14:30:00", content: "同意单库按 space_id 分表。" });
    decision = await onlyDecision(service);
    expect(decision.conflicts).toEqual([{ content: SINGLE_DB, time: "2026-10-30T14:05:00+08:00", user_ids: ["user_c", "user_d"] }]);

    await add(service, { user: "user_e", name: "用户E", conversation: "codex:e", time: "2026-10-30 15:30:00", content: LANCEDB });
    decision = await onlyDecision(service);
    expect(decision.content).toBe(BASE);
    expect((decision.conflicts as unknown[])).toHaveLength(2);

    // The Agent shows user_b the three conclusions: search records had_conflicts for this conversation.
    const searched = await call(service, "search/memory", {
      user_id: "user_b",
      query: "本机整理结果存在哪里？SQLite 还是 LanceDB",
      conversation_id: "codex:b2",
      space_ids: SPACE,
      include_memory_view: ["project"]
    });
    expect(searched.data.topic_detail_list[0].decisions[0].conflicts).toHaveLength(2);

    await add(service, { user: "user_b", name: "用户B", conversation: "codex:b2", time: "2026-10-31 10:00:00", content: "以用户C 的为准。" });
    expect(stub.judge.at(-1)!.conflicts_shown).toHaveLength(1);
    decision = await onlyDecision(service);
    expect(decision).toEqual({
      content: SINGLE_DB,
      time: "2026-10-30T14:05:00+08:00",
      user_ids: ["user_c", "user_d"],
      history: [
        { content: BASE, time: "2026-10-29T10:20:00+08:00", user_ids: ["user_b"], reason: "用户B 确定以用户C 的结论为准" },
        { content: LANCEDB, time: "2026-10-30T15:30:00+08:00", user_ids: ["user_e"], reason: "用户B 确定以用户C 的结论为准" }
      ]
    });
  });

  it("does not resolve when the conflicts were never shown in that conversation", async () => {
    const { service } = await seedBase([
      baseRound,
      (payload) => reply([decisionDraft(payload, SINGLE_DB)]),
      (payload) => {
        const decisionId = payload.candidate_topics[0]?.decisions?.[0]?.id;
        return reply([decisionDraft(payload, SINGLE_DB, { resolve: { pick: "conflict:1" } })], {
          informed_decision_ids: decisionId ? [decisionId] : []
        });
      }
    ]);
    await add(service, { user: "user_c", name: "用户C", conversation: "codex:c", time: "2026-10-30 14:05:00", content: SINGLE_DB });
    await add(service, { user: "user_b", name: "用户B", conversation: "codex:b3", time: "2026-10-31 10:00:00", content: "以用户C 的为准。" });
    const decision = await onlyDecision(service);
    expect(decision.content).toBe(BASE);
    expect(decision.history).toBeUndefined();
    expect(decision.conflicts).toEqual([{ content: SINGLE_DB, time: "2026-10-30T14:05:00+08:00", user_ids: ["user_c", "user_b"] }]);
  });

  it("rewrites when the conversation shows the content author's approval", async () => {
    const { service } = await seedBase([
      baseRound,
      (payload) => reply([decisionDraft(payload, SINGLE_DB, { approved_by: ["user_b"], reason: "已和用户B 确认" })])
    ]);
    await add(service, { user: "user_c", name: "用户C", conversation: "codex:c", time: "2026-10-30 14:05:00", content: "已和用户B 确认，改为单库按 space_id 分表。" });
    expect(await onlyDecision(service)).toEqual({
      content: SINGLE_DB,
      time: "2026-10-30T14:05:00+08:00",
      user_ids: ["user_c"],
      history: [{ content: BASE, time: "2026-10-29T10:20:00+08:00", user_ids: ["user_b"], reason: "已和用户B 确认" }]
    });
  });

  it("never lets a late submission rewrite a newer decision", async () => {
    const { service } = await seedBase([
      baseRound,
      // Late draft from the content author: would be a rewrite if it were newer.
      (payload) => reply([decisionDraft(payload, LANCEDB)]),
      // Late draft from a new member: kept as a conflict.
      (payload) => reply([decisionDraft(payload, SINGLE_DB)])
    ]);
    await add(service, { user: "user_b", name: "用户B", conversation: "codex:b-old", time: "2026-10-28 09:00:00", content: LANCEDB });
    let decision = await onlyDecision(service);
    expect(decision).toEqual({ content: BASE, time: "2026-10-29T10:20:00+08:00", user_ids: ["user_b"] });

    await add(service, { user: "user_c", name: "用户C", conversation: "codex:c-old", time: "2026-10-28 09:30:00", content: SINGLE_DB });
    decision = await onlyDecision(service);
    expect(decision.content).toBe(BASE);
    expect(decision.conflicts).toEqual([{ content: SINGLE_DB, time: "2026-10-28T09:30:00+08:00", user_ids: ["user_c"] }]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { call, combinedStages, createProjectMemoryHarness, drain, setupSpace, stubStages, type OrganizePayload } from "./helpers.js";

const harness = createProjectMemoryHarness();
afterEach(() => harness.cleanup());

const SPACE = "space_memos_cloud";
const BASE = "本机整理结果存入 SQLite，每个 Space 一个库文件。";
const SINGLE_DB = "本机整理结果存入单个 SQLite 库，按 space_id 分表。";
const LANCEDB = "本机整理结果改用 LanceDB 统一存储，不再使用 SQLite。";
const REVISED = "本机整理结果改为单库并保留只读副本。";
const NEW_CONCLUSION = "本机整理结果按环境分库存放。";
const SPLIT_NOTE = "按部署方式分别适用。";
const T = {
  base: "2026-10-29T10:20:00+08:00",
  c: "2026-10-30T14:05:00+08:00",
  e: "2026-10-30T15:30:00+08:00",
  revised: "2026-10-30T16:00:00+08:00",
  decide: "2026-10-31T10:00:00+08:00"
} as const;

/** Content part is second, so the kept id is not "whichever piece is listed first". */
function splitLabel(): Record<string, unknown> {
  return {
    parts: [
      { content: SINGLE_DB, from: ["conflict:1"] },
      { content: BASE, from: ["content"] }
    ]
  };
}

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
    split: null,
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

async function listDecisions(service: Parameters<typeof call>[0]) {
  const listed = await call(service, "get/memory", { space_id: SPACE });
  expect(listed.data.topic_detail_list).toHaveLength(1);
  return listed.data.topic_detail_list[0].decisions as Array<Record<string, unknown>>;
}

async function onlyDecision(service: Parameters<typeof call>[0]) {
  const decisions = await listDecisions(service);
  expect(decisions).toHaveLength(1);
  return decisions[0]!;
}

async function showConflicts(service: Parameters<typeof call>[0], conversation: string) {
  return call(service, "search/memory", {
    user_id: "user_b",
    query: "本机整理结果存在哪里？SQLite 还是 LanceDB",
    conversation_id: conversation,
    space_ids: SPACE,
    include_memory_view: ["project"]
  });
}

/** PRD「决策的维护」/ v3 §2.2.9 四轮分歧示例. */
describe("project memory decision golden", () => {
  async function seedBase(rounds: Array<(payload: OrganizePayload) => Record<string, unknown>>) {
    const stub = stubStages(combinedStages((payload, callIndex) => rounds[callIndex - 1]!(payload)));
    const { service, db } = harness.createService();
    await setupSpace(service, SPACE);
    await add(service, { user: "user_b", name: "用户B", conversation: "codex:b", time: "2026-10-29 10:20:00", content: "本机整理结果就存 SQLite，每个 Space 一个库文件。" });
    return { service, stub, db };
  }

  async function buildDisagreement(
    last: (payload: OrganizePayload) => Record<string, unknown>,
    options: { join?: boolean; lance?: boolean } = {}
  ) {
    const rounds: Array<(payload: OrganizePayload) => Record<string, unknown>> = [
      baseRound,
      (payload) => reply([decisionDraft(payload, SINGLE_DB)])
    ];
    if (options.join) rounds.push((payload) => reply([decisionDraft(payload, "同意单库按 space_id 分表", { same_as: "conflict:1" })]));
    if (options.lance) rounds.push((payload) => reply([decisionDraft(payload, LANCEDB)]));
    rounds.push(last);
    const seeded = await seedBase(rounds);
    await add(seeded.service, { user: "user_c", name: "用户C", conversation: "codex:c", time: "2026-10-30 14:05:00", content: SINGLE_DB });
    if (options.join) {
      await add(seeded.service, { user: "user_d", name: "用户D", conversation: "codex:d", time: "2026-10-30 14:30:00", content: "同意单库按 space_id 分表。" });
    }
    if (options.lance) {
      await add(seeded.service, { user: "user_e", name: "用户E", conversation: "codex:e", time: "2026-10-30 15:30:00", content: LANCEDB });
    }
    return seeded;
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

  it("updates a conflict in place when its author changes that conclusion", async () => {
    const { service } = await buildDisagreement((payload) => reply([decisionDraft(payload, REVISED)]));
    await add(service, { user: "user_c", name: "用户C", conversation: "codex:c2", time: "2026-10-30 16:00:00", content: REVISED });
    expect(await onlyDecision(service)).toEqual({
      content: BASE,
      time: T.base,
      user_ids: ["user_b"],
      conflicts: [{ content: REVISED, time: T.revised, user_ids: ["user_c"] }]
    });
  });

  it("keeps a joiner on a conflict when its author updates that conclusion", async () => {
    const { service } = await buildDisagreement(
      (payload) => reply([decisionDraft(payload, REVISED)]),
      { join: true }
    );
    await add(service, { user: "user_c", name: "用户C", conversation: "codex:c2", time: "2026-10-30 16:00:00", content: REVISED });
    expect(await onlyDecision(service)).toEqual({
      content: BASE,
      time: T.base,
      user_ids: ["user_b"],
      conflicts: [{ content: REVISED, time: T.revised, user_ids: ["user_c", "user_d"] }]
    });
  });

  it("resolves to a new conclusion after the member was informed", async () => {
    const conversation = "codex:b-new";
    let decisionId = "";
    const { service, stub } = await buildDisagreement((payload) => {
      decisionId = payload.candidate_topics[0]?.decisions?.[0]?.id ?? "";
      return reply([decisionDraft(payload, NEW_CONCLUSION, { resolve: { pick: "new" } })], {
        informed_decision_ids: decisionId ? [decisionId] : []
      });
    }, { lance: true });
    await showConflicts(service, conversation);
    await add(service, { user: "user_b", name: "用户B", conversation, time: "2026-10-31 10:00:00", content: NEW_CONCLUSION });
    expect(stub.judge.at(-1)!.conflicts_shown).toEqual([decisionId]);
    const reason = "用户B 确定了新的结论";
    expect(await onlyDecision(service)).toEqual({
      content: NEW_CONCLUSION,
      time: T.decide,
      user_ids: ["user_b"],
      history: [
        { content: BASE, time: T.base, user_ids: ["user_b"], reason },
        { content: SINGLE_DB, time: T.c, user_ids: ["user_c"], reason },
        { content: LANCEDB, time: T.e, user_ids: ["user_e"], reason }
      ]
    });
  });

  it("resolves by keeping content and moving both conflicts into history", async () => {
    const conversation = "codex:b-keep";
    let decisionId = "";
    const { service } = await buildDisagreement((payload) => {
      decisionId = payload.candidate_topics[0]?.decisions?.[0]?.id ?? "";
      return reply([decisionDraft(payload, BASE, { resolve: { pick: "content" } })], {
        informed_decision_ids: decisionId ? [decisionId] : []
      });
    }, { lance: true });
    await showConflicts(service, conversation);
    await add(service, { user: "user_b", name: "用户B", conversation, time: "2026-10-31 10:00:00", content: "就按每个 Space 一个库文件。" });
    const reason = "用户B 确定以用户B 的结论为准";
    expect(await onlyDecision(service)).toEqual({
      content: BASE,
      time: T.base,
      user_ids: ["user_b"],
      history: [
        { content: SINGLE_DB, time: T.c, user_ids: ["user_c"], reason },
        { content: LANCEDB, time: T.e, user_ids: ["user_e"], reason }
      ]
    });
  });

  it("splits into the kept decision and one new decision after conflicts were shown", async () => {
    const conversation = "codex:b-split";
    let originalId = "";
    const { service, stub, db } = await buildDisagreement((payload) => {
      originalId = payload.candidate_topics[0]?.decisions?.[0]?.id ?? "";
      return reply([decisionDraft(payload, SPLIT_NOTE, { split: splitLabel() })], {
        informed_decision_ids: originalId ? [originalId] : []
      });
    }, { join: true, lance: true });
    await showConflicts(service, conversation);
    await add(service, { user: "user_b", name: "用户B", conversation, time: "2026-10-31 10:00:00", content: SPLIT_NOTE });
    expect(stub.judge.at(-1)!.conflicts_shown).toEqual([originalId]);

    const reason = "用户B 确定各项适用于不同情况";
    const history = [
      { content: BASE, time: T.base, user_ids: ["user_b"], reason },
      { content: SINGLE_DB, time: T.c, user_ids: ["user_c", "user_d"], reason },
      { content: LANCEDB, time: T.e, user_ids: ["user_e"], reason }
    ];
    expect(await listDecisions(service)).toEqual([
      { content: BASE, time: T.decide, user_ids: ["user_b"], history },
      { content: SINGLE_DB, time: T.decide, user_ids: ["user_c", "user_d"], history }
    ]);
    const rows = db.db.prepare(`SELECT id, content FROM pm_decisions ORDER BY rowid`).all() as Array<{ id: string; content: string }>;
    expect(rows).toEqual([
      { id: originalId, content: BASE },
      { id: expect.stringMatching(/^dec_/), content: SINGLE_DB }
    ]);
    expect(rows[1]!.id).not.toBe(originalId);
  });

  it("does not split when the conversation never searched and rewrites as the content author", async () => {
    const { service, stub } = await buildDisagreement((payload) => reply([
      decisionDraft(payload, SPLIT_NOTE, { split: splitLabel() })
    ]), { join: true, lance: true });
    await add(service, { user: "user_b", name: "用户B", conversation: "codex:b-noshow", time: "2026-10-31 10:00:00", content: SPLIT_NOTE });
    expect(stub.judge.at(-1)!.conflicts_shown).toEqual([]);
    expect(await onlyDecision(service)).toEqual({
      content: SPLIT_NOTE,
      time: T.decide,
      user_ids: ["user_b"],
      history: [{ content: BASE, time: T.base, user_ids: ["user_b"], reason: null }],
      conflicts: [
        { content: SINGLE_DB, time: T.c, user_ids: ["user_c", "user_d"] },
        { content: LANCEDB, time: T.e, user_ids: ["user_e"] }
      ]
    });
  });

  it("does not resolve when recall recorded conflicts but the judge sent no informed id", async () => {
    const conversation = "codex:b-uninformed";
    const { service, stub } = await buildDisagreement((payload) => reply([
      decisionDraft(payload, SINGLE_DB, { resolve: { pick: "conflict:1" } })
    ]));
    await showConflicts(service, conversation);
    await add(service, { user: "user_b", name: "用户B", conversation, time: "2026-10-31 10:00:00", content: "以用户C 的为准。" });
    expect(stub.judge.at(-1)!.conflicts_shown).toHaveLength(1);
    expect(await onlyDecision(service)).toEqual({
      content: BASE,
      time: T.base,
      user_ids: [],
      conflicts: [{ content: SINGLE_DB, time: T.c, user_ids: ["user_c", "user_b"] }]
    });
  });

  it("does not resolve when search happened before the conflicts existed", async () => {
    const conversation = "codex:b-early";
    let decisionId = "";
    const { service, stub } = await seedBase([
      baseRound,
      (payload) => reply([decisionDraft(payload, SINGLE_DB)]),
      (payload) => {
        decisionId = payload.candidate_topics[0]?.decisions?.[0]?.id ?? "";
        return reply([decisionDraft(payload, SINGLE_DB, { resolve: { pick: "conflict:1" } })], {
          informed_decision_ids: decisionId ? [decisionId] : []
        });
      }
    ]);
    const searched = await showConflicts(service, conversation);
    expect(searched.data.topic_detail_list[0].decisions[0].content).toBe(BASE);
    expect(searched.data.topic_detail_list[0].decisions[0].conflicts).toBeUndefined();
    await add(service, { user: "user_c", name: "用户C", conversation: "codex:c", time: "2026-10-30 14:05:00", content: SINGLE_DB });
    await add(service, { user: "user_b", name: "用户B", conversation, time: "2026-10-31 10:00:00", content: "以用户C 的为准。" });
    expect(stub.judge.at(-1)!.conflicts_shown).toEqual([]);
    expect(decisionId).not.toBe("");
    expect(await onlyDecision(service)).toEqual({
      content: BASE,
      time: T.base,
      user_ids: [],
      conflicts: [{ content: SINGLE_DB, time: T.c, user_ids: ["user_c", "user_b"] }]
    });
  });

  it("resolves rather than joins when an informed draft repeats a conflict", async () => {
    const conversation = "codex:b-same";
    let decisionId = "";
    const { service, stub } = await buildDisagreement((payload) => {
      decisionId = payload.candidate_topics[0]?.decisions?.[0]?.id ?? "";
      return reply([decisionDraft(payload, SINGLE_DB, { resolve: { pick: "conflict:1" } })], {
        informed_decision_ids: decisionId ? [decisionId] : []
      });
    });
    await showConflicts(service, conversation);
    await add(service, { user: "user_b", name: "用户B", conversation, time: "2026-10-31 10:00:00", content: SINGLE_DB });
    expect(stub.judge.at(-1)!.conflicts_shown).toEqual([decisionId]);
    expect(await onlyDecision(service)).toEqual({
      content: SINGLE_DB,
      time: T.c,
      user_ids: ["user_c"],
      history: [{ content: BASE, time: T.base, user_ids: ["user_b"], reason: "用户B 确定以用户C 的结论为准" }]
    });
  });

  // G-06 / Q-23. Join still moves every content member onto the matching conflict.
  // Proposed, not implemented: when that draft is not late, emit rewrite and let
  // identical conclusions merge, with user_ids the union. Do not change join to make this pass.
  it.todo("rewrites when a non-late join would empty content, then merges that conclusion (Q-23, G-06)");
});

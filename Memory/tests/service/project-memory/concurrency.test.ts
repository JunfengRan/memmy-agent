import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb, type MemoryService } from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { ASSIGN_PROMPT_VERSION } from "../../../src/service/project-memory/prompts/assign.js";
import type { ChangeSet, TopicChange } from "../../../src/service/project-memory/contract/types.js";
import { SqliteProjectMemoryStore } from "../../../src/service/project-memory/store/sqlite/sqlite-store.js";
import { call, createProjectMemoryHarness, drain, setupSpace, stubStages } from "./helpers.js";

const roots: string[] = [];
const databases: MemoryDb[] = [];
const harness = createProjectMemoryHarness();

afterEach(async () => {
  await harness.cleanup();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function createStore(domains: string[] = ["代码开发"]) {
  const root = mkdtempSync(join(tmpdir(), "pm-concurrency-"));
  roots.push(root);
  const database = new MemoryDb({ path: join(root, "memory.sqlite") });
  databases.push(database);
  let tick = Date.parse("2026-11-01T00:00:00.000Z");
  const store = new SqliteProjectMemoryStore({ db: database.db, now: () => new Date(tick++) });
  await store.createSpace({
    spaceId: "space_a",
    spaceName: "推送",
    domains: domains.map((domain) => ({ domain, description: "" }))
  });
  return { store, database };
}

function createTopic(topicId: string, overrides: Partial<TopicChange> = {}): TopicChange {
  return {
    op: "create",
    topicId,
    domain: "代码开发",
    expectedTopicSeq: 0,
    topicName: "推送方案",
    topicSummary: "推送失败后的重试策略",
    topicDescription: "",
    decisions: [{
      op: "add",
      decisionId: `${topicId}_d1`,
      content: "推送失败后指数退避重试三次。",
      time: "2026-10-29T10:00:00+08:00",
      userIds: ["user_a"]
    }],
    experiences: [],
    timelineAppend: [],
    sourcesAppend: [{ userIds: ["user_a"], agentId: "codex", conversationId: "conv_1" }],
    ...overrides
  };
}

function changeSet(key: string, topics: TopicChange[]): ChangeSet {
  return { spaceId: "space_a", taskId: `task_${key}`, sourceBatchId: key, idempotencyKey: key, topics };
}

const accepted = { acceptedAt: "2026-11-01T00:00:10.000Z" };

describe("project worker retry order", () => {
  it("requeues a failed head before its successor instead of permanently blocking the Space", async () => {
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    for (const [index, content] of ["推送重试三次", "推送重试五次"].entries()) {
      await add(service, { conversation_id: "retry_order", space_ids: ["space_a"],
        messages: [message(content, `2026-11-12T10:0${index}:00+08:00`, "a", "成员A")] });
    }
    const runtime = new Repositories(db.db).runtime;
    const lease = () => runtime.leaseQueuedJobs(10, 60, undefined, false, ["project_memory_organize"]);
    const [head] = lease();
    expect(head?.scopeSeq).toBe(1);
    expect(runtime.failJob(head!.id, "transient runtime failure")?.status).toBe("failed");
    expect(lease()).toHaveLength(0); // Pending retry must not be overtaken.
    expect(runtime.requeueFailedJobs().map((item) => item.after.id)).toContain(head!.id);
    const [retried] = lease();
    expect(retried?.id).toBe(head!.id);
    runtime.completeJob(retried!.id);
    expect(lease().map((job) => job.scopeSeq)).toEqual([2]);
  });
});

function fingerprint(database: MemoryDb) {
  return {
    topics: database.db.prepare(`SELECT id, revision, domain, domain_seq FROM pm_topics ORDER BY id`).all(),
    decisions: database.db.prepare(`SELECT id, topic_id, content FROM pm_decisions ORDER BY id`).all(),
    seq: database.db.prepare(`SELECT space_id, domain, topic_seq FROM pm_domain_topic_seq ORDER BY space_id, domain`).all(),
    changesets: database.db.prepare(`SELECT idempotency_key FROM pm_changesets ORDER BY idempotency_key`).all()
  };
}

function message(content: string, time: string, roleId: string, roleName: string) {
  return { role: "user", role_id: roleId, role_name: roleName, chat_time: time, content };
}

async function add(service: MemoryService, body: Record<string, unknown>): Promise<string> {
  const acceptedEnvelope = await call(service, "add/message", {
    agent_id: "codex",
    allow_memory_view: ["project"],
    user_id: "user_a",
    ...body
  });
  expect(acceptedEnvelope.code, JSON.stringify(acceptedEnvelope)).toBe(0);
  return acceptedEnvelope.data.task_id as string;
}

function writeSideTopic(store: SqliteProjectMemoryStore, database: MemoryDb, id: string, seqSpace = "space_a"): void {
  const seq = Number(database.db.prepare(
    `SELECT topic_seq FROM pm_domain_topic_seq WHERE space_id = ? AND domain = ?`
  ).pluck().get(seqSpace, "代码开发") ?? 0);
  const before = Number(database.db.prepare(`SELECT COUNT(*) FROM pm_topics`).pluck().get() ?? 0);
  const pending = store.commitChangeSet({
    spaceId: seqSpace,
    taskId: `side_${id}`,
    sourceBatchId: `side_${id}`,
    idempotencyKey: `side_${id}`,
    topics: [{
      op: "create",
      topicId: id,
      domain: "代码开发",
      expectedTopicSeq: seq,
      topicName: "旁路推送",
      topicSummary: "另一位成员写下的推送结论",
      topicDescription: "",
      decisions: [{
        op: "add",
        decisionId: `dec_${id}`,
        content: "旁路成员先写下了推送结论。",
        time: "2026-10-29T10:30:00+08:00",
        userIds: ["user_x"]
      }],
      experiences: [],
      timelineAppend: [],
      sourcesAppend: []
    }]
  }, { acceptedAt: new Date().toISOString() });
  void pending.catch(() => undefined);
  const after = Number(database.db.prepare(`SELECT COUNT(*) FROM pm_topics`).pluck().get() ?? 0);
  if (after !== before + 1) throw new Error(`side topic ${id} was not written`);
}

function bumpTopic(store: SqliteProjectMemoryStore, database: MemoryDb, topicId: string): void {
  const revision = Number(database.db.prepare(`SELECT revision FROM pm_topics WHERE id = ?`).pluck().get(topicId));
  const decisionId = String(database.db.prepare(`SELECT id FROM pm_decisions WHERE topic_id = ?`).pluck().get(topicId));
  const pending = store.commitChangeSet({
    spaceId: "space_a",
    taskId: `bump_${topicId}_${revision}`,
    sourceBatchId: `bump_${topicId}_${revision}`,
    idempotencyKey: `bump_${topicId}_${revision}`,
    topics: [{
      op: "update",
      topicId,
      domain: "代码开发",
      expectedRevision: revision,
      decisions: [{
        op: "conflict_append",
        decisionId,
        content: "推送失败后先别重试。",
        time: "2026-10-29T10:40:00+08:00",
        userIds: ["user_x"]
      }],
      experiences: [],
      timelineAppend: [],
      sourcesAppend: []
    }]
  }, { acceptedAt: new Date().toISOString() });
  void pending.catch(() => undefined);
  const after = Number(database.db.prepare(`SELECT revision FROM pm_topics WHERE id = ?`).pluck().get(topicId));
  if (after !== revision + 1) throw new Error(`revision of ${topicId} was not bumped`);
}

describe("project memory concurrency", () => {
  it("does not treat a topic created in another domain as TOPIC_SET_CHANGED", async () => {
    const { store } = await createStore(["代码开发", "发布"]);
    const published = await store.commitChangeSet(changeSet("pub", [createTopic("t_pub", {
      domain: "发布",
      expectedTopicSeq: 0,
      topicName: "发布推送",
      topicSummary: "发布侧的推送安排"
    })]), accepted);
    expect(published).toMatchObject({ ok: true, replayed: false });

    const dev = await store.commitChangeSet(changeSet("dev", [createTopic("t_dev", { expectedTopicSeq: 0 })]), accepted);
    expect(dev).toMatchObject({ ok: true, replayed: false });
  });

  it("leaves topic, decision, seq, and changeset rows unchanged after a rejected commit", async () => {
    const { store, database } = await createStore();
    expect(await store.commitChangeSet(changeSet("k1", [createTopic("t1")]), accepted)).toMatchObject({ ok: true });
    const before = fingerprint(database);

    const stale = await store.commitChangeSet(changeSet("stale", [{
      op: "update",
      topicId: "t1",
      domain: "代码开发",
      expectedRevision: 0,
      decisions: [{
        op: "conflict_append",
        decisionId: "t1_d1",
        content: "推送失败后直接放弃。",
        time: "2026-10-30T10:00:00+08:00",
        userIds: ["user_b"]
      }],
      experiences: [],
      timelineAppend: [],
      sourcesAppend: []
    }]), accepted);
    expect(stale).toMatchObject({ ok: false, error: "VERSION_CONFLICT" });
    expect(fingerprint(database)).toEqual(before);

    const raced = await store.commitChangeSet(changeSet("raced", [createTopic("t2", { expectedTopicSeq: 0 })]), accepted);
    expect(raced).toMatchObject({ ok: false, error: "TOPIC_SET_CHANGED" });
    expect(fingerprint(database)).toEqual(before);
  });

  it("rolls back every earlier topic when one op names a decision from another topic", async () => {
    const topicCount = 4;
    const { store, database } = await createStore();
    expect(await store.commitChangeSet(changeSet("seed-foreign", [createTopic("t0", {
      expectedTopicSeq: 0,
      topicName: "旁路推送",
      topicSummary: "另一主题",
      decisions: [{
        op: "add",
        decisionId: "dec_foreign",
        content: "另一主题的结论。",
        time: "2026-10-29T09:00:00+08:00",
        userIds: ["user_a"]
      }]
    })]), accepted)).toMatchObject({ ok: true });
    for (let index = 1; index <= topicCount; index += 1) {
      expect(await store.commitChangeSet(changeSet(`seed-${index}`, [createTopic(`t${index}`, {
        expectedTopicSeq: index,
        topicSummary: `推送主题 ${index}`,
        decisions: [{
          op: "add",
          decisionId: `d${index}`,
          content: `推送主题 ${index} 的当前结论。`,
          time: "2026-10-29T10:00:00+08:00",
          userIds: ["user_a"]
        }]
      })]), accepted)).toMatchObject({ ok: true });
    }
    const before = fingerprint(database);

    for (let iteration = 0; iteration < 100; iteration += 1) {
      for (let k = 1; k <= topicCount; k += 1) {
        const topics: TopicChange[] = [];
        for (let index = 1; index <= topicCount; index += 1) {
          topics.push({
            op: "update",
            topicId: `t${index}`,
            domain: "代码开发",
            expectedRevision: 1,
            decisions: index === k
              ? [{
                op: "rewrite",
                decisionId: "dec_foreign",
                content: "不应写入。",
                time: "2026-10-30T10:00:00+08:00",
                userIds: ["user_a"],
                reason: "非法"
              }]
              : [{
                op: "rewrite",
                decisionId: `d${index}`,
                content: `推送主题 ${index} 被改写。`,
                time: "2026-10-30T10:00:00+08:00",
                userIds: ["user_a"],
                reason: "合法"
              }],
            experiences: [],
            timelineAppend: [],
            sourcesAppend: []
          });
        }
        await expect(store.commitChangeSet(
          changeSet(`fault-${iteration}-${k}`, topics),
          accepted
        )).rejects.toMatchObject({ errorName: "STRUCTURE_VIOLATION" });
        expect(fingerprint(database)).toEqual(before);
        for (let index = 1; index < k; index += 1) {
          expect(database.db.prepare(`SELECT content FROM pm_decisions WHERE id = ?`).pluck().get(`d${index}`))
            .toBe(`推送主题 ${index} 的当前结论。`);
        }
      }
    }
  }, 30_000);

  it("keeps the other writer's conflicts and history when this batch is re-merged", async () => {
    let injected = false;
    const { service, db } = harness.createService();
    const side = new SqliteProjectMemoryStore({ db: db.db });
    stubStages({
      extract(payload) {
        const messages = Array.isArray(payload.messages) ? payload.messages as Array<{ content: string }> : [];
        return {
          drafts: [{
            draft_id: "d0",
            kind: "decision",
            content: messages[0]?.content ?? "",
            message_idx: 0,
            user_ids: ["user_a"],
            reason: null,
            signals: []
          }],
          state_hints: [],
          dropped: [],
          deferred: []
        };
      },
      assign(payload) {
        const candidates = Array.isArray(payload.candidates) ? payload.candidates as Array<{ topic_id: string }> : [];
        if (candidates.length === 0) {
          return {
            assignments: [{
              draft_id: "d0",
              target: { new_topic: "n1" },
              basis: { independent_delivery: true, affects_existing_decisions: false }
            }],
            new_topics: [{ ref: "n1", topic_name: "推送方案", topic_summary: "推送失败后的重试策略", topic_description: "" }],
            deferred: []
          };
        }
        return {
          assignments: [{
            draft_id: "d0",
            target: { topic_id: candidates[0]!.topic_id },
            basis: { independent_delivery: false, affects_existing_decisions: true }
          }],
          new_topics: [],
          deferred: []
        };
      },
      judge(payload) {
        const topics = Array.isArray(payload.topics) ? payload.topics as Array<{ topic_id: string; decisions: Array<{ id: string }> }> : [];
        const topic = topics[0];
        const decisionId = topic?.decisions[0]?.id ?? null;
        if (topic && decisionId && !injected) {
          injected = true;
          const row = db.db.prepare(`SELECT revision, domain FROM pm_topics WHERE id = ?`).get(topic.topic_id) as { revision: number; domain: string };
          const pending = side.commitChangeSet({
            spaceId: "space_a",
            taskId: "other_writer",
            sourceBatchId: "other_writer",
            idempotencyKey: "other_writer",
            topics: [{
              op: "update",
              topicId: topic.topic_id,
              domain: row.domain,
              expectedRevision: row.revision,
              decisions: [
                {
                  op: "rewrite",
                  decisionId,
                  content: "推送失败后按通道分别重试。",
                  time: "2026-10-29T12:00:00+08:00",
                  userIds: ["user_a"],
                  reason: "用户A 按通道重试"
                },
                {
                  op: "conflict_append",
                  decisionId,
                  content: "推送失败后直接丢弃。",
                  time: "2026-10-29T12:10:00+08:00",
                  userIds: ["user_x"]
                }
              ],
              experiences: [],
              timelineAppend: [],
              sourcesAppend: []
            }]
          }, { acceptedAt: new Date().toISOString() });
          void pending.catch(() => undefined);
        }
        return {
          drafts: [{
            draft_id: "d0",
            same_question_as: decisionId,
            same_as: null,
            approved_by: [],
            resolve: null,
            split: null,
            same_experience_as: null,
            experience_change: null
          }],
          informed_decision_ids: [],
          topic_updates: []
        };
      }
    });
    await setupSpace(service, "space_a");
    await add(service, {
      user_id: "user_a",
      conversation_id: "c1",
      space_ids: ["space_a"],
      messages: [message("推送失败后指数退避重试三次。", "2026-10-29 10:00:00", "user_a", "用户A")]
    });
    await drain(service);
    const taskId = await add(service, {
      user_id: "user_b",
      conversation_id: "c2",
      space_ids: ["space_a"],
      messages: [message("推送失败后改为重试五次。", "2026-10-29 13:00:00", "user_b", "用户B")]
    });
    await drain(service);

    expect((await call(service, "get/status", { task_id: taskId })).data.status).toBe("completed");
    const listed = await call(service, "get/memory", { space_id: "space_a" });
    const decision = listed.data.topic_detail_list[0].decisions[0];
    expect(decision.content).toBe("推送失败后按通道分别重试。");
    expect(decision.history.map((item: { content: string }) => item.content)).toEqual(["推送失败后指数退避重试三次。"]);
    expect(decision.conflicts.map((item: { content: string; user_ids: string[] }) => ({
      content: item.content,
      user_ids: item.user_ids
    }))).toEqual([
      { content: "推送失败后直接丢弃。", user_ids: ["user_x"] },
      { content: "推送失败后改为重试五次。", user_ids: ["user_b"] }
    ]);
  });

  it("collapses three concurrent new topics into one and keeps every member", async () => {
    const people = [
      { id: "user_a", name: "用户A", conversation: "c_a", content: "推送失败后按方案甲继续。", time: "2026-10-29 10:00:00" },
      { id: "user_b", name: "用户B", conversation: "c_b", content: "推送失败后按方案乙继续。", time: "2026-10-29 10:01:00" },
      { id: "user_c", name: "用户C", conversation: "c_c", content: "推送失败后按方案丙继续。", time: "2026-10-29 10:02:00" }
    ];
    const stub = stubStages({
      extract(payload) {
        const messages = Array.isArray(payload.messages) ? payload.messages as Array<{ content: string }> : [];
        return {
          drafts: [{
            draft_id: "d0",
            kind: "decision",
            content: messages[0]?.content ?? "",
            message_idx: 0,
            user_ids: [],
            reason: null,
            signals: []
          }],
          state_hints: [],
          dropped: [],
          deferred: []
        };
      },
      assign(payload) {
        const candidates = Array.isArray(payload.candidates) ? payload.candidates as Array<{ topic_id: string }> : [];
        if (candidates.length > 0) {
          return {
            assignments: [{
              draft_id: "d0",
              target: { topic_id: candidates[0]!.topic_id },
              basis: { independent_delivery: false, affects_existing_decisions: true }
            }],
            new_topics: [],
            deferred: []
          };
        }
        return {
          assignments: [{
            draft_id: "d0",
            target: { new_topic: "n1" },
            basis: { independent_delivery: true, affects_existing_decisions: false }
          }],
          new_topics: [{ ref: "n1", topic_name: "推送方案", topic_summary: "推送失败后的重试策略", topic_description: "" }],
          deferred: []
        };
      },
      judge(payload) {
        const topics = Array.isArray(payload.topics) ? payload.topics as Array<{ decisions: Array<{ id: string }> }> : [];
        const drafts = Array.isArray(payload.drafts) ? payload.drafts as Array<{ draft_id: string }> : [];
        const decisionId = topics[0]?.decisions[0]?.id ?? null;
        return {
          drafts: drafts.map((draft) => ({
            draft_id: draft.draft_id,
            same_question_as: decisionId,
            same_as: null,
            approved_by: [],
            resolve: null,
            split: null,
            same_experience_as: null,
            experience_change: null
          })),
          informed_decision_ids: [],
          topic_updates: []
        };
      }
    });
    holdFirstAssigns(3);
    const { service, db } = harness.createService();
    await setupSpace(service, "space_a");
    const taskIds: string[] = [];
    for (const person of people) {
      taskIds.push(await add(service, {
        user_id: person.id,
        conversation_id: person.conversation,
        space_ids: ["space_a"],
        messages: [message(person.content, person.time, person.id, person.name)]
      }));
    }
    const rows = db.db.prepare(
      `SELECT payload_json FROM evolution_jobs WHERE job_type = 'project_memory_organize' ORDER BY created_at, id`
    ).all() as Array<{ payload_json: string }>;
    expect(rows).toHaveLength(3);
    const projectMemory = (service as unknown as {
      projectMemory: { processOrganizeJob(job: { payload: Record<string, unknown> }): Promise<void> };
    }).projectMemory;
    await Promise.all(rows.map((row) => projectMemory.processOrganizeJob({
      payload: JSON.parse(row.payload_json) as Record<string, unknown>
    })));

    for (const taskId of taskIds) {
      expect((await call(service, "get/status", { task_id: taskId })).data.status).toBe("completed");
    }
    const listed = await call(service, "get/memory", { space_id: "space_a" });
    expect(listed.data.total).toBe(1);
    const members = new Set<string>();
    for (const decision of listed.data.topic_detail_list[0].decisions as Array<{
      user_ids: string[];
      conflicts?: Array<{ user_ids: string[] }>;
    }>) {
      for (const id of decision.user_ids ?? []) members.add(id);
      for (const conflict of decision.conflicts ?? []) for (const id of conflict.user_ids ?? []) members.add(id);
    }
    expect(members).toEqual(new Set(["user_a", "user_b", "user_c"]));
    expect(stub.assign.length).toBeGreaterThan(3);
  });

  it("exhausts one budget of three across TOPIC_SET_CHANGED and VERSION_CONFLICT", async () => {
    const { service, db } = harness.createService();
    const side = new SqliteProjectMemoryStore({ db: db.db });
    const stub = stubStages({
      extract() {
        return {
          drafts: [
            {
              draft_id: "d0",
              kind: "decision",
              content: "推送失败后改为重试五次。",
              message_idx: 0,
              user_ids: ["user_b"],
              reason: null,
              signals: []
            },
            {
              draft_id: "d1",
              kind: "decision",
              content: "推送通道单独约定超时。",
              message_idx: 0,
              user_ids: ["user_b"],
              reason: null,
              signals: []
            }
          ],
          state_hints: [],
          dropped: [],
          deferred: []
        };
      },
      assign(payload, call) {
        const candidates = Array.isArray(payload.candidates) ? payload.candidates as Array<{ topic_id: string }> : [];
        if (call === 1) {
          writeSideTopic(side, db, "topic_mix_1");
          return {
            assignments: [
              { draft_id: "d0", target: { new_topic: "n0" }, basis: { independent_delivery: true, affects_existing_decisions: false } },
              { draft_id: "d1", target: { new_topic: "n1" }, basis: { independent_delivery: true, affects_existing_decisions: false } }
            ],
            new_topics: [
              { ref: "n0", topic_name: "推送重试", topic_summary: "推送失败后的重试", topic_description: "" },
              { ref: "n1", topic_name: "推送超时", topic_summary: "推送通道的超时", topic_description: "" }
            ],
            deferred: []
          };
        }
        const topicId = candidates.find((topic) => topic.topic_id === "topic_mix_1")?.topic_id;
        if (!topicId) throw new Error(`missing side topic in ${candidates.map((topic) => topic.topic_id).join(",")}`);
        return {
          assignments: [
            { draft_id: "d0", target: { topic_id: topicId }, basis: { independent_delivery: false, affects_existing_decisions: true } },
            { draft_id: "d1", target: { new_topic: "n1" }, basis: { independent_delivery: true, affects_existing_decisions: false } }
          ],
          new_topics: [{ ref: "n1", topic_name: "推送超时", topic_summary: "推送通道的超时", topic_description: "" }],
          deferred: []
        };
      },
      judge(payload, call) {
        const topics = Array.isArray(payload.topics) ? payload.topics as Array<{ topic_id: string; decisions: Array<{ id: string }> }> : [];
        const topic = topics[0];
        if (call === 1 && topic) bumpTopic(side, db, topic.topic_id);
        if (call === 2) writeSideTopic(side, db, "topic_mix_2");
        return {
          drafts: [{
            draft_id: "d0",
            same_question_as: topic?.decisions[0]?.id ?? null,
            same_as: null,
            approved_by: [],
            resolve: null,
            split: null,
            same_experience_as: null,
            experience_change: null
          }],
          informed_decision_ids: [],
          topic_updates: []
        };
      }
    });
    await setupSpace(service, "space_a");
    const taskId = await add(service, {
      user_id: "user_b",
      conversation_id: "c2",
      space_ids: ["space_a"],
      messages: [message("推送失败后改为重试五次。", "2026-10-29 11:00:00", "user_b", "用户B")]
    });
    await drain(service);

    const status = await call(service, "get/status", { task_id: taskId });
    expect(status.data.status).toBe("failed");
    expect(status.data.error.reason).toBe("VERSION_CONFLICT_RETRY_EXHAUSTED");
    expect(String(status.data.error.detail).startsWith("TOPIC_SET_CHANGED,VERSION_CONFLICT,TOPIC_SET_CHANGED")).toBe(true);
    expect(stub.assign).toHaveLength(2);
    expect(stub.judge).toHaveLength(2);
  });
});

/** The first assign round waits until `size` requests have arrived, then lets them all continue. */
function holdFirstAssigns(size: number): void {
  const inner = globalThis.fetch;
  let arrived = 0;
  let open = true;
  const waiters: Array<() => void> = [];
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string }> };
    const system = body.messages?.find((item) => item.role === "system")?.content ?? "";
    if (open && system.includes(ASSIGN_PROMPT_VERSION)) {
      arrived += 1;
      if (arrived >= size) {
        open = false;
        for (const wake of waiters.splice(0)) wake();
      } else {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("assign barrier timed out")), 2000);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
    return inner(input, init);
  });
}

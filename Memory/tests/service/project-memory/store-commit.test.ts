import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../../src/index.js";
import type { ChangeSet, TopicChange } from "../../../src/service/project-memory/contract/types.js";
import { SqliteProjectMemoryStore } from "../../../src/service/project-memory/store/sqlite/sqlite-store.js";

const roots: string[] = [];
const databases: MemoryDb[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PM_TABLES = [
  "pm_spaces",
  "pm_domains",
  "pm_domain_topic_seq",
  "pm_topics",
  "pm_decisions",
  "pm_decision_conflicts",
  "pm_decision_history",
  "pm_experiences",
  "pm_experience_history",
  "pm_timeline",
  "pm_sources",
  "pm_source_members",
  "pm_changesets",
  "pm_topics_fts"
];

async function createStore() {
  const root = mkdtempSync(join(tmpdir(), "pm-store-"));
  roots.push(root);
  const database = new MemoryDb({ path: join(root, "memory.sqlite") });
  databases.push(database);
  let tick = Date.parse("2026-11-01T00:00:00.000Z");
  const store = new SqliteProjectMemoryStore({ db: database.db, now: () => new Date(tick++) });
  await store.createSpace({ spaceId: "space_a", spaceName: "A", domains: [{ domain: "代码开发", description: "" }] });
  const snapshot = () => Object.fromEntries(PM_TABLES.map((table) => [table, database.db.prepare(`SELECT * FROM ${table}`).all()]));
  return { store, database, snapshot };
}

function createTopic(topicId: string, overrides: Partial<TopicChange> = {}): TopicChange {
  return {
    op: "create",
    topicId,
    domain: "代码开发",
    expectedTopicSeq: 0,
    topicName: "推送服务重试",
    topicSummary: "推送失败后的重试策略",
    topicDescription: "",
    decisions: [{ op: "add", decisionId: `${topicId}_d1`, content: "失败后指数退避重试三次。", time: "2026-10-29T10:00:00+08:00", userIds: ["user_a"] }],
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

describe("SqliteProjectMemoryStore conditional write", () => {
  it("leaves the database untouched when the expected revision is stale", async () => {
    const { store, snapshot } = await createStore();
    const created = await store.commitChangeSet(changeSet("k1", [createTopic("t1")]), accepted);
    expect(created).toMatchObject({ ok: true, replayed: false, topics: [{ topicId: "t1", revision: 1 }] });

    const before = snapshot();
    const stale = await store.commitChangeSet(changeSet("k2", [{
      op: "update",
      topicId: "t1",
      domain: "代码开发",
      expectedRevision: 0,
      topicSummary: "should not land",
      decisions: [{ op: "conflict_append", decisionId: "t1_d1", content: "失败后立即放弃。", time: "2026-10-30T10:00:00+08:00", userIds: ["user_b"] }],
      experiences: [],
      timelineAppend: [],
      sourcesAppend: [{ userIds: ["user_b"], agentId: "codex", conversationId: "conv_2" }]
    }]), accepted);

    expect(stale).toEqual({ ok: false, error: "VERSION_CONFLICT", topics: [{ topicId: "t1", expectedRevision: 0, currentRevision: 1 }] });
    expect(snapshot()).toEqual(before);
  });

  it("reports topics created since the caller's recall and writes nothing", async () => {
    const { store, snapshot } = await createStore();
    await store.commitChangeSet(changeSet("k1", [createTopic("t1")]), accepted);
    const before = snapshot();
    const result = await store.commitChangeSet(changeSet("k2", [createTopic("t2", { expectedTopicSeq: 0 })]), accepted);
    expect(result).toEqual({ ok: false, error: "TOPIC_SET_CHANGED", domain: "代码开发", expectedTopicSeq: 0, currentTopicSeq: 1, newTopicIds: ["t1"] });
    expect(snapshot()).toEqual(before);
  });

  it("replays an idempotency key without writing a duplicate", async () => {
    const { store, snapshot } = await createStore();
    const first = await store.commitChangeSet(changeSet("same-key", [createTopic("t1")]), accepted);
    const after = snapshot();
    const replay = await store.commitChangeSet(changeSet("same-key", [createTopic("t1")]), accepted);
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(replay.ok && replay.topics).toEqual(first.ok && first.topics);
    expect(snapshot()).toEqual(after);
  });

  it("rejects writes into a cleared space and unknown domains", async () => {
    const { store, snapshot } = await createStore();
    expect(await store.commitChangeSet(changeSet("k1", [createTopic("t1", { domain: "运维" })]), accepted))
      .toEqual({ ok: false, error: "DOMAIN_INVALID", domains: ["运维"] });
    await store.clearSpace("space_a");
    const before = snapshot();
    const result = await store.commitChangeSet(changeSet("k2", [createTopic("t2")]), { acceptedAt: "2026-11-01T00:00:00.000Z" });
    expect(result).toMatchObject({ ok: false, error: "SPACE_CLEARED" });
    expect(snapshot()).toEqual(before);
  });

  it("keeps decision history insert-only", async () => {
    const { store, database } = await createStore();
    await store.commitChangeSet(changeSet("k1", [createTopic("t1")]), accepted);
    await store.commitChangeSet(changeSet("k2", [{
      op: "update",
      topicId: "t1",
      domain: "代码开发",
      expectedRevision: 1,
      decisions: [{ op: "rewrite", decisionId: "t1_d1", content: "失败后指数退避重试五次。", time: "2026-10-30T10:00:00+08:00", userIds: ["user_a"], reason: "压测后调整" }],
      experiences: [],
      timelineAppend: [],
      sourcesAppend: []
    }]), accepted);

    const [topic] = await store.getTopicsFull("space_a", ["t1"]);
    expect(topic!.revision).toBe(2);
    expect(topic!.decisions[0]).toMatchObject({
      content: "失败后指数退避重试五次。",
      history: [{ content: "失败后指数退避重试三次。", userIds: ["user_a"], reason: "压测后调整" }]
    });
    expect(() => database.db.prepare("UPDATE pm_decision_history SET content = 'tampered'").run()).toThrow();
    expect(() => database.db.prepare("DELETE FROM pm_decision_history").run()).toThrow();
  });
});

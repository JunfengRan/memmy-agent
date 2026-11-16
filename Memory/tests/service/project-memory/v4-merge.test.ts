import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import type { ChangeSet, DecisionOp, TopicSnapshot } from "../../../src/service/project-memory/contract/types.js";
import { applyDecisionEntries, type MutableDecision } from "../../../src/service/project-memory/merge/apply.js";
import { mergeDrafts, type MergeContext } from "../../../src/service/project-memory/merge/merge.js";
import type { DecisionDraft, InformedTarget, OrganizeResult } from "../../../src/service/project-memory/organize/organizer.js";
import { SqliteProjectMemoryStore } from "../../../src/service/project-memory/store/sqlite/sqlite-store.js";

const CURRENT = "推送失败后重试三次。";
const FIRST = "推送失败后立即放弃。";
const SECOND = "推送失败后交给人工。";
const OLD = "推送失败后重试一次。";
const TIME = "2026-11-01T10:00:00Z";
const roots: string[] = [];
const databases: MemoryDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function topic(): TopicSnapshot {
  return {
    topicId: "topic_a", spaceId: "space_a", domain: "工程", topicName: "推送策略", topicSummary: "失败处理", topicDescription: "",
    revision: 1, createTime: TIME, updateTime: TIME, sources: [], experiences: [], timeline: [],
    decisions: [{ id: "dec_a", content: CURRENT, time: TIME, userIds: ["u1"],
      conflicts: [{ seq: 1, content: FIRST, time: TIME, userIds: ["u2"] }, { seq: 2, content: SECOND, time: TIME, userIds: ["u3"] }],
      history: [{ seq: 1, content: OLD, time: "2026-10-30T10:00:00Z", userIds: ["u1"], reason: "压测后调整" }] }]
  };
}
function disclosure(): InformedTarget[] {
  return [{ target: "content", content: CURRENT }, { target: "conflict:1", content: FIRST }];
}
function draft(overrides: Partial<DecisionDraft> = {}): DecisionDraft {
  return { kind: "decision", draftId: "d1", target: { topicId: "topic_a" }, content: FIRST,
    time: "2026-11-02T10:00:00Z", userIds: ["u4"], messageIdx: 0, origin: "member", reason: null,
    sameQuestionAs: "dec_a", sameAs: null, approvedBy: [], signaledResolve: true,
    resolve: { pick: "conflict:1" }, informedTargets: disclosure(), split: null, ...overrides };
}
function organized(drafts: DecisionDraft[]): OrganizeResult {
  return { promptVersion: "test-v4", drafts, newTopics: new Map(), topicUpdates: new Map(), deferred: [] };
}
function context(key = "merge"): MergeContext {
  let seq = 0;
  return { spaceId: "space_a", taskId: `task_${key}`, sourceBatchId: key, idempotencyKey: key,
    conversationId: "conversation_a", agentId: "memmy", newTopicDomain: "工程", topicSeq: { 工程: 1 },
    displayName: (id) => id, newId: (prefix) => `${prefix}_generated_${++seq}` };
}
function merge(input = draft(), snapshot = topic(), key = "merge") {
  return mergeDrafts(organized([input]), new Map([[snapshot.topicId, snapshot]]), context(key));
}
function mutable(snapshot = topic()): MutableDecision {
  const entry = snapshot.decisions[0]!;
  return { id: entry.id, content: entry.content, time: entry.time, userIds: [...entry.userIds],
    conflicts: structuredClone(entry.conflicts), newHistory: [], isNew: false };
}
function apply(op: DecisionOp, snapshot = topic()) { return applyDecisionEntries(mutable(snapshot), op); }
function operation(input = draft(), snapshot = topic()): DecisionOp {
  const op = merge(input, snapshot).changeSet?.topics[0]?.decisions[0];
  expect(op).toBeDefined();
  return op!;
}
async function persistentStore() {
  const root = mkdtempSync(join(tmpdir(), "pm-v4-merge-")); roots.push(root);
  const db = new MemoryDb({ path: join(root, "memory.sqlite") }); databases.push(db);
  const store = new SqliteProjectMemoryStore({ db: db.db, now: () => new Date(TIME) });
  await store.createSpace({ spaceId: "space_a", domains: [{ domain: "工程", description: "" }] });
  const initial: ChangeSet = { spaceId: "space_a", taskId: "initial", sourceBatchId: "initial", idempotencyKey: "initial", topics: [{
    op: "create", topicId: "topic_a", domain: "工程", expectedTopicSeq: 0, topicName: "推送策略", topicSummary: "失败处理", topicDescription: "",
    decisions: [
      { op: "add", decisionId: "dec_a", content: CURRENT, time: TIME, userIds: ["u1"] },
      { op: "conflict_append", decisionId: "dec_a", content: FIRST, time: TIME, userIds: ["u2"] },
      { op: "conflict_append", decisionId: "dec_a", content: SECOND, time: TIME, userIds: ["u3"] }
    ], experiences: [], timelineAppend: [], sourcesAppend: []
  }] };
  expect(await store.commitChangeSet(initial, { acceptedAt: TIME })).toMatchObject({ ok: true });
  const read = async () => (await store.getTopicsFull("space_a", ["topic_a"]))[0]!;
  return { store, db, read };
}

describe("V4 scoped decision resolution without recall records", () => {
  it("binds an explicit M02 resolution to M05 sameAs when the redundant resolve label is missing", () => {
    const op = operation(draft({ resolve: null, sameAs: "conflict:1", signaledResolve: true }));
    expect(op).toMatchObject({ op: "resolve", target: "conflict:1", processedTargets: ["content", "conflict:1"] });
    const [result] = apply(op);
    expect(result!.content).toBe(FIRST);
    expect(result!.newHistory.map((row) => row.content)).toContain(CURRENT);
    expect(result!.conflicts.map((row) => row.content)).toEqual([SECOND]);
    expect(operation(draft({ resolve: null, sameAs: "conflict:1", signaledResolve: false }))).toMatchObject({ op: "join" });
  });
  it("resolves only disclosed alternatives and archives the replaced content", () => {
    const op = operation();
    expect(op).toMatchObject({ op: "resolve", target: "conflict:1", processedTargets: ["content", "conflict:1"] });
    const [result] = apply(op);
    expect(result).toMatchObject({ id: "dec_a", content: FIRST, userIds: ["u2"], conflicts: [{ seq: 2, content: SECOND, userIds: ["u3"] }] });
    expect(result!.newHistory.map((entry) => entry.content)).toEqual([CURRENT]);
  });
  it("keeps undisclosed current content as a conflict instead of retiring it", () => {
    const [result] = apply(operation(draft({ informedTargets: [{ target: "conflict:1", content: FIRST }] })));
    expect(result!.content).toBe(FIRST);
    expect(result!.conflicts.map((entry) => entry.content)).toEqual([SECOND, CURRENT]);
    expect(result!.newHistory).toEqual([]);
  });
  it("retains undisclosed conflicts on the original decision during a partial split", () => {
    const input = draft({ resolve: null, content: "普通通道重试，营销通道放弃。", split: { parts: [
      { content: "普通通道失败后重试三次。", from: ["content"] },
      { content: "营销通道失败后立即放弃。", from: ["conflict:1"] }
    ] } });
    const op = operation(input);
    expect(op).toMatchObject({ op: "split", processedTargets: ["content", "conflict:1"] });
    const results = apply(op);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: "dec_a", conflicts: [{ seq: 2, content: SECOND }] });
    expect(results[1]!.conflicts).toEqual([]);
    for (const result of results) expect(result.newHistory.map((entry) => entry.content)).toEqual([CURRENT, FIRST]);
  });
  it("defers a new resolution when its author belongs to an undisclosed conflict", () => {
    const snapshot = topic(); const before = structuredClone(snapshot);
    const input = draft({ userIds: ["u3"], content: "推送失败后进入延迟队列。", resolve: { pick: "new" } });
    const result = merge(input, snapshot);
    expect(result.changeSet).toBeNull();
    expect(result.deferred).toEqual([{ text: input.content, reason: "partial_resolution_membership_conflict" }]);
    expect(result.dropped).toEqual([]);
    expect(snapshot).toEqual(before);
  });
  it("defers a partial split whose new piece would give an undisclosed member two conclusions", () => {
    const snapshot = topic(); const before = structuredClone(snapshot);
    const input = draft({ userIds: ["u3"], resolve: null, content: "普通通道重试，专用通道延迟发送。", split: { parts: [
      { content: "普通通道失败后重试三次。", from: ["content"] },
      { content: "专用通道失败后延迟发送。", from: [] }
    ] } });
    const result = merge(input, snapshot);
    expect(result.changeSet).toBeNull();
    expect(result.deferred).toEqual([{ text: input.content, reason: "partial_resolution_membership_conflict" }]);
    expect(result.dropped).toEqual([]);
    expect(snapshot).toEqual(before);
  });
  it("does not authorize resolution without disclosed targets", () => {
    const op = operation(draft({ informedTargets: [] }));
    expect(op.op).toBe("join");
    const [result] = apply(op);
    expect(result!.content).toBe(CURRENT);
    expect(result!.conflicts.map((entry) => entry.content)).toEqual([FIRST, SECOND]);
    expect(result!.newHistory).toEqual([]);
  });
  it("rechecks disclosed text against latest conflict content", () => {
    const snapshot = topic(); snapshot.decisions[0]!.conflicts[0]!.content = "推送失败后重试五次。";
    const op = operation(draft(), snapshot);
    expect(op.op).toBe("conflict_append");
    const [result] = apply(op, snapshot);
    expect(result!.content).toBe(CURRENT);
    expect(result!.conflicts.map((entry) => entry.content)).toContain("推送失败后重试五次。");
    expect(result!.newHistory).toEqual([]);
  });
  it.each([CURRENT, FIRST, OLD])("drops delegated restatement of %s without changing members", (content) => {
    const result = merge(draft({ content, origin: "delegated", resolve: null, signaledResolve: false }));
    expect(result.changeSet).toBeNull();
    expect(result.dropped).toEqual([{ reason: "restatement", text: content }]);
  });
  it("drops delegated paraphrases only when M05 binds them to a real historical conclusion", () => {
    const content = "推送失败仅追加一次尝试。";
    const valid = merge(draft({ content, origin: "delegated", resolve: null, signaledResolve: false, restatesHistory: OLD }));
    expect(valid.changeSet).toBeNull();
    expect(valid.dropped).toEqual([{ reason: "restatement", text: content }]);
    const forged = merge(draft({ content, origin: "delegated", resolve: null, signaledResolve: false, restatesHistory: "不存在的旧方案" }));
    expect(forged.changeSet?.topics[0]?.decisions[0]?.op).toBe("conflict_append");
    expect(forged.dropped).toEqual([]);
  });
  it.each(["member", "adopted"] as const)("allows a %s endorsement to join an existing conclusion", (origin) => {
    const [result] = apply(operation(draft({ content: CURRENT, origin, resolve: null, signaledResolve: false })));
    expect(result!.userIds).toEqual(["u1", "u4"]);
    expect(result!.newHistory).toEqual([]);
  });
  it("does not let an older offset timestamp authorize rewrite or resolution", () => {
    const result = merge(draft({ userIds: ["u1"], content: "推送失败后交给值班人员。", resolve: { pick: "new" }, time: "2026-11-01T12:00:00+03:00" }));
    expect(result.changeSet).toBeNull();
  });
  it("produces identical changes for repeated input without mutating the snapshot", () => {
    const snapshot = topic(); const before = structuredClone(snapshot);
    expect(merge(draft(), snapshot)).toEqual(merge(draft(), snapshot));
    expect(snapshot).toEqual(before);
  });
  it("rolls back content, conflicts, revision and history if history insertion fails", async () => {
    const { store, db, read } = await persistentStore();
    const before = await read();
    db.db.exec("CREATE TRIGGER fail_v4_history BEFORE INSERT ON pm_decision_history BEGIN SELECT RAISE(ABORT, 'history unavailable'); END;");
    const changes = merge(draft(), before, "rollback").changeSet!;
    await expect(store.commitChangeSet(changes, { acceptedAt: TIME })).rejects.toThrow("history unavailable");
    expect(await read()).toEqual(before);
    expect(db.db.prepare("SELECT COUNT(*) FROM pm_changesets WHERE idempotency_key = 'rollback'").pluck().get()).toBe(0);
  });
  it("replays a committed resolution without duplicating history", async () => {
    const { store, read } = await persistentStore();
    const changes = merge(draft(), await read(), "replay").changeSet!;
    expect(await store.commitChangeSet(changes, { acceptedAt: TIME })).toMatchObject({ ok: true, replayed: false });
    const after = await read();
    expect(await store.commitChangeSet(changes, { acceptedAt: TIME })).toMatchObject({ ok: true, replayed: true });
    expect(await read()).toEqual(after);
    expect(after.decisions[0]!.history.map((entry) => entry.content)).toEqual([CURRENT]);
    expect(after.decisions[0]!.conflicts.map((entry) => entry.content)).toEqual([SECOND]);
  });
  it("rejects stale ChangeSets and re-merges against updated conflict content", async () => {
    const { store, read } = await persistentStore();
    const stale = merge(draft(), await read(), "stale").changeSet!;
    const newer: ChangeSet = { spaceId: "space_a", taskId: "newer", sourceBatchId: "newer", idempotencyKey: "newer", topics: [{
      op: "update", topicId: "topic_a", domain: "工程", expectedRevision: 1,
      decisions: [{ op: "conflict_update", decisionId: "dec_a", target: "conflict:1", content: "推送失败后重试五次。", time: "2026-11-02T09:00:00Z", userIds: ["u2"] }],
      experiences: [], timelineAppend: [], sourcesAppend: []
    }] };
    expect(await store.commitChangeSet(newer, { acceptedAt: TIME })).toMatchObject({ ok: true });
    const latest = await read();
    expect(await store.commitChangeSet(stale, { acceptedAt: TIME })).toMatchObject({ ok: false, error: "VERSION_CONFLICT" });
    expect(await read()).toEqual(latest);
    const retried = merge(draft(), latest, "retry").changeSet!;
    expect(retried.topics[0]!.expectedRevision).toBe(2);
    expect(retried.topics[0]!.decisions[0]!.op).toBe("conflict_append");
    expect(await store.commitChangeSet(retried, { acceptedAt: TIME })).toMatchObject({ ok: true });
    const after = await read();
    expect(after.decisions[0]!.content).toBe(CURRENT);
    expect(after.decisions[0]!.history).toEqual([]);
    expect(after.decisions[0]!.conflicts.map((entry) => entry.content)).toContain("推送失败后重试五次。");
  });
});

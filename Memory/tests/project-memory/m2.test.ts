import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { L3WorldModelProtocolVersionSchema } from "../../src/contracts/memory-workspace-identity.js";
import { deriveWorkspaceHostId } from "../../src/contracts/memory-workspace-identity.js";
import { checkpointsFromHistory } from "../../src/service/project/checkpoint.js";
import { policyMemoryKey, resolvePolicyKey, truncateEvidence } from "../../src/service/project/policy-scope.js";
import { rephrasedDecision } from "../../src/service/project/rephrase.js";
import { assignTopic, buildTopicView, topicRowBytes } from "../../src/service/project/topic.js";
import { filterL1TraceSpanRecallHits } from "../../src/service/retrieval/l1-trace-span-filter.js";
import { migrate } from "../../src/storage/schema.js";
import { MemoryDb } from "../../src/index.js";
import type { MemoryKind, MemoryRow, RecallHit } from "../../src/types.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const cases = JSON.parse(readFileSync(new URL("./cases/m2/cases.json", import.meta.url), "utf8")) as Array<{
  id: string;
  requirement: string;
  kind: string;
}>;
const fixture = createMemoryServiceFixture();
const roots: string[] = [];
afterEach(() => {
  fixture.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project memory M2 cases", () => {
  for (const item of cases) it(`${item.id} ${item.requirement}`, () => run(item.kind));
});

function run(kind: string): void {
  if (kind === "protocol") return protocol();
  if (kind === "checkpoint-span") return checkpointSpan();
  if (kind === "abandoned") return abandoned();
  if (kind === "summary") return summary();
  if (kind === "span-filter") return spanFilter();
  if (kind === "topic") return topic();
  if (kind === "bounded") return bounded();
  if (kind === "policy") return policy();
  if (kind === "evidence") return evidence();
  if (kind === "rephrase") return rephrase();
  throw new Error(kind);
}

function protocol(): void {
  expect(L3WorldModelProtocolVersionSchema.parse(2)).toBe(2);
  expect(L3WorldModelProtocolVersionSchema.parse(3)).toBe(3);
  const { db, service } = fixture.createTestService();
  const opened = service.openSession({
    l3WorldModelProtocolVersion: 3,
    l3WorldModelTransition: "allow_legacy_rollover",
    workspaceUri: "file:///workspace/protocol-v3",
    workspaceHostId: deriveWorkspaceHostId("m2"),
    namespace: { source: "cursor", profileId: "default", sessionKey: "v3", userId: "m2-user" }
  });
  const version = db.db.prepare(`SELECT json_extract(meta_json, '$.l3_world_model_protocol_version') AS version FROM sessions WHERE id = ?`).get(opened.sessionId) as { version: number };
  expect(version.version).toBe(3);
  const root = mkdtempSync(join(tmpdir(), "memmy-m2-schema-"));
  roots.push(root);
  const database = new MemoryDb({ path: join(root, "memory.sqlite") });
  database.db.prepare(`INSERT INTO memories (id, timeline, user_id, memory_type, status, visibility, memory_key, memory_value, tags_json, info_json, properties_json, memory_layer, version, created_at, updated_at) VALUES ('pol1', 't', 'u', 'LongTermMemory', 'activated', 'private', 'policy:0123456789abcdef', 'v', '[]', '{}', '{}', 'L2', 1, 't', 't')`).run();
  database.db.prepare(`UPDATE schema_migrations SET version = 9`).run();
  migrate(database.db);
  const key = database.db.prepare(`SELECT memory_key AS key FROM memories WHERE id = 'pol1'`).get() as { key: string };
  expect(key.key).toBe("policy:global:0123456789abcdef");
  migrate(database.db);
  expect((database.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'memory_conflicts'`).get() as { name: string }).name).toBe("memory_conflicts");
  database.close();
}

function checkpointSpan(): void {
  const spans = checkpointsFromHistory([
    { turnId: "t1", toolCalls: [{ name: "todo_write", input: { todos: [{ id: "a", content: "改过滤", status: "in_progress" }] } }, { name: "Edit", input: { file_path: "a.ts" } }] },
    { turnId: "t2", toolCalls: [{ name: "todo_write", input: { todos: [{ id: "a", content: "改过滤", status: "completed" }] } }] }
  ]);
  expect(spans).toHaveLength(1);
  expect(spans[0]?.sourceTraceIds).toEqual(["t1", "t2"]);
  expect(spans[0]?.status).toBe("completed");
  expect(spans[0]?.summary).toContain("Edit a.ts");
  const shifted = checkpointsFromHistory([
    { turnId: "t1", toolCalls: [
      { name: "Read", input: { file_path: "before.ts" } },
      { name: "todo_write", input: { todos: [{ id: "a", content: "改过滤", status: "in_progress" }] } },
      { name: "Edit", input: { file_path: "a.ts" } }
    ] },
    { turnId: "t2", toolCalls: [{ name: "todo_write", input: { todos: [{ id: "a", content: "改过滤", status: "completed" }] } }] }
  ]);
  expect(shifted[0]?.toolCallRanges[0]).toEqual({ traceId: "t1", start: 1, end: 2 });
  expect(shifted[0]?.summary).not.toContain("before.ts");
  expect(shifted[0]?.summary).toContain("Edit a.ts");
}

function abandoned(): void {
  const spans = checkpointsFromHistory([
    { turnId: "t1", toolCalls: [{ name: "TodoWrite", input: { todos: [{ id: "b", content: "未完成", status: "in_progress" }] } }] }
  ], true);
  expect(spans[0]?.status).toBe("abandoned");
}

function summary(): void {
  const spans = checkpointsFromHistory([
    { turnId: "t1", toolCalls: [{ name: "update_plan", input: { plan: [{ id: "c", step: "写测试", status: "in_progress" }, { id: "c", step: "写测试", status: "completed" }] } }] }
  ]);
  expect(spans[0]?.summary.startsWith("写测试")).toBe(true);
  expect(spans[0]?.summary).not.toMatch(/llm/i);
}

function spanFilter(): void {
  const hits = ["parent-a", "parent-b", "s1", "s2", "s3"].map((id, index) => hit(id, index < 2 ? "trace" : "span"));
  const memories = [
    memory("parent-a", "trace"),
    memory("parent-b", "trace"),
    memory("s1", "span", ["parent-a", "parent-b"], "checkpoint"),
    memory("s2", "span", ["parent-a", "parent-b"], "checkpoint"),
    memory("s3", "span", ["parent-a", "parent-b"], "checkpoint")
  ];
  const kept = filterL1TraceSpanRecallHits(hits, memories).map((item) => item.id);
  expect(kept).toEqual(["s1", "s2", "s3"]);
}

function topic(): void {
  const first = assignTopic({ unitId: "u1", name: "召回", listId: "list-1", existing: [] });
  const second = assignTopic({
    unitId: "u1",
    name: "召回",
    listId: "list-1",
    existing: [{ id: first.topicId, name: "召回", listId: "list-1" }],
    assigned: { u1: first.topicId }
  });
  const named = assignTopic({ unitId: "u2", name: "召回", existing: [{ id: first.topicId, name: "召回" }] });
  const created = assignTopic({ unitId: "u3", name: "权限", existing: [{ id: first.topicId, name: "召回" }] });
  expect(second).toEqual({ topicId: first.topicId, created: false });
  expect(named.topicId).toBe(first.topicId);
  expect(created.created).toBe(true);
}

function bounded(): void {
  const view = buildTopicView({
    summary: "s".repeat(200),
    description: "d".repeat(4000),
    decisions: Array.from({ length: 30 }, (_, index) => ({ id: `d${index}`, text: "x".repeat(200) })),
    experiences: Array.from({ length: 20 }, (_, index) => ({ id: `e${index}`, text: "y".repeat(200) })),
    events: Array.from({ length: 40 }, (_, index) => ({ id: `v${index}`, text: "z".repeat(200) })),
    conflicts: Array.from({ length: 12 }, (_, index) => ({ id: `c${index}`, text: "c".repeat(200) }))
  });
  expect((view.decisions as unknown[]).length).toBe(8);
  expect((view.experiences as unknown[]).length).toBe(5);
  expect((view.events as unknown[]).length).toBe(10);
  expect((view.conflicts as unknown[]).length).toBe(5);
  expect(topicRowBytes(view)).toBeLessThanOrEqual(8192);
}

function policy(): void {
  const hash = "0123456789abcdef";
  expect(policyMemoryKey(hash, "ws_a")).not.toBe(policyMemoryKey(hash, "ws_b"));
  expect(resolvePolicyKey([`policy:${hash}`], hash, "global")).toBe(`policy:${hash}`);
  expect(resolvePolicyKey([policyMemoryKey(hash, "global")], hash, "global")).toBe(policyMemoryKey(hash, "global"));
}

function evidence(): void {
  expect(truncateEvidence(Array.from({ length: 25 }, (_, index) => `t${index}`))).toEqual(
    Array.from({ length: 20 }, (_, index) => `t${index + 5}`)
  );
}

function rephrase(): void {
  const changed = rephrasedDecision({ id: "d1", text: "不加列" }, "改为加 scope 列", "查询更快");
  expect(changed.id).toBe("d1");
  expect(changed.lastChange.relation).toBe("contradict");
  const prompt = readFileSync(new URL("../../src/service/work-memory/work-memory-pipeline.ts", import.meta.url), "utf8");
  expect(prompt).toContain("改口");
}

function hit(id: string, kind: RecallHit["kind"]): RecallHit {
  return { id, kind, memoryLayer: "L1", status: "activated", snippet: id, score: 1, tags: [], source: "search" };
}

function memory(id: string, kind: string, sourceIds: string[] = [], segmenter?: string): MemoryRow {
  const at = "2026-10-22T00:00:00.000Z";
  return {
    id,
    timeline: at,
    userId: "u",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryValue: id,
    tags: [],
    info: {},
    properties: {
      internal_info: {
        memory_layer: "L1",
        memory_kind: kind as MemoryKind,
        span: { source_trace_id: sourceIds[0], source_trace_ids: sourceIds, segmenter }
      }
    },
    memoryLayer: "L1",
    version: 1,
    createdAt: at,
    updatedAt: at
  };
}

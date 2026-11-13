import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb, MemoryService } from "../../../src/index.js";
import { SCHEMA_VERSION } from "../../../src/storage/schema.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());

describe("v10 migration", () => {
  it("retires pre-v10 project rows so they never reach L1 recall", async () => {
    const path = join(fixture.createTestRoot("pm-legacy-"), "memory.sqlite");
    const before = new MemoryDb({ path });
    const service = new MemoryService({ db: before, mode: "dev" });
    const legacy = service.addMemory({ content: "旧版项目记忆：推送失败重试三次", source: "memmy", layer: "L1" });
    const kept = service.addMemory({ content: "普通 L1 记忆：喜欢深色主题", source: "memmy", layer: "L1" });
    await service.stop();
    before.db.prepare(
      `UPDATE memories SET info_json = json_set(info_json, '$.source', 'project_memory_add') WHERE id = ?`
    ).run(legacy.id);
    before.db.prepare("UPDATE schema_migrations SET version = 9").run();
    before.close();

    const after = new MemoryDb({ path });
    try {
      const version = after.db.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get();
      expect(version).toBe(SCHEMA_VERSION);
      const rows = after.db.prepare(
        `SELECT id, status, deleted_at IS NOT NULL AS deleted, json_extract(properties_json, '$.status') AS property_status
         FROM memories WHERE id IN (?, ?) ORDER BY id = ? DESC`
      ).all(legacy.id, kept.id, legacy.id) as Array<{ id: string; status: string; deleted: number; property_status: string | null }>;
      expect(rows[0]).toMatchObject({ id: legacy.id, status: "deleted", deleted: 1, property_status: "deleted" });
      expect(rows[1]).toMatchObject({ id: kept.id, deleted: 0 });
      expect(rows[1]!.status).not.toBe("deleted");

      const indexed = after.db.prepare("SELECT id FROM memories_fts WHERE id IN (?, ?)").pluck().all(legacy.id, kept.id);
      expect(indexed).not.toContain(legacy.id);
    } finally {
      after.close();
    }
  });
});

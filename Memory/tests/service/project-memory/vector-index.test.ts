import { afterEach, describe, expect, it, vi } from "vitest";
import type { Embedder } from "../../../src/model/types.js";
import { SqliteProjectMemoryStore } from "../../../src/service/project-memory/store/sqlite/sqlite-store.js";
import type { TopicChange } from "../../../src/service/project-memory/contract/types.js";
import { createProjectMemoryHarness } from "./helpers.js";

const harness = createProjectMemoryHarness();
afterEach(() => harness.cleanup());
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const { db } = harness.createService();
  const embed = vi.fn(async (): Promise<number[][]> => [[1, 0]]);
  const embedder = { config: { provider: "openai_compatible", model: "test-a" }, embed,
    status: () => ({ configured: true }), isRemote: () => false } as unknown as Embedder;
  const store = new SqliteProjectMemoryStore({ db: db.db, embedder: () => embedder });
  await store.createSpace({ spaceId: "s", domains: [{ domain: "工程", description: "" }] });
  async function write(key: string, change: TopicChange) {
    const result = await store.commitChangeSet({ spaceId: "s", taskId: key, sourceBatchId: key, idempotencyKey: key, topics: [change] }, { acceptedAt: new Date().toISOString() });
    expect(result.ok).toBe(true);
  }
  await write("create", { op: "create", topicId: "t", domain: "工程", expectedTopicSeq: 0,
    topicName: "推送", topicSummary: "重试三次", topicDescription: "", decisions: [], experiences: [], timelineAppend: [], sourcesAppend: [] });
  const update = async () => write("update", { op: "update", topicId: "t", domain: "工程", expectedRevision: 1,
    topicSummary: "重试五次", decisions: [], experiences: [], timelineAppend: [], sourcesAppend: [] });
  const row = () => db.db.prepare("SELECT * FROM pm_topic_vectors WHERE topic_id = 't'").get();
  return { store, embed, embedder, update, row };
}

describe("project vector index freshness", () => {
  it("invalidates the old vector in the content transaction even when re-embedding fails", async () => {
    const { store, embed, update, row } = await fixture();
    await store.indexTopics(["t"]);
    expect(row()).toBeDefined();
    await update();
    embed.mockRejectedValueOnce(new Error("offline"));
    await store.indexTopics(["t"]);
    expect(row()).toBeUndefined();
    expect((await store.getTopicsFull("s", ["t"]))[0]?.topicSummary).toBe("重试五次");
  });

  it("does not overwrite a current vector with an older async result", async () => {
    const { store, embed, update, row } = await fixture();
    const late = deferred<number[][]>();
    embed.mockImplementationOnce(() => late.promise);
    const pending = store.indexTopics(["t"]);
    await update();
    await store.indexTopics(["t"]);
    const current = row();
    late.resolve([[0, 1]]);
    await pending;
    expect(row()).toEqual(current);
  });

  it.each(["model", "delete"])("discards pending vectors after a %s change", async (change) => {
    const { store, embed, embedder, row } = await fixture();
    const late = deferred<number[][]>();
    embed.mockImplementationOnce(() => late.promise);
    const pending = store.indexTopics(["t"]);
    if (change === "model") embedder.config.model = "test-b";
    else await store.deleteTopics(["t"]);
    late.resolve([[1, 0]]);
    await pending;
    expect(row()).toBeUndefined();
  });
});

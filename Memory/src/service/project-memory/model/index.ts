import type { Embedder } from "../../../model/types.js";
import { createMemoryLogger, memoryErrorFields } from "../../../logging/logger.js";
import type { RecallRequest, RecallResult, StoreCapabilities } from "../contract/types.js";
import type { ProjectMemoryStore } from "../store/store.js";
import type { ProjectVectorStore, TopicVectorWrite } from "../store/vector-store.js";

const log = createMemoryLogger("project-memory.index");
type DataStore = ProjectMemoryStore & ProjectVectorStore;

/** J01: model orchestration around deterministic storage. Re-read config after every await. */
export class IndexedProjectMemoryStore implements ProjectMemoryStore {
  constructor(private readonly data: DataStore, private readonly getEmbedder: () => Embedder | null) {}

  private configuredEmbedder(): { embedder: Embedder; model: string } | null {
    const embedder = this.getEmbedder();
    return embedder?.status().configured
      ? { embedder, model: `${embedder.config.provider}:${embedder.config.model ?? "default"}` }
      : null;
  }

  capabilities(): StoreCapabilities {
    const model = this.configuredEmbedder()?.model ?? null;
    const capabilities = this.data.capabilities();
    return { ...capabilities, vector: model ? capabilities.vector : "none", embeddingModel: model };
  }

  async recall(request: RecallRequest): Promise<RecallResult> {
    const configured = this.configuredEmbedder();
    if (!configured) return this.data.queryIndex(request, { model: null, vectors: [] });
    const stale = this.data.staleVectorTopicIds(request, configured.model);
    if (stale.length > 0) {
      void this.indexTopics(stale.slice(0, 64)).catch((error: unknown) => log.warn("index.failed", memoryErrorFields(error)));
      return this.data.queryIndex(request, { model: null, vectors: [] });
    }
    try {
      const vectors = request.queries.length ? await configured.embedder.embed(request.queries.map((query) => query.text), "query") : [];
      if (this.configuredEmbedder()?.model !== configured.model || vectors.length !== request.queries.length
        || vectors.some((vector) => !vector.length || !vector.every(Number.isFinite))) {
        return this.data.queryIndex(request, { model: null, vectors: [] });
      }
      return this.data.queryIndex(request, { model: configured.model, vectors });
    } catch (error) {
      log.warn("recall.embedding_failed", memoryErrorFields(error));
      return this.data.queryIndex(request, { model: null, vectors: [] });
    }
  }

  async indexTopics(topicIds: string[]): Promise<void> {
    const configured = this.configuredEmbedder();
    if (!configured || topicIds.length === 0) return;
    const pending = this.data.pendingVectorInputs(topicIds, configured.model);
    if (!pending.length) return;
    try {
      const vectors = await configured.embedder.embed(pending.map((input) => input.text), "document");
      if (this.configuredEmbedder()?.model !== configured.model) return;
      const writes: TopicVectorWrite[] = pending.flatMap((input, index) => {
        const vector = vectors[index];
        return vector?.length && vector.every(Number.isFinite) ? [{ ...input, vector }] : [];
      });
      this.data.writeTopicVectors(configured.model, writes);
    } catch (error) {
      log.warn("index.embedding_failed", { topics: pending.length, ...memoryErrorFields(error) });
    }
  }

  createSpace(...args: Parameters<ProjectMemoryStore["createSpace"]>) { return this.data.createSpace(...args); }
  getSpace(...args: Parameters<ProjectMemoryStore["getSpace"]>) { return this.data.getSpace(...args); }
  updateSpace(...args: Parameters<ProjectMemoryStore["updateSpace"]>) { return this.data.updateSpace(...args); }
  deleteSpace(...args: Parameters<ProjectMemoryStore["deleteSpace"]>) { return this.data.deleteSpace(...args); }
  listDomains(...args: Parameters<ProjectMemoryStore["listDomains"]>) { return this.data.listDomains(...args); }
  createDomains(...args: Parameters<ProjectMemoryStore["createDomains"]>) { return this.data.createDomains(...args); }
  updateDomains(...args: Parameters<ProjectMemoryStore["updateDomains"]>) { return this.data.updateDomains(...args); }
  deleteDomains(...args: Parameters<ProjectMemoryStore["deleteDomains"]>) { return this.data.deleteDomains(...args); }
  getTopicsFull(...args: Parameters<ProjectMemoryStore["getTopicsFull"]>) { return this.data.getTopicsFull(...args); }
  listTopics(...args: Parameters<ProjectMemoryStore["listTopics"]>) { return this.data.listTopics(...args); }
  commitChangeSet(...args: Parameters<ProjectMemoryStore["commitChangeSet"]>) { return this.data.commitChangeSet(...args); }
  clearSpace(...args: Parameters<ProjectMemoryStore["clearSpace"]>) { return this.data.clearSpace(...args); }
  deleteTopics(...args: Parameters<ProjectMemoryStore["deleteTopics"]>) { return this.data.deleteTopics(...args); }
}

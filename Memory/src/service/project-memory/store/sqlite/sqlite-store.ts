import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { Embedder } from "../../../../model/types.js";
import { vectorToBuffer } from "../../../../storage/sqlite-vec-store.js";
import { createMemoryLogger, memoryErrorFields } from "../../../../logging/logger.js";
import { ProjectMemoryError } from "../../contract/errors.js";
import { PROJECT_MEMORY_LIMITS } from "../../contract/limits.js";
import type {
  ChangeSet,
  CommitResult,
  DecisionSnapshot,
  DomainRecord,
  ExperienceSnapshot,
  HistoryItem,
  RecallEntry,
  RecallRequest,
  RecallResult,
  RecallScores,
  RecallTopic,
  SourceRef,
  SpaceRecord,
  StoreCapabilities,
  TimelineSnapshot,
  TopicChange,
  TopicSnapshot
} from "../../contract/types.js";
import { charLength, ftsMatchExpression, normalizeForCompare, textTokens, tokenOverlap, uniqueTokens } from "../../text.js";
import type { CommitContext, DomainUpdate, ListTopicsFilter, ProjectMemoryStore } from "../store.js";
import { applyDecisionEntries, applyExperienceOp, type MutableDecision, type MutableExperience } from "./apply.js";

const log = createMemoryLogger("project-memory.store");

type Db = Database.Database;

interface TopicRow {
  id: string;
  space_id: string;
  domain: string;
  topic_name: string;
  topic_summary: string;
  topic_description: string;
  revision: number;
  domain_seq: number;
  create_time: string;
  update_time: string;
}

interface EntryRow {
  id: string;
  topic_id: string;
  content: string;
  time: string;
  user_ids_json: string;
}

interface SpaceRow {
  space_id: string;
  space_name: string | null;
  instructions: string | null;
  create_time: string;
  update_time: string;
  cleared_at: string | null;
}

export interface SqliteProjectMemoryStoreOptions {
  db: Db;
  /** Read on every use: the host swaps its embedder when the model config changes. */
  embedder?: () => Embedder | null;
  now?: () => Date;
}

function parseIds(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function spaceFromRow(row: SpaceRow): SpaceRecord {
  return {
    spaceId: row.space_id,
    spaceName: row.space_name,
    instructions: row.instructions,
    createTime: row.create_time,
    updateTime: row.update_time,
    clearedAt: row.cleared_at
  };
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function vectorTable(dim: number): string {
  if (!Number.isSafeInteger(dim) || dim <= 0) throw new Error(`invalid embedding dimension ${dim}`);
  return `pm_topics_vec_${dim}`;
}

function limitError(field: string, limit: number, length: number): ProjectMemoryError {
  return new ProjectMemoryError("FIELD_LIMIT_EXCEEDED", `${field} exceeds ${limit} characters`, { field, limit, length });
}

function checkLength(field: string, value: string, limit: number, allowEmpty = false): void {
  const length = charLength(value);
  if (!allowEmpty && length === 0) throw new ProjectMemoryError("STRUCTURE_VIOLATION", `${field} must not be empty`, { field });
  if (length > limit) throw limitError(field, limit, length);
}

const ENTRY_LIMITS = {
  decision: PROJECT_MEMORY_LIMITS.decision,
  experience: PROJECT_MEMORY_LIMITS.experience,
  timeline: PROJECT_MEMORY_LIMITS.timeline
} as const;

export function timelineFingerprint(content: string, time: string): string {
  return sha(`${normalizeForCompare(content)}\u0000${time}`);
}

/**
 * Local-mode ProjectMemoryStore (v3 §5.2): one SQLite file, FTS5 for lexical
 * recall, sqlite-vec for vector recall, and a single transaction for L03.
 */
export class SqliteProjectMemoryStore implements ProjectMemoryStore {
  private readonly db: Db;
  private readonly embedderRef: () => Embedder | null;
  private readonly now: () => Date;

  constructor(options: SqliteProjectMemoryStoreOptions) {
    this.db = options.db;
    this.embedderRef = options.embedder ?? (() => null);
    this.now = options.now ?? (() => new Date());
  }

  private get embedder(): Embedder | null {
    return this.embedderRef();
  }

  capabilities(): StoreCapabilities {
    const embedding = this.embeddingModel();
    return {
      fullText: "fts5",
      vector: embedding ? "sqlite-vec" : "none",
      conditionalWrite: true,
      teardownFence: "local_queue",
      embeddingModel: embedding,
      embeddingDim: null
    };
  }

  // ---------------------------------------------------------------- spaces

  async createSpace(input: {
    spaceId: string;
    spaceName?: string | null;
    instructions?: string | null;
    domains: DomainRecord[];
  }): Promise<{ space: SpaceRecord; created: boolean }> {
    return this.db.transaction(() => {
      const existing = this.spaceRow(input.spaceId);
      if (existing) return { space: spaceFromRow(existing), created: false };
      const now = this.nowIso();
      this.db.prepare(
        `INSERT INTO pm_spaces (space_id, space_name, instructions, create_time, update_time, cleared_at)
         VALUES (?, ?, ?, ?, ?, NULL)`
      ).run(input.spaceId, input.spaceName ?? null, input.instructions ?? null, now, now);
      this.insertDomains(input.spaceId, input.domains, 0);
      return { space: spaceFromRow(this.spaceRow(input.spaceId)!), created: true };
    })();
  }

  async getSpace(spaceId: string): Promise<SpaceRecord | undefined> {
    const row = this.spaceRow(spaceId);
    return row ? spaceFromRow(row) : undefined;
  }

  async updateSpace(spaceId: string, input: { instructions?: string | null; spaceName?: string | null }): Promise<SpaceRecord> {
    return this.db.transaction(() => {
      const row = this.requireSpace(spaceId);
      const instructions = input.instructions === undefined ? row.instructions : input.instructions;
      const spaceName = input.spaceName === undefined ? row.space_name : input.spaceName;
      this.db.prepare(
        `UPDATE pm_spaces SET instructions = ?, space_name = ?, update_time = ? WHERE space_id = ?`
      ).run(instructions, spaceName, this.nowIso(), spaceId);
      return spaceFromRow(this.spaceRow(spaceId)!);
    })();
  }

  async deleteSpace(spaceId: string): Promise<void> {
    this.db.transaction(() => {
      this.deleteTopicsInternal(this.topicIdsOfSpace(spaceId));
      this.db.prepare(`DELETE FROM pm_domain_topic_seq WHERE space_id = ?`).run(spaceId);
      this.db.prepare(`DELETE FROM pm_domains WHERE space_id = ?`).run(spaceId);
      this.db.prepare(`DELETE FROM pm_changesets WHERE space_id = ?`).run(spaceId);
      this.db.prepare(`DELETE FROM pm_spaces WHERE space_id = ?`).run(spaceId);
    })();
  }

  async clearSpace(spaceId: string): Promise<void> {
    this.db.transaction(() => {
      this.requireSpace(spaceId);
      this.deleteTopicsInternal(this.topicIdsOfSpace(spaceId));
      const now = this.nowIso();
      this.db.prepare(`UPDATE pm_spaces SET cleared_at = ?, update_time = ? WHERE space_id = ?`).run(now, now, spaceId);
    })();
  }

  async deleteTopics(topicIds: string[]): Promise<string[]> {
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT id FROM pm_topics WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`
      ).pluck().all(JSON.stringify(topicIds)) as string[];
      this.deleteTopicsInternal(existing);
      return existing;
    })();
  }

  // ---------------------------------------------------------------- domains

  async listDomains(spaceId: string): Promise<DomainRecord[]> {
    return this.domainRows(spaceId);
  }

  async createDomains(spaceId: string, domains: DomainRecord[]): Promise<DomainRecord[]> {
    return this.db.transaction(() => {
      this.requireSpace(spaceId);
      const current = this.domainRows(spaceId);
      const known = new Set(current.map((item) => item.domain));
      const fresh = domains.filter((item) => !known.has(item.domain));
      if (current.length + fresh.length > PROJECT_MEMORY_LIMITS.domainsPerSpace) {
        throw new ProjectMemoryError("DOMAIN_LIMIT_EXCEEDED", `a space holds at most ${PROJECT_MEMORY_LIMITS.domainsPerSpace} domains`, {
          limit: PROJECT_MEMORY_LIMITS.domainsPerSpace,
          current: current.length,
          requested: fresh.length
        });
      }
      this.insertDomains(spaceId, fresh, current.length);
      this.touchSpace(spaceId);
      return this.domainRows(spaceId);
    })();
  }

  async updateDomains(spaceId: string, updates: DomainUpdate[]): Promise<DomainRecord[]> {
    return this.db.transaction(() => {
      this.requireSpace(spaceId);
      const current = this.domainRows(spaceId);
      const known = new Set(current.map((item) => item.domain));
      const missing = updates.filter((item) => !known.has(item.domain)).map((item) => item.domain);
      if (missing.length > 0) {
        throw new ProjectMemoryError("DOMAIN_INVALID", "domains are not registered in this space", { domains: missing });
      }
      const renamedAway = new Set(updates.filter((item) => item.newDomain && item.newDomain !== item.domain).map((item) => item.domain));
      const finalNames = new Set([...known].filter((name) => !renamedAway.has(name)));
      const clashes: string[] = [];
      for (const item of updates) {
        if (!item.newDomain || item.newDomain === item.domain) continue;
        if (finalNames.has(item.newDomain)) clashes.push(item.newDomain);
        finalNames.add(item.newDomain);
      }
      if (clashes.length > 0) {
        throw new ProjectMemoryError("DOMAIN_CONFLICT", "renamed domains collide with existing ones", { domains: clashes });
      }
      const renames = updates.filter((item) => item.newDomain && item.newDomain !== item.domain);
      // Two phases so that swaps (a→b, b→a) never hit a primary-key collision.
      renames.forEach((item, index) => this.renameDomain(spaceId, item.domain, `\u0000rename:${index}`));
      renames.forEach((item, index) => this.renameDomain(spaceId, `\u0000rename:${index}`, item.newDomain!));
      for (const item of updates) {
        if (item.description === undefined) continue;
        this.db.prepare(`UPDATE pm_domains SET description = ? WHERE space_id = ? AND domain = ?`)
          .run(item.description, spaceId, item.newDomain ?? item.domain);
      }
      this.touchSpace(spaceId);
      return this.domainRows(spaceId);
    })();
  }

  async deleteDomains(spaceId: string, domains: string[]): Promise<DomainRecord[]> {
    return this.db.transaction(() => {
      this.requireSpace(spaceId);
      const inUse = this.db.prepare(
        `SELECT domain, COUNT(*) AS count FROM pm_topics
         WHERE space_id = ? AND domain IN (SELECT value FROM json_each(?))
         GROUP BY domain ORDER BY domain`
      ).all(spaceId, JSON.stringify(domains)) as Array<{ domain: string; count: number }>;
      if (inUse.length > 0) {
        throw new ProjectMemoryError("DOMAIN_IN_USE", "domains still have topics", {
          domains: inUse.map((row) => ({ domain: row.domain, topic_count: Number(row.count) }))
        });
      }
      const remove = this.db.prepare(`DELETE FROM pm_domains WHERE space_id = ? AND domain = ?`);
      const removeSeq = this.db.prepare(`DELETE FROM pm_domain_topic_seq WHERE space_id = ? AND domain = ?`);
      for (const domain of domains) {
        remove.run(spaceId, domain);
        removeSeq.run(spaceId, domain);
      }
      this.touchSpace(spaceId);
      return this.domainRows(spaceId);
    })();
  }

  // ---------------------------------------------------------------- recall (L01)

  async recall(request: RecallRequest): Promise<RecallResult> {
    const degraded: string[] = [];
    const domainsJson = request.domains && request.domains.length > 0 ? JSON.stringify(request.domains) : null;
    const spacesJson = JSON.stringify(request.spaceIds);
    const topicSeq = this.topicSeqFor(request.spaceIds, request.domains);

    let queryVectors: Array<number[] | null> = request.queries.map(() => null);
    let model = this.embeddingModel();
    const stale = model ? this.topicsWithStaleVector(model, spacesJson, domainsJson) : [];
    if (stale.length > 0) {
      // Vectors from another embedding model are not comparable: stay lexical
      // and re-index in the background (v3 §5.2 embedding consistency).
      void this.indexTopics(stale.slice(0, 64)).catch(() => undefined);
      model = null;
    }
    if (!model || !this.embedder) {
      degraded.push("vector");
    } else if (request.queries.length > 0) {
      try {
        queryVectors = await this.embedder.embed(request.queries.map((query) => query.text), "query");
      } catch (error) {
        log.warn("recall.embedding_failed", memoryErrorFields(error));
        degraded.push("vector");
      }
    }

    const conversationTopics = request.preferConversationId
      ? new Set(this.db.prepare(
          `SELECT DISTINCT topic_id FROM pm_sources WHERE conversation_id = ?`
        ).pluck().all(request.preferConversationId) as string[])
      : new Set<string>();

    const results: RecallResult["results"] = [];
    for (const [index, query] of request.queries.entries()) {
      const scores = new Map<string, RecallScores>();
      for (const hit of this.lexicalHits(query.text, spacesJson, domainsJson, request.topicK)) {
        scores.set(hit.topicId, { lexical: hit.score, vector: null });
      }
      const vector = queryVectors[index];
      if (vector && vector.length > 0 && model) {
        for (const hit of this.vectorHits(vector, model, spacesJson, domainsJson, request.topicK)) {
          const prior = scores.get(hit.topicId);
          scores.set(hit.topicId, { lexical: prior?.lexical ?? null, vector: hit.score });
        }
      }
      if (request.purpose === "merge" && scores.size < request.topicK) {
        // Small spaces: recent topics fill the remaining slots so the organizer
        // sees existing work before it decides to open a new topic.
        const recent = this.db.prepare(
          `SELECT id FROM pm_topics
           WHERE space_id IN (SELECT value FROM json_each(?))
             AND (? IS NULL OR domain IN (SELECT value FROM json_each(?)))
           ORDER BY update_time DESC, id ASC
           LIMIT ?`
        ).pluck().all(spacesJson, domainsJson, domainsJson, request.topicK) as string[];
        for (const topicId of recent) {
          if (scores.size >= request.topicK) break;
          if (!scores.has(topicId)) scores.set(topicId, { lexical: null, vector: null });
        }
      }
      const rows = this.topicRows([...scores.keys()]);
      const queryTokens = uniqueTokens(query.text);
      const topics: RecallTopic[] = rows.map((row) => ({
        topicId: row.id,
        spaceId: row.space_id,
        revision: row.revision,
        domain: row.domain,
        topicName: row.topic_name,
        topicSummary: row.topic_summary,
        topicDescription: row.topic_description,
        updateTime: row.update_time,
        hasConversation: conversationTopics.has(row.id),
        scores: scores.get(row.id)!,
        entries: request.entryK > 0 ? this.entryHits(row.id, queryTokens, request.entryK) : []
      }));
      results.push({ qid: query.qid, topics });
    }
    return { results, topicSeq, degraded };
  }

  // ---------------------------------------------------------------- full read (L02)

  async getTopicsFull(spaceId: string | null, topicIds: string[]): Promise<TopicSnapshot[]> {
    return this.readTopics(topicIds).filter((topic) => spaceId === null || topic.spaceId === spaceId);
  }

  async listTopics(spaceId: string, page: number, size: number, filter: ListTopicsFilter = {}): Promise<{ topics: TopicSnapshot[]; total: number }> {
    const related = filter.relatedId ?? null;
    const where = `space_id = ? AND (? IS NULL OR id IN (SELECT topic_id FROM pm_source_members WHERE member_id = ?))`;
    const total = Number(this.db.prepare(`SELECT COUNT(*) FROM pm_topics WHERE ${where}`).pluck().get(spaceId, related, related) ?? 0);
    const ids = this.db.prepare(
      `SELECT id FROM pm_topics WHERE ${where} ORDER BY update_time DESC, id ASC LIMIT ? OFFSET ?`
    ).pluck().all(spaceId, related, related, size, (page - 1) * size) as string[];
    return { topics: this.readTopics(ids), total };
  }

  // ---------------------------------------------------------------- conditional write (L03)

  async commitChangeSet(changeSet: ChangeSet, context: CommitContext): Promise<CommitResult> {
    return this.db.transaction((): CommitResult => {
      const replay = this.db.prepare(
        `SELECT result_json FROM pm_changesets WHERE idempotency_key = ?`
      ).pluck().get(changeSet.idempotencyKey) as string | undefined;
      if (replay) {
        const stored = JSON.parse(replay) as Extract<CommitResult, { ok: true }>;
        return { ...stored, replayed: true };
      }

      const space = this.spaceRow(changeSet.spaceId);
      if (!space) return { ok: false, error: "SPACE_GONE" };
      if (context.acceptedAt < space.create_time) return { ok: false, error: "SPACE_GONE" };
      if (space.cleared_at && context.acceptedAt < space.cleared_at) {
        return { ok: false, error: "SPACE_CLEARED", clearedAt: space.cleared_at };
      }

      const registered = new Set(this.domainRows(changeSet.spaceId).map((item) => item.domain));
      const creates = changeSet.topics.filter((topic) => topic.op === "create");
      const invalidDomains = [...new Set(creates.map((topic) => topic.domain).filter((domain) => !registered.has(domain)))];
      if (invalidDomains.length > 0) return { ok: false, error: "DOMAIN_INVALID", domains: invalidDomains };

      const updates = changeSet.topics.filter((topic) => topic.op === "update");
      const currentRows = new Map(this.topicRows(updates.map((topic) => topic.topicId)).map((row) => [row.id, row]));
      const missing = updates
        .filter((topic) => currentRows.get(topic.topicId)?.space_id !== changeSet.spaceId)
        .map((topic) => topic.topicId);
      if (missing.length > 0) return { ok: false, error: "TOPIC_NOT_FOUND", topicIds: missing };
      const stale = updates.flatMap((topic) => {
        const current = currentRows.get(topic.topicId)!;
        return topic.expectedRevision === current.revision
          ? []
          : [{ topicId: topic.topicId, expectedRevision: topic.expectedRevision ?? 0, currentRevision: current.revision }];
      });
      if (stale.length > 0) return { ok: false, error: "VERSION_CONFLICT", topics: stale };

      const seqByDomain = new Map<string, number>();
      for (const topic of creates) {
        if (seqByDomain.has(topic.domain)) continue;
        const current = this.topicSeq(changeSet.spaceId, topic.domain);
        const expected = topic.expectedTopicSeq ?? -1;
        if (expected !== current) {
          const newTopicIds = this.db.prepare(
            `SELECT id FROM pm_topics WHERE space_id = ? AND domain = ? AND domain_seq > ? ORDER BY domain_seq`
          ).pluck().all(changeSet.spaceId, topic.domain, Math.max(expected, 0)) as string[];
          return { ok: false, error: "TOPIC_SET_CHANGED", domain: topic.domain, expectedTopicSeq: expected, currentTopicSeq: current, newTopicIds };
        }
        seqByDomain.set(topic.domain, current);
      }

      const now = this.nowIso();
      const written: Array<{ topicId: string; revision: number; updateTime: string }> = [];
      for (const change of changeSet.topics) {
        written.push(change.op === "create"
          ? this.applyCreate(changeSet.spaceId, change, seqByDomain, now)
          : this.applyUpdate(currentRows.get(change.topicId)!, change, now));
      }
      for (const [domain, seq] of seqByDomain) {
        this.db.prepare(
          `INSERT INTO pm_domain_topic_seq (space_id, domain, topic_seq) VALUES (?, ?, ?)
           ON CONFLICT(space_id, domain) DO UPDATE SET topic_seq = excluded.topic_seq`
        ).run(changeSet.spaceId, domain, seq);
      }
      for (const item of written) this.reindexText(item.topicId);

      const result: Extract<CommitResult, { ok: true }> = { ok: true, replayed: false, topics: written };
      this.db.prepare(
        `INSERT INTO pm_changesets (idempotency_key, space_id, task_id, result_json, committed_at) VALUES (?, ?, ?, ?, ?)`
      ).run(changeSet.idempotencyKey, changeSet.spaceId, changeSet.taskId, JSON.stringify(result), now);
      return result;
    })();
  }

  // ---------------------------------------------------------------- vectors (L05)

  async indexTopics(topicIds: string[]): Promise<void> {
    const model = this.embeddingModel();
    if (!model || !this.embedder || topicIds.length === 0) return;
    const topics = this.readTopics(topicIds);
    const pending = topics
      .map((topic) => ({ topic, text: topicEmbeddingText(topic) }))
      .map((item) => ({ ...item, hash: sha(`${model}\u0000${item.text}`) }))
      .filter((item) => {
        const current = this.db.prepare(`SELECT source_hash FROM pm_topic_vectors WHERE topic_id = ?`).pluck().get(item.topic.topicId);
        return current !== item.hash;
      });
    if (pending.length === 0) return;
    let vectors: number[][];
    try {
      vectors = await this.embedder.embed(pending.map((item) => item.text), "document");
    } catch (error) {
      log.warn("index.embedding_failed", { topics: pending.length, ...memoryErrorFields(error) });
      return;
    }
    this.db.transaction(() => {
      pending.forEach((item, index) => {
        const vector = vectors[index];
        if (!vector || vector.length === 0) return;
        if (!this.topicRows([item.topic.topicId])[0]) return;
        this.deleteVector(item.topic.topicId);
        const info = this.db.prepare(
          `INSERT INTO pm_topic_vectors (topic_id, embedding_model, embedding_dim, source_hash, updated_at) VALUES (?, ?, ?, ?, ?)`
        ).run(item.topic.topicId, model, vector.length, item.hash, this.nowIso());
        const table = this.ensureVectorTable(vector.length);
        this.db.prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, ?)`).run(BigInt(info.lastInsertRowid), vectorToBuffer(vector));
      });
    })();
  }

  // ---------------------------------------------------------------- internals

  private embeddingModel(): string | null {
    if (!this.embedder) return null;
    const status = this.embedder.status();
    if (!status.configured) return null;
    return `${this.embedder.config.provider}:${this.embedder.config.model ?? "default"}`;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private spaceRow(spaceId: string): SpaceRow | undefined {
    return this.db.prepare(`SELECT * FROM pm_spaces WHERE space_id = ?`).get(spaceId) as SpaceRow | undefined;
  }

  private requireSpace(spaceId: string): SpaceRow {
    const row = this.spaceRow(spaceId);
    if (!row) throw new ProjectMemoryError("SPACE_NOT_FOUND", `space ${spaceId} does not exist`, { space_id: spaceId });
    return row;
  }

  private touchSpace(spaceId: string): void {
    this.db.prepare(`UPDATE pm_spaces SET update_time = ? WHERE space_id = ?`).run(this.nowIso(), spaceId);
  }

  private domainRows(spaceId: string): DomainRecord[] {
    return (this.db.prepare(
      `SELECT domain, description FROM pm_domains WHERE space_id = ? ORDER BY position, domain`
    ).all(spaceId) as Array<{ domain: string; description: string }>).map((row) => ({ domain: row.domain, description: row.description }));
  }

  private insertDomains(spaceId: string, domains: DomainRecord[], startPosition: number): void {
    const insert = this.db.prepare(
      `INSERT INTO pm_domains (space_id, domain, description, position) VALUES (?, ?, ?, ?)`
    );
    const seq = this.db.prepare(
      `INSERT OR IGNORE INTO pm_domain_topic_seq (space_id, domain, topic_seq) VALUES (?, ?, 0)`
    );
    domains.forEach((item, index) => {
      insert.run(spaceId, item.domain, item.description, startPosition + index);
      seq.run(spaceId, item.domain);
    });
  }

  private renameDomain(spaceId: string, from: string, to: string): void {
    this.db.prepare(`UPDATE pm_domains SET domain = ? WHERE space_id = ? AND domain = ?`).run(to, spaceId, from);
    this.db.prepare(`UPDATE pm_domain_topic_seq SET domain = ? WHERE space_id = ? AND domain = ?`).run(to, spaceId, from);
    this.db.prepare(`UPDATE pm_topics SET domain = ? WHERE space_id = ? AND domain = ?`).run(to, spaceId, from);
  }

  private topicSeq(spaceId: string, domain: string): number {
    const value = this.db.prepare(
      `SELECT topic_seq FROM pm_domain_topic_seq WHERE space_id = ? AND domain = ?`
    ).pluck().get(spaceId, domain);
    return Number(value ?? 0);
  }

  private topicSeqFor(spaceIds: string[], domains: string[] | undefined): Record<string, number> {
    const result: Record<string, number> = {};
    for (const spaceId of spaceIds) {
      const names = domains && domains.length > 0 ? domains : this.domainRows(spaceId).map((item) => item.domain);
      for (const domain of names) {
        result[spaceIds.length === 1 ? domain : `${spaceId}/${domain}`] = this.topicSeq(spaceId, domain);
      }
    }
    return result;
  }

  private topicIdsOfSpace(spaceId: string): string[] {
    return this.db.prepare(`SELECT id FROM pm_topics WHERE space_id = ? ORDER BY id`).pluck().all(spaceId) as string[];
  }

  private topicRows(topicIds: string[]): TopicRow[] {
    if (topicIds.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT * FROM pm_topics WHERE id IN (SELECT value FROM json_each(?))`
    ).all(JSON.stringify(topicIds)) as TopicRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return topicIds.flatMap((id) => byId.get(id) ?? []);
  }

  private topicsWithStaleVector(model: string, spacesJson: string, domainsJson: string | null): string[] {
    return this.db.prepare(
      `SELECT t.id
       FROM pm_topics AS t
       JOIN pm_topic_vectors AS v ON v.topic_id = t.id
       WHERE t.space_id IN (SELECT value FROM json_each(?))
         AND (? IS NULL OR t.domain IN (SELECT value FROM json_each(?)))
         AND v.embedding_model IS NOT ?
       ORDER BY t.id`
    ).pluck().all(spacesJson, domainsJson, domainsJson, model) as string[];
  }

  private lexicalHits(text: string, spacesJson: string, domainsJson: string | null, limit: number): Array<{ topicId: string; score: number }> {
    const match = ftsMatchExpression(text);
    if (!match) return [];
    const rows = this.db.prepare(
      `SELECT f.topic_id AS topic_id, bm25(pm_topics_fts) AS rank
       FROM pm_topics_fts AS f
       JOIN pm_topics AS t ON t.id = f.topic_id
       WHERE pm_topics_fts MATCH ?
         AND t.space_id IN (SELECT value FROM json_each(?))
         AND (? IS NULL OR t.domain IN (SELECT value FROM json_each(?)))
       ORDER BY rank ASC, f.topic_id ASC
       LIMIT ?`
    ).all(match, spacesJson, domainsJson, domainsJson, limit) as Array<{ topic_id: string; rank: number }>;
    return rows.map((row) => ({ topicId: row.topic_id, score: -Number(row.rank) }));
  }

  private vectorHits(vector: number[], model: string, spacesJson: string, domainsJson: string | null, limit: number): Array<{ topicId: string; score: number }> {
    const table = vectorTable(vector.length);
    if (!this.tableExists(table)) return [];
    const candidates = this.db.prepare(
      `SELECT v.id AS id, v.topic_id AS topic_id
       FROM pm_topic_vectors AS v
       JOIN pm_topics AS t ON t.id = v.topic_id
       WHERE v.embedding_model = ? AND v.embedding_dim = ?
         AND t.space_id IN (SELECT value FROM json_each(?))
         AND (? IS NULL OR t.domain IN (SELECT value FROM json_each(?)))`
    ).all(model, vector.length, spacesJson, domainsJson, domainsJson) as Array<{ id: number; topic_id: string }>;
    if (candidates.length === 0) return [];
    const topicByRow = new Map(candidates.map((row) => [Number(row.id), row.topic_id]));
    const rows = this.db.prepare(
      `SELECT rowid, distance FROM ${table}
       WHERE embedding MATCH ? AND k = ?
         AND rowid IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
       ORDER BY distance`
    ).all(vectorToBuffer(vector), Math.min(limit, candidates.length), JSON.stringify(candidates.map((row) => row.id))) as Array<{ rowid: number; distance: number }>;
    return rows.flatMap((row) => {
      const topicId = topicByRow.get(Number(row.rowid));
      return topicId ? [{ topicId, score: 1 - Number(row.distance) }] : [];
    });
  }

  private entryHits(topicId: string, queryTokens: string[], limit: number): RecallEntry[] {
    if (queryTokens.length === 0) return [];
    const hits: Array<RecallEntry & { order: number }> = [];
    const decisions = this.db.prepare(`SELECT id, content FROM pm_decisions WHERE topic_id = ? ORDER BY rowid`).all(topicId) as Array<{ id: string; content: string }>;
    const conflicts = this.db.prepare(`SELECT content FROM pm_decision_conflicts WHERE decision_id = ?`).pluck();
    for (const row of decisions) {
      const texts = [row.content, ...(conflicts.all(row.id) as string[])];
      const score = Math.max(...texts.map((text) => tokenOverlap(queryTokens, text)));
      if (score > 0) hits.push({ kind: "decision", id: row.id, scores: { lexical: score, vector: null }, order: hits.length });
    }
    for (const [kind, table] of [["experience", "pm_experiences"], ["timeline", "pm_timeline"]] as const) {
      const rows = this.db.prepare(`SELECT id, content FROM ${table} WHERE topic_id = ? ORDER BY rowid`).all(topicId) as Array<{ id: string; content: string }>;
      for (const row of rows) {
        const score = tokenOverlap(queryTokens, row.content);
        if (score > 0) hits.push({ kind, id: row.id, scores: { lexical: score, vector: null }, order: hits.length });
      }
    }
    return hits
      .sort((left, right) => (right.scores.lexical ?? 0) - (left.scores.lexical ?? 0) || left.order - right.order)
      .slice(0, limit)
      .map(({ order: _order, ...entry }) => entry);
  }

  private readTopics(topicIds: string[]): TopicSnapshot[] {
    return this.topicRows(topicIds).map((row) => this.readTopic(row));
  }

  private readTopic(row: TopicRow): TopicSnapshot {
    const decisionRows = this.db.prepare(`SELECT * FROM pm_decisions WHERE topic_id = ? ORDER BY rowid`).all(row.id) as EntryRow[];
    const decisions: DecisionSnapshot[] = decisionRows.map((decision) => ({
      id: decision.id,
      content: decision.content,
      time: decision.time,
      userIds: parseIds(decision.user_ids_json),
      conflicts: (this.db.prepare(
        `SELECT seq, content, time, user_ids_json FROM pm_decision_conflicts WHERE decision_id = ? ORDER BY seq`
      ).all(decision.id) as Array<{ seq: number; content: string; time: string; user_ids_json: string }>).map((item) => ({
        seq: Number(item.seq),
        content: item.content,
        time: item.time,
        userIds: parseIds(item.user_ids_json)
      })),
      history: this.historyRows("pm_decision_history", "decision_id", decision.id)
    }));
    const experiences: ExperienceSnapshot[] = (this.db.prepare(
      `SELECT * FROM pm_experiences WHERE topic_id = ? ORDER BY rowid`
    ).all(row.id) as EntryRow[]).map((experience) => ({
      id: experience.id,
      content: experience.content,
      time: experience.time,
      userIds: parseIds(experience.user_ids_json),
      history: this.historyRows("pm_experience_history", "experience_id", experience.id)
    }));
    const timeline: TimelineSnapshot[] = (this.db.prepare(
      `SELECT * FROM pm_timeline WHERE topic_id = ? ORDER BY time, rowid`
    ).all(row.id) as EntryRow[]).map((item) => ({
      id: item.id,
      content: item.content,
      time: item.time,
      userIds: parseIds(item.user_ids_json)
    }));
    const sources: SourceRef[] = (this.db.prepare(
      `SELECT user_id, agent_id, conversation_id FROM pm_sources WHERE topic_id = ? ORDER BY added_at, user_id, agent_id, conversation_id`
    ).all(row.id) as Array<{ user_id: string; agent_id: string; conversation_id: string }>).map((source) => ({
      userId: source.user_id,
      agentId: source.agent_id || null,
      conversationId: source.conversation_id || null
    }));
    return {
      topicId: row.id,
      spaceId: row.space_id,
      domain: row.domain,
      topicName: row.topic_name,
      topicSummary: row.topic_summary,
      topicDescription: row.topic_description,
      revision: row.revision,
      createTime: row.create_time,
      updateTime: row.update_time,
      decisions,
      experiences,
      timeline,
      sources
    };
  }

  private historyRows(table: "pm_decision_history" | "pm_experience_history", column: string, id: string): HistoryItem[] {
    return (this.db.prepare(
      `SELECT seq, content, time, user_ids_json, reason FROM ${table} WHERE ${column} = ? ORDER BY seq`
    ).all(id) as Array<{ seq: number; content: string; time: string; user_ids_json: string; reason: string | null }>).map((item) => ({
      seq: Number(item.seq),
      content: item.content,
      time: item.time,
      userIds: parseIds(item.user_ids_json),
      reason: item.reason
    }));
  }

  private applyCreate(
    spaceId: string,
    change: TopicChange,
    seqByDomain: Map<string, number>,
    now: string
  ): { topicId: string; revision: number; updateTime: string } {
    const name = change.topicName ?? "";
    checkLength("topic_name", name, PROJECT_MEMORY_LIMITS.topicName);
    checkLength("topic_summary", change.topicSummary ?? "", PROJECT_MEMORY_LIMITS.topicSummary, true);
    checkLength("topic_description", change.topicDescription ?? "", PROJECT_MEMORY_LIMITS.topicDescription, true);
    if (this.topicRows([change.topicId]).length > 0) {
      throw new ProjectMemoryError("STRUCTURE_VIOLATION", `topic ${change.topicId} already exists`);
    }
    const domainSeq = (seqByDomain.get(change.domain) ?? 0) + 1;
    seqByDomain.set(change.domain, domainSeq);
    this.db.prepare(
      `INSERT INTO pm_topics (id, space_id, domain, topic_name, topic_summary, topic_description, revision, domain_seq, create_time, update_time)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(change.topicId, spaceId, change.domain, name, change.topicSummary ?? "", change.topicDescription ?? "", domainSeq, now, now);
    this.applyEntries(change.topicId, change, now);
    return { topicId: change.topicId, revision: 1, updateTime: now };
  }

  private applyUpdate(row: TopicRow, change: TopicChange, now: string): { topicId: string; revision: number; updateTime: string } {
    if (change.topicName !== undefined) checkLength("topic_name", change.topicName, PROJECT_MEMORY_LIMITS.topicName);
    if (change.topicSummary !== undefined) checkLength("topic_summary", change.topicSummary, PROJECT_MEMORY_LIMITS.topicSummary, true);
    if (change.topicDescription !== undefined) checkLength("topic_description", change.topicDescription, PROJECT_MEMORY_LIMITS.topicDescription, true);
    // update_time must move forward even when two commits share a millisecond.
    const updateTime = now > row.update_time ? now : new Date(Date.parse(row.update_time) + 1).toISOString();
    const revision = row.revision + 1;
    this.db.prepare(
      `UPDATE pm_topics
       SET topic_name = ?, topic_summary = ?, topic_description = ?, revision = ?, update_time = ?
       WHERE id = ?`
    ).run(
      change.topicName ?? row.topic_name,
      change.topicSummary ?? row.topic_summary,
      change.topicDescription ?? row.topic_description,
      revision,
      updateTime,
      row.id
    );
    this.applyEntries(row.id, change, now);
    return { topicId: row.id, revision, updateTime };
  }

  private applyEntries(topicId: string, change: TopicChange, now: string): void {
    const decisions = new Map<string, MutableDecision>();
    for (const op of change.decisions) {
      if ("content" in op && op.content !== undefined) checkLength("decision", op.content, ENTRY_LIMITS.decision);
      const current = decisions.get(op.decisionId) ?? this.loadDecision(topicId, op.decisionId);
      const applied = applyDecisionEntries(current, op, {
        idExists: (id) => decisions.has(id) || this.decisionIdExists(id)
      });
      for (const decision of applied) decisions.set(decision.id, decision);
    }
    for (const decision of decisions.values()) this.writeDecision(topicId, decision, now);

    const experiences = new Map<string, MutableExperience>();
    for (const op of change.experiences) {
      if ("content" in op) checkLength("experience", op.content, ENTRY_LIMITS.experience);
      const current = experiences.get(op.experienceId) ?? this.loadExperience(topicId, op.experienceId);
      experiences.set(op.experienceId, applyExperienceOp(current, op));
    }
    for (const experience of experiences.values()) this.writeExperience(topicId, experience, now);

    const timeline = this.db.prepare(
      `INSERT OR IGNORE INTO pm_timeline (id, topic_id, content, time, user_ids_json, fingerprint) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const item of change.timelineAppend) {
      checkLength("timeline", item.content, ENTRY_LIMITS.timeline);
      timeline.run(item.timelineId, topicId, item.content, item.time, JSON.stringify(item.userIds), timelineFingerprint(item.content, item.time));
    }

    const source = this.db.prepare(
      `INSERT OR IGNORE INTO pm_sources (topic_id, user_id, agent_id, conversation_id, added_at) VALUES (?, ?, ?, ?, ?)`
    );
    const member = this.db.prepare(`INSERT OR IGNORE INTO pm_source_members (topic_id, member_id, kind) VALUES (?, ?, ?)`);
    for (const item of change.sourcesAppend) {
      for (const userId of item.userIds) {
        source.run(topicId, userId, item.agentId ?? "", item.conversationId ?? "", now);
        member.run(topicId, userId, "user");
      }
      if (item.agentId) member.run(topicId, item.agentId, "agent");
    }
  }

  private decisionIdExists(id: string): boolean {
    return this.db.prepare(`SELECT 1 FROM pm_decisions WHERE id = ?`).get(id) !== undefined;
  }

  private loadDecision(topicId: string, decisionId: string): MutableDecision | undefined {
    const row = this.db.prepare(`SELECT * FROM pm_decisions WHERE id = ?`).get(decisionId) as EntryRow | undefined;
    if (!row) return undefined;
    if (row.topic_id !== topicId) {
      throw new ProjectMemoryError("STRUCTURE_VIOLATION", `decision ${decisionId} belongs to another topic`);
    }
    const conflicts = (this.db.prepare(
      `SELECT seq, content, time, user_ids_json FROM pm_decision_conflicts WHERE decision_id = ? ORDER BY seq`
    ).all(decisionId) as Array<{ seq: number; content: string; time: string; user_ids_json: string }>).map((item) => ({
      seq: Number(item.seq),
      content: item.content,
      time: item.time,
      userIds: parseIds(item.user_ids_json)
    }));
    return { id: row.id, content: row.content, time: row.time, userIds: parseIds(row.user_ids_json), conflicts, newHistory: [], isNew: false };
  }

  private loadExperience(topicId: string, experienceId: string): MutableExperience | undefined {
    const row = this.db.prepare(`SELECT * FROM pm_experiences WHERE id = ?`).get(experienceId) as EntryRow | undefined;
    if (!row) return undefined;
    if (row.topic_id !== topicId) {
      throw new ProjectMemoryError("STRUCTURE_VIOLATION", `experience ${experienceId} belongs to another topic`);
    }
    return { id: row.id, content: row.content, time: row.time, userIds: parseIds(row.user_ids_json), newHistory: [], isNew: false };
  }

  private writeDecision(topicId: string, decision: MutableDecision, now: string): void {
    if (decision.isNew) {
      this.db.prepare(`INSERT INTO pm_decisions (id, topic_id, content, time, user_ids_json) VALUES (?, ?, ?, ?, ?)`)
        .run(decision.id, topicId, decision.content, decision.time, JSON.stringify(decision.userIds));
    } else {
      this.db.prepare(`UPDATE pm_decisions SET content = ?, time = ?, user_ids_json = ? WHERE id = ?`)
        .run(decision.content, decision.time, JSON.stringify(decision.userIds), decision.id);
    }
    this.db.prepare(`DELETE FROM pm_decision_conflicts WHERE decision_id = ?`).run(decision.id);
    const conflict = this.db.prepare(
      `INSERT INTO pm_decision_conflicts (decision_id, seq, content, time, user_ids_json) VALUES (?, ?, ?, ?, ?)`
    );
    for (const item of decision.conflicts) conflict.run(decision.id, item.seq, item.content, item.time, JSON.stringify(item.userIds));
    this.appendHistory("pm_decision_history", "decision_id", decision.id, decision.newHistory, now);
  }

  private writeExperience(topicId: string, experience: MutableExperience, now: string): void {
    if (experience.isNew) {
      this.db.prepare(`INSERT INTO pm_experiences (id, topic_id, content, time, user_ids_json) VALUES (?, ?, ?, ?, ?)`)
        .run(experience.id, topicId, experience.content, experience.time, JSON.stringify(experience.userIds));
    } else {
      this.db.prepare(`UPDATE pm_experiences SET content = ?, time = ?, user_ids_json = ? WHERE id = ?`)
        .run(experience.content, experience.time, JSON.stringify(experience.userIds), experience.id);
    }
    this.appendHistory("pm_experience_history", "experience_id", experience.id, experience.newHistory, now);
  }

  private appendHistory(
    table: "pm_decision_history" | "pm_experience_history",
    column: "decision_id" | "experience_id",
    id: string,
    items: Array<{ content: string; time: string; userIds: string[]; reason: string | null }>,
    now: string
  ): void {
    if (items.length === 0) return;
    let seq = Number(this.db.prepare(`SELECT COALESCE(MAX(seq), 0) FROM ${table} WHERE ${column} = ?`).pluck().get(id) ?? 0);
    const insert = this.db.prepare(
      `INSERT INTO ${table} (${column}, seq, content, time, user_ids_json, reason, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of items) {
      seq += 1;
      insert.run(id, seq, item.content, item.time, JSON.stringify(item.userIds), item.reason, now);
    }
  }

  private reindexText(topicId: string): void {
    const [row] = this.topicRows([topicId]);
    if (!row) return;
    const topic = this.readTopic(row);
    const text = [
      topic.topicName,
      topic.topicSummary,
      topic.topicDescription,
      ...topic.decisions.flatMap((decision) => [decision.content, ...decision.conflicts.map((item) => item.content)]),
      ...topic.experiences.map((experience) => experience.content),
      ...topic.timeline.map((item) => item.content)
    ].join("\n");
    this.db.prepare(`DELETE FROM pm_topics_fts WHERE topic_id = ?`).run(topicId);
    this.db.prepare(`INSERT INTO pm_topics_fts (topic_id, tokens) VALUES (?, ?)`).run(topicId, textTokens(text).join(" "));
  }

  private deleteTopicsInternal(topicIds: string[]): void {
    for (const topicId of topicIds) {
      const decisionIds = this.db.prepare(`SELECT id FROM pm_decisions WHERE topic_id = ?`).pluck().all(topicId) as string[];
      const experienceIds = this.db.prepare(`SELECT id FROM pm_experiences WHERE topic_id = ?`).pluck().all(topicId) as string[];
      this.db.prepare(`DELETE FROM pm_decision_conflicts WHERE decision_id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(decisionIds));
      this.db.prepare(`DELETE FROM pm_decisions WHERE topic_id = ?`).run(topicId);
      // History rows can only go once their parent entry is gone (insert-only triggers).
      this.db.prepare(`DELETE FROM pm_decision_history WHERE decision_id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(decisionIds));
      this.db.prepare(`DELETE FROM pm_experiences WHERE topic_id = ?`).run(topicId);
      this.db.prepare(`DELETE FROM pm_experience_history WHERE experience_id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(experienceIds));
      this.db.prepare(`DELETE FROM pm_timeline WHERE topic_id = ?`).run(topicId);
      this.db.prepare(`DELETE FROM pm_sources WHERE topic_id = ?`).run(topicId);
      this.db.prepare(`DELETE FROM pm_source_members WHERE topic_id = ?`).run(topicId);
      this.db.prepare(`DELETE FROM pm_topics_fts WHERE topic_id = ?`).run(topicId);
      this.deleteVector(topicId);
      this.db.prepare(`DELETE FROM pm_topics WHERE id = ?`).run(topicId);
    }
  }

  private deleteVector(topicId: string): void {
    const row = this.db.prepare(`SELECT id, embedding_dim FROM pm_topic_vectors WHERE topic_id = ?`).get(topicId) as
      | { id: number; embedding_dim: number }
      | undefined;
    if (!row) return;
    const table = vectorTable(row.embedding_dim);
    if (this.tableExists(table)) this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(row.id));
    this.db.prepare(`DELETE FROM pm_topic_vectors WHERE id = ?`).run(row.id);
  }

  private ensureVectorTable(dim: number): string {
    const table = vectorTable(dim);
    this.db.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding float[${dim}] distance_metric=cosine)`).run();
    return table;
  }

  private tableExists(name: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(name));
  }
}

function topicEmbeddingText(topic: TopicSnapshot): string {
  const parts = [
    topic.topicName,
    topic.topicSummary,
    topic.topicDescription,
    ...topic.decisions.map((decision) => decision.content),
    ...topic.experiences.map((experience) => experience.content)
  ];
  return [...parts.join("\n")].slice(0, 2000).join("");
}

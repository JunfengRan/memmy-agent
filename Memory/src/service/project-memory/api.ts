import { ProjectMemoryError, invalidParams } from "./contract/errors.js";
import { PROJECT_MEMORY_LIMITS } from "./contract/limits.js";
import type { DomainRecord, SpaceRecord, TaskRecord, TopicSnapshot } from "./contract/types.js";
import type { ThreePathSearchOutput } from "./retrieve/recall-paths.js";
import type { MemoryViewSelection } from "./retrieve/search.js";
import type { ProjectMemoryService } from "./service.js";
import type { DomainUpdate } from "./store/store.js";
import { charLength } from "./text.js";

/**
 * HTTP contract for `/api/openmem/v1/*` (v3 §1.6). Parameters are validated
 * here once; the service layer assumes well-formed input.
 */
export const OPENMEM_PREFIX = "/api/openmem/v1/";

/** Routes that change state; every other project-memory route only needs read scope. */
export const OPENMEM_WRITE_ROUTES: ReadonlySet<string> = new Set([
  "add/message",
  "delete/memory",
  "create/space",
  "update/space",
  "delete/space",
  "create/domains",
  "update/domains",
  "delete/domains"
]);

/**
 * The route the dispatcher acts on. Authorization must use the same value, or a
 * trailing slash would reach a write route through the read-scope branch.
 */
export function openMemRoute(pathname: string): string | null {
  if (!pathname.startsWith(OPENMEM_PREFIX)) return null;
  return pathname.slice(OPENMEM_PREFIX.length).replace(/\/+$/, "");
}

export function openMemRouteWrites(pathname: string): boolean {
  const route = openMemRoute(pathname);
  return route !== null && OPENMEM_WRITE_ROUTES.has(route);
}

export interface OpenMemEnvelope {
  code: number;
  message: string;
  data: unknown;
}

export interface OpenMemRequest {
  method: string;
  path: string;
  body: unknown;
  timezone: string | null;
}

export interface OpenMemResult {
  envelope: OpenMemEnvelope;
  /** True when work was queued and the worker should be woken. */
  scheduled: boolean;
}

type Body = Record<string, unknown>;

function ok(data: unknown, scheduled = false): OpenMemResult {
  return { envelope: { code: 0, message: "ok", data }, scheduled };
}

export function errorEnvelope(error: ProjectMemoryError): OpenMemEnvelope {
  return { code: error.code, message: error.errorName, data: { detail: error.message, ...error.data } };
}

function asBody(body: unknown): Body {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw invalidParams("request body must be a JSON object");
  return body as Body;
}

function requireString(body: Body, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw invalidParams(`${field} must be a non-empty string`, { field });
  return value.trim();
}

function optionalString(body: Body, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw invalidParams(`${field} must be a non-empty string`, { field });
  return value.trim();
}

/** Local mode is single-viewpoint: arrays of users or agents need the cloud (SDK spec §请求字段). */
function singleIdentity(body: Body, field: "user_id" | "agent_id", required: boolean): string | null {
  const value = body[field];
  if (Array.isArray(value)) {
    throw new ProjectMemoryError("MODE_UNSUPPORTED", `${field} arrays require cloud mode`, { field });
  }
  if (value === undefined || value === null) {
    if (required) throw invalidParams(`${field} is required for project memory`, { field });
    return null;
  }
  if (typeof value !== "string" || !value.trim()) throw invalidParams(`${field} must be a non-empty string`, { field });
  return value.trim();
}

function stringList(body: Body, field: string, options: { required: boolean; max: number }): string[] {
  const value = body[field];
  if (value === undefined || value === null) {
    if (options.required) throw invalidParams(`${field} is required`, { field });
    return [];
  }
  const items = typeof value === "string" ? [value] : value;
  if (!Array.isArray(items) || items.length === 0) throw invalidParams(`${field} must be a non-empty string or string array`, { field });
  const result: string[] = [];
  for (const item of items) {
    if (typeof item !== "string" || !item.trim()) throw invalidParams(`${field} must not contain empty values`, { field });
    if (!result.includes(item.trim())) result.push(item.trim());
  }
  if (result.length > options.max) throw invalidParams(`${field} accepts at most ${options.max} values`, { field, limit: options.max });
  return result;
}

const LOCAL_MEMORY_VIEWS = new Set(["project", "detail_factual", "skill", "user_memory"]);
const UNSUPPORTED_LOCAL_VIEWS = new Set(["preference", "profile", "event", "tool_memory"]);

/**
 * Local search views. Omitted means paths ① and ② (user memory, L1, Skill), not project.
 * `preference` / `profile` / `event` / `tool_memory` are known cloud views and reject the
 * request. Any other string is an invalid parameter. Q-28 names the user-memory view.
 */
function includeMemoryViews(body: Body): MemoryViewSelection {
  const value = body.include_memory_view;
  if (value === undefined || value === null) {
    return { userMemory: true, agentLayers: ["L1", "Skill"], project: false };
  }
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw invalidParams("include_memory_view must be a non-empty string array", { field: "include_memory_view" });
  }
  const views = [...new Set(value.map((item) => (item as string).trim()))];
  const unknown = views.filter((view) => !LOCAL_MEMORY_VIEWS.has(view) && !UNSUPPORTED_LOCAL_VIEWS.has(view));
  if (unknown.length > 0) {
    throw invalidParams("include_memory_view has an unknown value", { field: "include_memory_view", values: unknown });
  }
  const unsupported = views.filter((view) => UNSUPPORTED_LOCAL_VIEWS.has(view));
  if (unsupported.length > 0) {
    throw new ProjectMemoryError("MODE_UNSUPPORTED", "this mode does not serve the requested memory views", {
      field: "include_memory_view",
      values: unsupported
    });
  }
  const agentLayers: Array<"L1" | "Skill"> = [];
  if (views.includes("detail_factual")) agentLayers.push("L1");
  if (views.includes("skill")) agentLayers.push("Skill");
  return {
    userMemory: views.includes("user_memory"),
    agentLayers,
    project: views.includes("project")
  };
}

function requireProjectView(body: Body, field: "allow_memory_view" | "include_memory_view"): void {
  const value = body[field];
  if (value === undefined || value === null) {
    throw invalidParams(`${field} must include "project" on this endpoint`, { field });
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalidParams(`${field} must be a string array`, { field });
  }
  if (!value.includes("project")) throw invalidParams(`${field} must include "project" on this endpoint`, { field });
  const others = value.filter((item) => item !== "project");
  if (others.length > 0) {
    throw new ProjectMemoryError("MODE_UNSUPPORTED", "only the project view is served under /api/openmem/v1 in this version", { field, values: others });
  }
}

function integer(body: Body, field: string, fallback: number, min: number, max: number): number {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw invalidParams(`${field} must be an integer between ${min} and ${max}`, { field });
  }
  return value;
}

function instructionsField(body: Body): string | null | undefined {
  const value = body.instructions;
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw invalidParams("instructions must be a string", { field: "instructions" });
  const length = charLength(value);
  if (length > PROJECT_MEMORY_LIMITS.instructions) {
    throw new ProjectMemoryError("FIELD_LIMIT_EXCEEDED", `instructions exceed ${PROJECT_MEMORY_LIMITS.instructions} characters`, {
      field: "instructions",
      limit: PROJECT_MEMORY_LIMITS.instructions,
      length
    });
  }
  return value === "" ? null : value;
}

function domainName(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalidParams(`${field} must be a non-empty string`, { field });
  return value.trim();
}

function domainBatch(value: unknown, allowEmpty: boolean): unknown[] {
  if (value === undefined || value === null) {
    if (allowEmpty) return [];
    throw invalidParams("domains is required", { field: "domains" });
  }
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw invalidParams("domains must be a non-empty array", { field: "domains" });
  }
  if (value.length > PROJECT_MEMORY_LIMITS.domainsPerBatch) {
    throw new ProjectMemoryError("DOMAIN_LIMIT_EXCEEDED", `at most ${PROJECT_MEMORY_LIMITS.domainsPerBatch} domains per request`, {
      limit: PROJECT_MEMORY_LIMITS.domainsPerBatch
    });
  }
  return value;
}

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

function parseDomainRecords(value: unknown, allowEmpty: boolean): DomainRecord[] {
  const records = domainBatch(value, allowEmpty).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidParams(`domains[${index}] must be an object`, { field: `domains[${index}]` });
    const record = item as Body;
    const description = record.description ?? "";
    if (typeof description !== "string") throw invalidParams(`domains[${index}].description must be a string`, { field: `domains[${index}].description` });
    return { domain: domainName(record.domain, `domains[${index}].domain`), description };
  });
  const dup = duplicates(records.map((item) => item.domain));
  if (dup.length > 0) throw new ProjectMemoryError("DOMAIN_CONFLICT", "duplicate domains in one batch", { domains: dup });
  return records;
}

function parseDomainUpdates(value: unknown): DomainUpdate[] {
  const updates = domainBatch(value, false).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidParams(`domains[${index}] must be an object`, { field: `domains[${index}]` });
    const record = item as Body;
    const update: DomainUpdate = { domain: domainName(record.domain, `domains[${index}].domain`) };
    if (record.new_domain !== undefined) update.newDomain = domainName(record.new_domain, `domains[${index}].new_domain`);
    if (record.description !== undefined) {
      if (typeof record.description !== "string") throw invalidParams(`domains[${index}].description must be a string`, { field: `domains[${index}].description` });
      update.description = record.description;
    }
    if (update.newDomain === undefined && update.description === undefined) {
      throw invalidParams(`domains[${index}] needs new_domain or description`, { field: `domains[${index}]` });
    }
    return update;
  });
  const dup = [
    ...duplicates(updates.map((item) => item.domain)),
    ...duplicates(updates.flatMap((item) => (item.newDomain ? [item.newDomain] : [])))
  ];
  if (dup.length > 0) throw new ProjectMemoryError("DOMAIN_CONFLICT", "duplicate domains in one batch", { domains: dup });
  return updates;
}

function spaceView(space: SpaceRecord): Record<string, unknown> {
  return {
    space_id: space.spaceId,
    space_name: space.spaceName,
    instructions: space.instructions,
    create_time: space.createTime,
    update_time: space.updateTime
  };
}

function entry(item: { content: string; time: string; userIds: string[] }): Record<string, unknown> {
  return { content: item.content, time: item.time, user_ids: item.userIds };
}

/** Full topic form for get/memory (PRD 完整示例): every entry and the source conversations. */
export function topicDetail(topic: TopicSnapshot): Record<string, unknown> {
  const sources = new Map<string, { user_ids: string[]; agent_id: string | null; conversation_id: string | null }>();
  for (const source of topic.sources) {
    const key = `${source.agentId ?? ""}\u0000${source.conversationId ?? ""}`;
    const item = sources.get(key) ?? { user_ids: [], agent_id: source.agentId, conversation_id: source.conversationId };
    if (!item.user_ids.includes(source.userId)) item.user_ids.push(source.userId);
    sources.set(key, item);
  }
  return {
    id: topic.topicId,
    space_id: topic.spaceId,
    domain: topic.domain,
    topic_name: topic.topicName,
    topic_summary: topic.topicSummary,
    topic_description: topic.topicDescription,
    decisions: topic.decisions.map((decision) => ({
      ...entry(decision),
      ...(decision.history.length > 0 ? { history: decision.history.map((item) => ({ ...entry(item), reason: item.reason })) } : {}),
      ...(decision.conflicts.length > 0 ? { conflicts: decision.conflicts.map(entry) } : {})
    })),
    experiences: topic.experiences.map((experience) => ({
      ...entry(experience),
      ...(experience.history.length > 0 ? { history: experience.history.map((item) => ({ ...entry(item), reason: item.reason })) } : {})
    })),
    timeline: topic.timeline.map(entry),
    sources: [...sources.values()].map((item) => ({
      user_id: item.user_ids.length === 1 ? item.user_ids[0] : item.user_ids,
      agent_id: item.agent_id,
      conversation_id: item.conversation_id
    })),
    create_time: topic.createTime,
    update_time: topic.updateTime
  };
}

function taskView(task: TaskRecord): Record<string, unknown> {
  return {
    task_id: task.taskId,
    status: task.status,
    memory_views: {
      added: task.added,
      updated: task.updated,
      deleted: 0,
      project: { memory_ids: task.memoryIds, deferred_count: task.deferredCount }
    },
    ...(task.error ? { error: task.error } : {})
  };
}

function searchData(views: MemoryViewSelection, result: ThreePathSearchOutput): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  // A failed project path still returns an empty list so the response stays 200.
  if (views.project) data.topic_detail_list = result.topics ?? [];
  if (result.userMemory !== undefined) data.user_memory = result.userMemory;
  if (result.agentMemory !== undefined) data.agent_memory = result.agentMemory;
  if (result.degraded.length > 0) data.degraded = result.degraded;
  return data;
}

/** Returns null when the path is not a project-memory route. */
export async function handleOpenMemRequest(service: ProjectMemoryService, request: OpenMemRequest): Promise<OpenMemResult | null> {
  const route = openMemRoute(request.path);
  if (route === null) return null;
  const topicMatch = /^get\/memory\/([^/]+)$/.exec(route);
  if (topicMatch && (request.method === "GET" || request.method === "POST")) {
    const topic = await service.getTopic(decodeURIComponent(topicMatch[1]!));
    return ok({ topic_detail_list: [topicDetail(topic)] });
  }
  if (request.method !== "POST") return null;
  const body = asBody(request.body);

  switch (route) {
    case "add/message": {
      requireProjectView(body, "allow_memory_view");
      const userId = singleIdentity(body, "user_id", true)!;
      const task = await service.addMessage({
        userId,
        agentId: singleIdentity(body, "agent_id", false),
        conversationId: optionalString(body, "conversation_id") ?? null,
        spaceIds: stringList(body, "space_ids", { required: true, max: PROJECT_MEMORY_LIMITS.spacesPerRequest }),
        domains: stringList(body, "domains", { required: false, max: PROJECT_MEMORY_LIMITS.domainsPerSpace }),
        messages: body.messages,
        timezone: request.timezone
      });
      return ok({ success: true, task_id: task.taskId, status: task.status }, task.status === "running");
    }
    case "search/memory": {
      const views = includeMemoryViews(body);
      const userId = singleIdentity(body, "user_id", true)!;
      const relativity = body.relativity;
      if (relativity !== undefined && relativity !== null && (typeof relativity !== "number" || relativity < 0 || relativity > 1)) {
        throw invalidParams("relativity must be a number between 0 and 1", { field: "relativity" });
      }
      const domains = stringList(body, "domains", { required: false, max: PROJECT_MEMORY_LIMITS.domainsPerSpace });
      const result = await service.search({
        userId,
        spaceIds: stringList(body, "space_ids", { required: views.project, max: PROJECT_MEMORY_LIMITS.spacesPerRequest }),
        ...(domains.length > 0 ? { domains } : {}),
        query: requireString(body, "query"),
        conversationId: optionalString(body, "conversation_id"),
        memoryLimit: integer(body, "memory_limit_number", PROJECT_MEMORY_LIMITS.memoryLimitDefault, 1, PROJECT_MEMORY_LIMITS.memoryLimitMax),
        ...(typeof relativity === "number" ? { relativity } : {}),
        views
      });
      return ok(searchData(views, result));
    }
    case "get/status": {
      return ok(taskView(service.getTask(requireString(body, "task_id"))));
    }
    case "get/memory": {
      if (body.user_id !== undefined || body.agent_id !== undefined) {
        throw new ProjectMemoryError("MODE_UNSUPPORTED", "project topics are only read by space_id", { field: body.user_id !== undefined ? "user_id" : "agent_id" });
      }
      const spaceId = requireString(body, "space_id");
      const page = integer(body, "page", 1, 1, Number.MAX_SAFE_INTEGER);
      const size = integer(body, "size", PROJECT_MEMORY_LIMITS.getMemorySizeDefault, 1, PROJECT_MEMORY_LIMITS.getMemorySizeMax);
      const filter = body.filter && typeof body.filter === "object" && !Array.isArray(body.filter) ? (body.filter as Body) : {};
      const relatedId = optionalString(filter, "related_id");
      const { topics, total } = await service.listTopics(spaceId, page, size, relatedId);
      return ok({ topic_detail_list: topics.map(topicDetail), total, size, current: page, pages: Math.ceil(total / size) });
    }
    case "delete/memory": {
      const hasSpace = body.space_id !== undefined;
      const hasIds = body.memory_ids !== undefined;
      if (hasSpace === hasIds) throw invalidParams("pass exactly one of space_id or memory_ids", { field: "space_id" });
      if (hasSpace) {
        await service.clearSpace(requireString(body, "space_id"));
        return ok({ success: true });
      }
      const deleted = await service.deleteTopics(stringList(body, "memory_ids", { required: true, max: 1000 }));
      return ok({ success: true, deleted_ids: deleted });
    }
    case "create/space": {
      // MemOS generates space_id and every call creates a new Space (PRD 11/03, open-questions Q-04).
      if (body.space_id !== undefined) throw invalidParams("space_id is generated by MemOS; pass space_name only", { field: "space_id" });
      const spaceName = requireString(body, "space_name");
      const space = await service.createSpace({
        spaceName,
        instructions: instructionsField(body) ?? null,
        domains: parseDomainRecords(body.domains, true)
      });
      return ok(spaceView(space));
    }
    case "get/space":
      return ok(spaceView(await service.getSpace(requireString(body, "space_id"))));
    case "update/space": {
      const spaceId = requireString(body, "space_id");
      const instructions = instructionsField(body);
      const spaceName = optionalString(body, "space_name");
      if (instructions === undefined && spaceName === undefined) {
        throw invalidParams("pass space_name or instructions", { field: "instructions" });
      }
      await service.updateSpace(spaceId, {
        ...(instructions !== undefined ? { instructions } : {}),
        ...(spaceName !== undefined ? { spaceName } : {})
      });
      return ok({ success: true });
    }
    case "delete/space":
      await service.deleteSpace(requireString(body, "space_id"));
      return ok({ success: true });
    case "create/domains": {
      const spaceId = requireString(body, "space_id");
      return ok({ space_id: spaceId, domains: await service.createDomains(spaceId, parseDomainRecords(body.domains, false)) });
    }
    case "list/domains": {
      const spaceId = requireString(body, "space_id");
      return ok({ space_id: spaceId, domains: await service.listDomains(spaceId) });
    }
    case "update/domains": {
      const spaceId = requireString(body, "space_id");
      return ok({ space_id: spaceId, domains: await service.updateDomains(spaceId, parseDomainUpdates(body.domains)) });
    }
    case "delete/domains": {
      const spaceId = requireString(body, "space_id");
      const names = domainBatch(body.domains, false).map((item, index) => domainName(item, `domains[${index}]`));
      return ok({ space_id: spaceId, domains: await service.deleteDomains(spaceId, names) });
    }
    default:
      return null;
  }
}

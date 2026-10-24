import type { MemoryRow, RecallHit } from "../../types.js";

/** ADR-004 initial coefficients. Tests and retrieval both read this table. */
export const SCOPE_WEIGHTS = {
  projectSession: {
    sameProjectL1: 1,
    sameProjectL2: 1.3,
    globalL2: 1,
    globalSkill: 1,
    globalL1: 0.5,
    otherProjectPolicy: 0.4
  }
} as const;

export interface ScopeQuery {
  /**
   * A project id, `null` for a window known to have no project directory, or `undefined`
   * when the caller is not project-aware (explicit search) and every memory keeps weight 1.
   */
  sessionProjectId: string | null | undefined;
  query?: string;
  namedProjectIds?: readonly string[];
}

export function memoryProjectId(memory: Pick<MemoryRow, "info">): string | null {
  const value = memory.info.project_id ?? memory.info.projectId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function memoryScopeOf(memory: Pick<MemoryRow, "info">): "global" | "project" {
  const explicit = memory.info.memory_scope;
  if (explicit === "global" || explicit === "project") return explicit;
  return memoryProjectId(memory) ? "project" : "global";
}

export function memoryKindOf(memory: Pick<MemoryRow, "properties">): string {
  const kind = memory.properties.internal_info.memory_kind;
  return typeof kind === "string" && kind ? kind : "trace";
}

/** Null means the memory stays out of the candidate set. */
export function scopeWeight(scope: ScopeQuery, memory: Pick<MemoryRow, "info" | "properties" | "memoryLayer">): number | null {
  if (typeof memory.info.duplicate_of === "string" && memory.info.duplicate_of) return null;
  const layer = memory.memoryLayer;
  const kind = memoryKindOf(memory);
  const projectId = memoryProjectId(memory);
  const memoryScope = memoryScopeOf(memory);
  const sameProject = Boolean(scope.sessionProjectId) && projectId === scope.sessionProjectId;
  const otherProject = memoryScope === "project" && !sameProject;
  const weights = SCOPE_WEIGHTS;

  if (scope.sessionProjectId === undefined) return 1;
  // A window with no project directory treats every project memory as another project's.
  if (otherProject && (layer === "L1" || kind === "topic")) return null;
  if (otherProject && kind === "policy") return weights.projectSession.otherProjectPolicy;
  if (otherProject) return null;
  if (!scope.sessionProjectId) return 1;
  if (sameProject && layer === "L2") return weights.projectSession.sameProjectL2;
  if (sameProject && layer === "L1") return weights.projectSession.sameProjectL1;
  if (memoryScope === "global" && layer === "L1") return weights.projectSession.globalL1;
  if (memoryScope === "global" && layer === "Skill") return weights.projectSession.globalSkill;
  if (memoryScope === "global" && layer === "L2") return weights.projectSession.globalL2;
  return 1;
}

export function memoriesVisibleForScope<T extends MemoryRow>(memories: readonly T[], scope: ScopeQuery): T[] {
  return memories.filter((memory) => scopeWeight(scope, memory) !== null);
}

export function applyScopeWeights(input: {
  hits: readonly RecallHit[];
  memories: readonly MemoryRow[];
  sessionProjectId: string | null | undefined;
  query?: string;
  namedProjectIds?: readonly string[];
}): RecallHit[] {
  const scope = {
    sessionProjectId: input.sessionProjectId,
    query: input.query,
    namedProjectIds: input.namedProjectIds
  };
  const byId = new Map(input.memories.map((memory) => [memory.id, memory]));
  return input.hits
    .flatMap((hit) => {
      const memory = byId.get(hit.id);
      if (!memory) return [hit];
      const weight = scopeWeight(scope, memory);
      if (weight === null) return [];
      return [{ ...hit, score: round(hit.score * weight) }];
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

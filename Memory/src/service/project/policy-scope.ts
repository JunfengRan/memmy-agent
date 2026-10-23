export function policyMemoryKey(hash16: string, scopeKey: string): string {
  return `policy:${scopeKey}:${hash16}`;
}

export function legacyPolicyKey(hash16: string): string {
  return `policy:${hash16}`;
}

export function resolvePolicyKey(existingKeys: readonly string[], hash16: string, scopeKey: string): string {
  const scoped = policyMemoryKey(hash16, scopeKey);
  if (existingKeys.includes(scoped)) return scoped;
  const legacy = legacyPolicyKey(hash16);
  if (scopeKey === "global" && existingKeys.includes(legacy)) return legacy;
  return scoped;
}

export function truncateEvidence(ids: readonly string[], limit = 20): string[] {
  return ids.slice(-Math.max(0, limit));
}

export function projectScopeKey(projectId: unknown): string {
  return typeof projectId === "string" && projectId.trim() ? projectId.trim() : "global";
}

export function policyScopeKeyFromMemory(memory: { memoryKey?: string | null; info?: Record<string, unknown> | null }): string {
  const key = memory.memoryKey ?? "";
  const scoped = /^policy:([^:]+):([0-9a-f]{16})$/.exec(key);
  if (scoped?.[1]) return scoped[1];
  if (/^policy:[0-9a-f]{16}$/.test(key)) return "global";
  const info = memory.info ?? {};
  if (info.memory_scope === "global") return "global";
  return projectScopeKey(info.project_id ?? info.projectId);
}

export function groupByProjectScope<T>(
  items: readonly T[],
  projectIdOf: (item: T) => unknown
): Array<{ scopeKey: string; traces: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const scopeKey = projectScopeKey(projectIdOf(item));
    const list = groups.get(scopeKey) ?? [];
    list.push(item);
    groups.set(scopeKey, list);
  }
  return [...groups.entries()].map(([scopeKey, traces]) => ({ scopeKey, traces }));
}

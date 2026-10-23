export type AccessLevel = "admin" | "write" | "read" | "none";

const RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };

export function effectiveLevel(app: AccessLevel = "write", agent: AccessLevel = "write"): AccessLevel {
  return RANK[app] <= RANK[agent] ? app : agent;
}

export function canReadMemory(level: AccessLevel, visibility: string): boolean {
  if (level === "none") return false;
  if (visibility === "restricted") return RANK[level] >= RANK.read;
  return true;
}

export function aclAllows(level: AccessLevel, action: "read" | "write"): { allow: boolean; level: AccessLevel } {
  const allow = action === "read" ? RANK[level] >= RANK.read : RANK[level] >= RANK.write;
  return { allow, level };
}

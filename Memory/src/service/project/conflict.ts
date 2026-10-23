import type { AccessLevel } from "./access.js";

const RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };

export interface Adjudication {
  status: "open" | "resolved";
  winner?: "a" | "b";
  resolvedBy?: "user" | "level";
}

export function adjudicate(input: {
  userWinner?: "a" | "b";
  levelA: AccessLevel;
  levelB: AccessLevel;
}): Adjudication {
  if (input.userWinner) return { status: "resolved", winner: input.userWinner, resolvedBy: "user" };
  if (RANK[input.levelA] > RANK[input.levelB]) return { status: "resolved", winner: "a", resolvedBy: "level" };
  if (RANK[input.levelB] > RANK[input.levelA]) return { status: "resolved", winner: "b", resolvedBy: "level" };
  return { status: "open" };
}

export interface SystemUpdate {
  id: string;
  markdown: string;
  deliveredAt?: string;
}

export function deliverOnce(updates: readonly SystemUpdate[], now: string): { deliver: SystemUpdate[]; rest: SystemUpdate[] } {
  const deliver = updates.filter((update) => !update.deliveredAt);
  const deliveredIds = new Set(deliver.map((update) => update.id));
  return {
    deliver,
    rest: updates.map((update) => deliveredIds.has(update.id) ? { ...update, deliveredAt: now } : update)
  };
}

export function revalidateOneLayer(ids: readonly string[], limit = 30): string[] {
  return ids.slice(0, Math.max(0, limit));
}

export function dreamCanResolve(kind: string, evidenceClear: boolean): boolean {
  return kind === "claim" && evidenceClear;
}

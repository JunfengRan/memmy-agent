import type { Entry } from "./entries.js";

export function monthlyTotal(entries: readonly Entry[]): number {
  return entries.reduce((sum, entry) => {
    if (entry.amount === null) return sum;
    return sum + entry.amount;
  }, 0);
}

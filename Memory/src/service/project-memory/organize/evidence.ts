import type { RawTurnRecord } from "../contract/types.js";
import { stripInjectedText } from "../inject/strip.js";

/** Quotes, not retrieval receipts. Each quote is bound to an actual assistant turn. */
export interface Disclosure {
  turnId: string;
  time: string;
  conclusions: string[];
}

/** Authorization equality preserves operators, signs, case and punctuation. */
export function evidenceText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function evidenceTurn(value: unknown, messages: readonly RawTurnRecord[], context: readonly RawTurnRecord[]): RawTurnRecord | undefined {
  const row = record(value);
  if (!row) return;
  const message = row.message_idx;
  const prior = row.context_idx;
  // Exactly one source reference. Do not coerce strings/null into indices.
  if (message !== undefined && prior !== undefined) return;
  if (typeof message === "number" && Number.isInteger(message) && message >= 0) return messages[message];
  if (typeof prior === "number" && Number.isInteger(prior) && prior >= 0) return context[prior];
}

export function parseDisclosures(value: unknown, messages: readonly RawTurnRecord[], context: readonly RawTurnRecord[]): Disclosure[] {
  if (!Array.isArray(value)) return [];
  const disclosures: Disclosure[] = [];
  for (const item of value) {
    const row = record(item);
    const source = evidenceTurn(item, messages, context);
    if (!row || source?.role !== "assistant" || !Array.isArray(row.conclusions)) continue;
    const text = stripInjectedText(source.content).text;
    const conclusions = [...new Set(row.conclusions.filter((quote): quote is string =>
      typeof quote === "string" && quote.trim().length > 0 && text.includes(quote)
    ))];
    if (conclusions.length) disclosures.push({ turnId: source.turnId, time: source.chatTime, conclusions });
  }
  return disclosures;
}

export function adoptedBy(value: unknown, source: RawTurnRecord, messages: readonly RawTurnRecord[], context: readonly RawTurnRecord[]): string[] {
  const row = record(value);
  const member = evidenceTurn(value, messages, context);
  if (source.role !== "assistant" || member?.role !== "user" || !member.roleId || !row || typeof row.quote !== "string" || !row.quote.trim()) return [];
  if (Date.parse(member.chatTime) < Date.parse(source.chatTime)) return [];
  return stripInjectedText(member.content).text.includes(row.quote) ? [member.roleId] : [];
}

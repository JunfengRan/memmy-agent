/**
 * Deterministic tokenization shared by the FTS index (L01) and entry trimming (M09).
 * FTS5 unicode61 keeps a run of CJK characters as one token, so CJK text is
 * indexed as overlapping bigrams and Latin text as lower-cased words.
 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const WORD = /[\p{L}\p{N}_]+/gu;

export function textTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const word = match[0];
    let latin = "";
    let cjkRun = "";
    const flushLatin = () => {
      if (latin.length >= 2 || /\d/.test(latin)) tokens.push(latin);
      latin = "";
    };
    const flushCjk = () => {
      if (cjkRun.length === 1) tokens.push(cjkRun);
      for (let index = 0; index + 1 < cjkRun.length; index += 1) tokens.push(cjkRun.slice(index, index + 2));
      cjkRun = "";
    };
    for (const char of word) {
      if (CJK.test(char)) {
        flushLatin();
        cjkRun += char;
      } else {
        flushCjk();
        latin += char;
      }
    }
    flushLatin();
    flushCjk();
  }
  return tokens;
}

export function uniqueTokens(text: string): string[] {
  return [...new Set(textTokens(text))];
}

/** FTS5 MATCH expression: every distinct token quoted and OR-ed. */
export function ftsMatchExpression(text: string): string | null {
  const tokens = uniqueTokens(text).slice(0, 64);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, "\"\"")}"`).join(" OR ");
}

/** Share of query tokens present in the text; 0 when nothing overlaps. */
export function tokenOverlap(queryTokens: readonly string[], text: string): number {
  if (queryTokens.length === 0) return 0;
  const haystack = new Set(textTokens(text));
  let hits = 0;
  for (const token of queryTokens) if (haystack.has(token)) hits += 1;
  return hits / queryTokens.length;
}

export function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function clampText(text: string, limit: number): string {
  const trimmed = text.trim();
  const chars = [...trimmed];
  return chars.length <= limit ? trimmed : chars.slice(0, limit).join("");
}

export function charLength(text: string): number {
  return [...text].length;
}

export const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
export const mean = (values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;

export function prf(truePositive, predicted, expected) {
  const precision = predicted ? truePositive / predicted : expected ? 0 : 1;
  const recall = expected ? truePositive / expected : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

// Han characters are scored one by one; Latin words and numbers stay whole.
export function tokenize(text) {
  return String(text ?? "").toLowerCase().match(/\p{Script=Han}|[\p{L}\p{N}_]+/gu) ?? [];
}

export function tokenF1(prediction, reference) {
  const predicted = tokenize(prediction);
  const expected = tokenize(reference);
  if (!predicted.length || !expected.length) return predicted.length === expected.length ? 1 : 0;
  const counts = new Map();
  for (const token of expected) counts.set(token, (counts.get(token) ?? 0) + 1);
  let overlap = 0;
  for (const token of predicted) {
    const left = counts.get(token) ?? 0;
    if (left > 0) { overlap += 1; counts.set(token, left - 1); }
  }
  return prf(overlap, predicted.length, expected.length).f1;
}

// B-cubed clustering score over items that carry both a predicted and a gold cluster label.
export function bcubed(items) {
  if (!items.length) return { precision: null, recall: null, f1: null, items: 0 };
  let precision = 0;
  let recall = 0;
  for (const item of items) {
    const samePredicted = items.filter((other) => other.predicted === item.predicted);
    const sameGold = items.filter((other) => other.gold === item.gold);
    const both = samePredicted.filter((other) => other.gold === item.gold).length;
    precision += both / samePredicted.length;
    recall += both / sameGold.length;
  }
  precision /= items.length;
  recall /= items.length;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, items: items.length };
}

export function groupMean(rows, key, value) {
  const groups = new Map();
  for (const row of rows) {
    const values = groups.get(row[key]) ?? [];
    const score = value(row);
    if (score !== null && score !== undefined) values.push(score);
    groups.set(row[key], values);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([group, values]) => [group, { n: values.length, mean: mean(values) }]));
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// One provider usage object → cache read, cache write/miss, and output.
// cacheCreationTokens is set only when a miss field and a cache-creation field both exist.
export function tokenBuckets(usage) {
  if (!usage || typeof usage !== "object") return null;
  const hit = finiteNumber(usage.prompt_cache_hit_tokens);
  const detailCached = finiteNumber(usage.prompt_tokens_details?.cached_tokens);
  const anthropicRead = finiteNumber(usage.cache_read_input_tokens);
  const cacheRead = hit ?? detailCached ?? anthropicRead ?? 0;
  const miss = finiteNumber(usage.prompt_cache_miss_tokens);
  const creation = finiteNumber(usage.cache_creation_input_tokens);
  const input = finiteNumber(usage.input_tokens);
  const prompt = finiteNumber(usage.prompt_tokens);
  const output = finiteNumber(usage.completion_tokens) ?? finiteNumber(usage.output_tokens) ?? 0;
  const result = { cacheReadTokens: cacheRead, outputTokens: output };
  if (miss !== null) {
    result.cacheWriteTokens = miss;
    if (creation !== null) result.cacheCreationTokens = creation;
    return result;
  }
  // Anthropic reports cache read and cache creation beside input_tokens, which already excludes both.
  if (creation !== null || anthropicRead !== null) {
    result.cacheWriteTokens = (input ?? 0) + (creation ?? 0);
    return result;
  }
  if (input !== null) {
    result.cacheWriteTokens = input - cacheRead;
    return result;
  }
  if (prompt !== null) {
    result.cacheWriteTokens = prompt - cacheRead;
    return result;
  }
  result.cacheWriteTokens = 0;
  return result;
}

// Label a chat request from prompt version strings. The label is all that is kept.
export function classifyOperation(body) {
  const parts = [];
  const push = (value) => { if (typeof value === "string" && value) parts.push(value); };
  push(body?.system);
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    push(message?.content);
    if (Array.isArray(message?.content)) {
      for (const block of message.content) {
        push(block);
        push(block?.text);
      }
    }
  }
  const text = parts.join("\n");
  const marks = [["extract", text.indexOf("pm-extract-")], ["assign", text.indexOf("pm-assign-")], ["judge", text.indexOf("pm-judge-")]]
    .filter(([, index]) => index >= 0)
    .sort((left, right) => left[1] - right[1]);
  return marks.length ? marks[0][0] : "other";
}

export function resolveModelPrice(model, pricing) {
  if (!model || !pricing?.models) return undefined;
  if (pricing.models[model]) return pricing.models[model];
  const alias = pricing.aliases?.[model];
  return alias ? pricing.models[alias] : undefined;
}

// Weekday peak windows are half-open. Weekends are off-peak. Returns null when the time is missing.
function peakApplies(at, peak) {
  const ms = typeof at === "number" ? at : Date.parse(at ?? "");
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (date.getUTCDay() === 0 || date.getUTCDay() === 6) return false;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const windows = Array.isArray(peak?.utcMinutes) && peak.utcMinutes.length ? peak.utcMinutes : [[60, 240], [360, 600]];
  return windows.some(([start, end]) => minutes >= start && minutes < end);
}

function pricedTokens(usage) {
  const write = finiteNumber(usage?.cacheWriteTokens) ?? finiteNumber(usage?.inputTokens) ?? 0;
  const read = finiteNumber(usage?.cacheReadTokens) ?? finiteNumber(usage?.cachedInputTokens) ?? 0;
  const creation = finiteNumber(usage?.cacheCreationTokens) ?? 0;
  const output = finiteNumber(usage?.outputTokens) ?? 0;
  return { write, read, creation, output };
}

// usage: one call. inputTokens / cacheWriteTokens are uncached or cache-miss; cachedInputTokens /
// cacheReadTokens are cache hits. A peak schedule needs usage.at. tiered=false uses the base (off-peak) rates.
export function costUsd(usage, pricing, { tiered = true } = {}) {
  const price = resolveModelPrice(usage?.model, pricing);
  if (!price) return null;
  let rates = price;
  if (tiered && price.peak) {
    const onPeak = peakApplies(usage?.at, price.peak);
    if (onPeak === null) return null;
    if (onPeak) rates = { ...price, input: price.peak.input, cachedInput: price.peak.cachedInput, output: price.peak.output };
  }
  const tokens = pricedTokens(usage);
  if (tiered && price.longContext && (tokens.write + tokens.read + tokens.creation) > price.longContext.overInputTokens) rates = price.longContext;
  const creationRate = rates.cacheWrite ?? rates.input;
  return (tokens.write * rates.input + tokens.read * rates.cachedInput + tokens.creation * creationRate + tokens.output * rates.output) / 1_000_000;
}

// calls: [{model, at?, inputTokens|cacheWriteTokens, cachedInputTokens|cacheReadTokens, outputTokens}].
// Any call without a price, or a peak-priced call without a timestamp, makes the total null.
export function priceCalls(calls, pricing) {
  const unpriced = [...new Set(calls.filter((call) => !resolveModelPrice(call.model, pricing)).map((call) => call.model ?? "(no model)"))];
  if (unpriced.length) return { costUsd: null, reason: `pricing.json has no price for ${unpriced.join(", ")}` };
  let total = 0;
  const untimed = [];
  for (const call of calls) {
    const cost = costUsd(call, pricing);
    if (cost === null) untimed.push(call.model);
    else total += cost;
  }
  if (untimed.length) return { costUsd: null, reason: `${[...new Set(untimed)].join(", ")} has peak and off-peak rates and a call has no timestamp` };
  return { costUsd: total, reason: null };
}

// Aggregate usage from llm.mjs (judge or reader). Uses perCall when present; otherwise prices the
// totals at the base tier and says so.
export function priceUsage(usage, pricing) {
  if (!usage) return { costUsd: null, reason: "no usage recorded" };
  if (!usage.calls) return { costUsd: 0, reason: null };
  if (!resolveModelPrice(usage.model, pricing)) return { costUsd: null, reason: `pricing.json has no price for ${usage.model ?? "(no model)"}` };
  if (Array.isArray(usage.perCall) && usage.perCall.length === usage.calls) return priceCalls(usage.perCall.map((call) => ({ ...call, model: usage.model })), pricing);
  const peak = resolveModelPrice(usage.model, pricing)?.peak ? " off-peak" : "";
  return { costUsd: costUsd(usage, pricing, { tiered: false }), reason: `priced from totals at the base${peak} tier (no per-call usage recorded)` };
}

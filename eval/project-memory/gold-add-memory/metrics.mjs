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

export function costUsd(usage, pricing) {
  const price = usage?.model ? pricing.models[usage.model] : undefined;
  if (!price) return null;
  const tier = price.longContext && (usage.inputTokens + usage.cachedInputTokens) > price.longContext.overInputTokens ? price.longContext : price;
  return (usage.inputTokens * tier.input + usage.cachedInputTokens * tier.cachedInput + usage.outputTokens * tier.output) / 1_000_000;
}

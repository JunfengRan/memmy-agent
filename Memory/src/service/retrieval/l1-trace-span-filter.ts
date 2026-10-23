import type { MemoryRow,RecallHit } from "../../types.js";
import { isRecord } from "../../utils/json.js";

export const MAX_RECALLED_SPANS_PER_TRACE = 2;

export function filterL1TraceSpanRecallHits(
  hits: readonly RecallHit[],
  memories: readonly MemoryRow[]
): RecallHit[] {
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const recalledSpanSources = new Set<string>();
  for (const hit of hits) {
    if (hit.memoryLayer !== "L1" || hit.kind !== "span") continue;
    for (const sourceTraceId of spanSourceTraceIds(memoryById.get(hit.id))) {
      recalledSpanSources.add(sourceTraceId);
    }
  }
  if (recalledSpanSources.size === 0) return [...hits];

  const keptSpansBySource = new Map<string, number>();
  return hits.filter((hit) => {
    if (hit.memoryLayer !== "L1") return true;
    const memory = memoryById.get(hit.id);
    if (hit.kind === "trace" && recalledSpanSources.has(hit.id)) return false;
    if (hit.kind !== "span") return true;
    const sourceIds = spanSourceTraceIds(memory);
    const sourceTraceId = sourceIds[0];
    if (!sourceTraceId) return true;
    if (spanSegmenter(memory) === "checkpoint") return true;
    const kept = keptSpansBySource.get(sourceTraceId) ?? 0;
    if (kept >= MAX_RECALLED_SPANS_PER_TRACE) return false;
    keptSpansBySource.set(sourceTraceId, kept + 1);
    return true;
  });
}

function spanSourceTraceIds(memory: MemoryRow | undefined): string[] {
  const span = spanRecord(memory);
  const many = span?.source_trace_ids;
  if (Array.isArray(many)) {
    return many.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  const one = spanSourceTraceId(memory);
  return one ? [one] : [];
}

function spanSegmenter(memory: MemoryRow | undefined): string | undefined {
  const segmenter = spanRecord(memory)?.segmenter;
  return typeof segmenter === "string" ? segmenter : undefined;
}

function spanRecord(memory: MemoryRow | undefined): Record<string, unknown> | undefined {
  if (!memory || memory.memoryLayer !== "L1") return undefined;
  return isRecord(memory.properties.internal_info.span) ? memory.properties.internal_info.span : undefined;
}

function spanSourceTraceId(memory: MemoryRow | undefined): string | undefined {
  if (!memory || memory.memoryLayer !== "L1") return undefined;
  const span = isRecord(memory.properties.internal_info.span)
    ? memory.properties.internal_info.span
    : undefined;
  const sourceTraceId = span?.source_trace_id ?? memory.info.source_trace_id;
  return typeof sourceTraceId === "string" && sourceTraceId.trim()
    ? sourceTraceId.trim()
    : undefined;
}

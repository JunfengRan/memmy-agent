import { ProjectMemoryError } from "../../contract/errors.js";
import { PROJECT_MEMORY_LIMITS } from "../../contract/limits.js";
import type { DecisionOp, DecisionTarget, ExperienceOp } from "../../contract/types.js";
import { charLength, normalizeForCompare } from "../../text.js";
import { isBefore } from "../../time.js";

/**
 * Mechanical application of ChangeSet entry ops (v3 §2.2.10: the store follows
 * `op` and never re-judges content). History rows are only ever appended.
 */
export interface MutableItem {
  content: string;
  time: string;
  userIds: string[];
}

export interface MutableDecision extends MutableItem {
  id: string;
  conflicts: Array<MutableItem & { seq: number }>;
  newHistory: Array<MutableItem & { reason: string | null }>;
  isNew: boolean;
}

export interface MutableExperience extends MutableItem {
  id: string;
  newHistory: Array<MutableItem & { reason: string | null }>;
  isNew: boolean;
}

function violation(message: string): ProjectMemoryError {
  return new ProjectMemoryError("STRUCTURE_VIOLATION", message);
}

function union(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])];
}

function without(values: readonly string[], removed: readonly string[]): string[] {
  const drop = new Set(removed);
  return values.filter((value) => !drop.has(value));
}

function conflictSeq(target: DecisionTarget | "new"): number | undefined {
  if (!target.startsWith("conflict:")) return undefined;
  const seq = Number(target.slice("conflict:".length));
  return Number.isSafeInteger(seq) && seq >= 1 ? seq : undefined;
}

function requireConflict(decision: MutableDecision, target: DecisionTarget | "new"): MutableItem & { seq: number } {
  const seq = conflictSeq(target);
  const item = seq === undefined ? undefined : decision.conflicts.find((conflict) => conflict.seq === seq);
  if (!item) throw violation(`decision ${decision.id} has no ${target}`);
  return item;
}

/** One member belongs to exactly one conclusion of a decision (v3 §2.2.9 invariant 1). */
function moveMembers(decision: MutableDecision, userIds: readonly string[], keep: MutableItem): void {
  if (keep !== decision) decision.userIds = without(decision.userIds, userIds);
  for (const conflict of decision.conflicts) {
    if (conflict !== keep) conflict.userIds = without(conflict.userIds, userIds);
  }
}

/** Identical conclusions are merged and their members united. */
function mergeIdenticalConflicts(decision: MutableDecision): void {
  const seen: Array<MutableItem> = [decision];
  const kept: MutableDecision["conflicts"] = [];
  for (const conflict of decision.conflicts) {
    const same = seen.find((item) => normalizeForCompare(item.content) === normalizeForCompare(conflict.content));
    if (same) {
      same.userIds = union(same.userIds, conflict.userIds);
      continue;
    }
    seen.push(conflict);
    kept.push(conflict);
  }
  decision.conflicts = kept;
}

export interface ApplyDecisionOptions {
  /** True when this id is already stored or staged in the same ChangeSet. */
  idExists?: (decisionId: string) => boolean;
}

function archivedConclusions(decision: MutableDecision, reason: string): MutableDecision["newHistory"] {
  return [decision, ...decision.conflicts].map((item) => ({
    content: item.content,
    time: item.time,
    userIds: [...item.userIds],
    reason
  }));
}

function applySplit(
  decision: MutableDecision | undefined,
  op: Extract<DecisionOp, { op: "split" }>,
  idExists?: (decisionId: string) => boolean
): MutableDecision[] {
  if (!decision) throw violation(`decision ${op.decisionId} does not exist`);
  if (decision.conflicts.length === 0) throw violation(`decision ${decision.id} has no conflicts to split`);
  if (op.splitInto.length < 2) throw violation(`split of ${decision.id} needs at least two pieces`);
  const keptCount = op.splitInto.filter((piece) => piece.decisionId === op.decisionId).length;
  if (keptCount !== 1) throw violation(`split of ${decision.id} must keep its id exactly once`);
  const seen = new Set<string>();
  for (const piece of op.splitInto) {
    if (seen.has(piece.decisionId)) throw violation(`split piece ${piece.decisionId} is duplicated`);
    seen.add(piece.decisionId);
    const length = charLength(piece.content);
    if (length === 0 || length > PROJECT_MEMORY_LIMITS.decision) {
      throw violation(`split piece content must be 1..${PROJECT_MEMORY_LIMITS.decision} characters`);
    }
    if (piece.decisionId !== op.decisionId && idExists?.(piece.decisionId)) {
      throw violation(`decision ${piece.decisionId} already exists`);
    }
  }
  const archived = archivedConclusions(decision, op.reason);
  const copyHistory = (): MutableDecision["newHistory"] => archived.map((item) => ({ ...item, userIds: [...item.userIds] }));
  return op.splitInto.map((piece) => {
    if (piece.decisionId === decision.id) {
      decision.content = piece.content;
      decision.time = piece.time;
      decision.userIds = [...piece.userIds];
      decision.conflicts = [];
      decision.newHistory.push(...copyHistory());
      return decision;
    }
    return {
      id: piece.decisionId,
      content: piece.content,
      time: piece.time,
      userIds: [...piece.userIds],
      conflicts: [],
      newHistory: copyHistory(),
      isNew: true
    };
  });
}

/** Applies one op. `split` returns the kept row plus every new decision. */
export function applyDecisionEntries(
  decision: MutableDecision | undefined,
  op: DecisionOp,
  options: ApplyDecisionOptions = {}
): MutableDecision[] {
  if (op.op === "split") return applySplit(decision, op, options.idExists);
  return [applyDecisionOp(decision, op)];
}

export function applyDecisionOp(
  decision: MutableDecision | undefined,
  op: Exclude<DecisionOp, { op: "split" }>
): MutableDecision {
  if (op.op === "add") {
    if (decision) throw violation(`decision ${op.decisionId} already exists`);
    return {
      id: op.decisionId,
      content: op.content,
      time: op.time,
      userIds: [...op.userIds],
      conflicts: [],
      newHistory: [],
      isNew: true
    };
  }
  if (!decision) throw violation(`decision ${op.decisionId} does not exist`);
  switch (op.op) {
    case "join": {
      const target = op.target === "content" ? decision : requireConflict(decision, op.target);
      target.userIds = union(target.userIds, op.userIds);
      moveMembers(decision, op.userIds, target);
      return decision;
    }
    case "rewrite": {
      decision.newHistory.push({ content: decision.content, time: decision.time, userIds: decision.userIds, reason: op.reason ?? null });
      decision.content = op.content;
      decision.time = op.time;
      decision.userIds = [...op.userIds];
      moveMembers(decision, op.userIds, decision);
      mergeIdenticalConflicts(decision);
      return decision;
    }
    case "conflict_append": {
      const seq = decision.conflicts.reduce((max, conflict) => Math.max(max, conflict.seq), 0) + 1;
      const item = { seq, content: op.content, time: op.time, userIds: [...op.userIds] };
      decision.conflicts.push(item);
      moveMembers(decision, op.userIds, item);
      mergeIdenticalConflicts(decision);
      return decision;
    }
    case "conflict_update": {
      const item = requireConflict(decision, op.target);
      item.content = op.content;
      item.time = op.time;
      item.userIds = union(item.userIds, op.userIds);
      moveMembers(decision, op.userIds, item);
      mergeIdenticalConflicts(decision);
      return decision;
    }
    case "resolve": {
      if (decision.conflicts.length === 0) throw violation(`decision ${decision.id} has no conflicts to resolve`);
      let selected: MutableItem;
      if (op.target === "new") {
        if (!op.content || !op.time) throw violation("resolve with a new conclusion needs content and time");
        selected = { content: op.content, time: op.time, userIds: [...(op.userIds ?? [])] };
      } else {
        selected = op.target === "content" ? decision : requireConflict(decision, op.target);
      }
      const retired: MutableItem[] = [decision, ...decision.conflicts].filter((item) => item !== selected);
      for (const item of retired) {
        decision.newHistory.push({ content: item.content, time: item.time, userIds: item.userIds, reason: op.reason });
      }
      decision.content = selected.content;
      decision.time = selected.time;
      decision.userIds = [...selected.userIds];
      decision.conflicts = [];
      return decision;
    }
  }
}

export function applyExperienceOp(experience: MutableExperience | undefined, op: ExperienceOp): MutableExperience {
  if (op.op === "add") {
    if (experience) throw violation(`experience ${op.experienceId} already exists`);
    return { id: op.experienceId, content: op.content, time: op.time, userIds: [...op.userIds], newHistory: [], isNew: true };
  }
  if (!experience) throw violation(`experience ${op.experienceId} does not exist`);
  switch (op.op) {
    case "join":
      experience.time = isBefore(experience.time, op.time) ? op.time : experience.time;
      experience.userIds = union(experience.userIds, op.userIds);
      return experience;
    case "update":
      experience.newHistory.push({ content: experience.content, time: experience.time, userIds: experience.userIds, reason: op.reason ?? null });
      experience.content = op.content;
      experience.time = op.time;
      experience.userIds = [...op.userIds];
      return experience;
    case "history_backfill":
      experience.newHistory.push({ content: op.content, time: op.time, userIds: [...op.userIds], reason: null });
      return experience;
  }
}

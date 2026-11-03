import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const labeled = /决定|主张|决策|\bD\d|\bT\d/;
const kinds = new Set(["plain", "stale", "overridden", "cross-project", "scope-leak"]);
const meta = /噪声|第\s*\d+\s*次|重复一遍|旁注/;

export function evalRoot() {
  return root;
}

export function loadEvalSet(dir = join(root, "dataset")) {
  return {
    corpus: readJson(join(dir, "corpus.json")),
    decisions: readJson(join(dir, "decisions.json")),
    relay: readJson(join(dir, "relay.json")),
    conflicts: readJson(join(dir, "conflicts.json")),
    scheme: readJson(join(dir, "scheme.json")),
    scoring: readJson(join(dir, "scoring.json")),
    todolists: readJson(join(dir, "todolists.json"))
  };
}

export function scoreAnswer(answer, question) {
  const text = String(answer ?? "");
  const hit = question.mustInclude.every((phrase) => text.includes(phrase));
  const trap = question.mustNotInclude.some((phrase) => text.includes(phrase));
  return hit && !trap;
}

export function longestSlice(question, text) {
  const haystack = String(text ?? "");
  let best = 0;
  for (let size = question.length; size >= 2; size -= 1) {
    for (let index = 0; index + size <= question.length; index += 1) {
      const slice = question.slice(index, index + size);
      if (slice.trim().length < 2 || /^\s+$/.test(slice)) continue;
      if (haystack.includes(slice)) return size;
    }
  }
  return best;
}

export function unscopedPicks(question, traces) {
  let best = [];
  let bestLen = -1;
  for (const trace of traces) {
    const len = longestSlice(question.question, trace.answer);
    if (len > bestLen) {
      best = [trace];
      bestLen = len;
    } else if (len === bestLen) {
      best.push(trace);
    }
  }
  return best;
}

export function validateEvalSet(set) {
  const errors = [];
  const projects = new Map(set.corpus.projects.map((project) => [project.id, project]));
  const sessions = new Map(set.corpus.sessions.map((session) => [session.id, session]));
  const traces = new Map(set.corpus.traces.map((trace) => [trace.id, trace]));
  const decisions = new Map(set.decisions.decisions.map((decision) => [decision.id, decision]));
  const traceCounts = new Map();
  for (const trace of set.corpus.traces) {
    traceCounts.set(trace.sessionId, (traceCounts.get(trace.sessionId) ?? 0) + 1);
  }

  if (set.corpus.projects.length !== 2) errors.push("need two projects");
  if ([...projects.keys()].some((id) => id === "memmy-agent" || id === "MemOS")) errors.push("eval projects must leave the product repos");
  const ledger = set.corpus.projects.find((project) => project.name === "ledger");
  const catalog = set.corpus.projects.find((project) => project.name === "catalog");
  if (!ledger || !catalog || ledger.id === catalog.id) errors.push("ledger and catalog must be different projects");
  for (const project of set.corpus.projects) {
    const dir = join(root, project.root);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) errors.push(`${project.id} workspace missing`);
    if (!existsSync(join(dir, "src"))) errors.push(`${project.id} has no source files`);
  }

  if (set.decisions.decisions.length < 6) errors.push("need at least 6 decisions");
  const projectIds = new Set(set.decisions.decisions.map((decision) => decision.projectId));
  if (!projectIds.has(ledger?.id) || !projectIds.has(catalog?.id)) errors.push("decisions must cover both projects");
  const rewritten = set.decisions.decisions.filter((decision) => decision.changedAt && decision.textBefore && decision.textBefore !== decision.textAfter);
  if (!rewritten.some((decision) => decision.projectId === ledger?.id)) errors.push("ledger needs a rewritten decision");
  for (const decision of set.decisions.decisions) {
    if (decision.extractor !== "model") errors.push(`${decision.id} decision extractor must be model`);
    if (labeled.test(`${decision.textBefore ?? ""}\n${decision.textAfter}`)) errors.push(`${decision.id} decision text is labeled`);
    for (const traceId of decision.sourceTraceIds) {
      if (!traces.has(traceId)) errors.push(`${decision.id} source ${traceId} missing`);
    }
  }

  for (const trace of set.corpus.traces) {
    if (!sessions.has(trace.sessionId)) errors.push(`${trace.id} session missing`);
    if (trace.memoryScope === "project" && !projects.has(trace.projectId)) errors.push(`${trace.id} project missing`);
    if (trace.memoryScope === "global" && trace.projectId !== null) errors.push(`${trace.id} global trace has a project`);
    if (labeled.test(trace.answer)) errors.push(`${trace.id} answer is labeled`);
    if (meta.test(`${trace.query}${trace.answer}`)) errors.push(`${trace.id} text announces itself as noise`);
    if (trace.toolCalls || trace.captureMode || Object.hasOwn(trace, "toolCallStart")) errors.push(`${trace.id} has a prebuilt checkpoint`);
    if (trace.needsTodolist) {
      if (!Array.isArray(trace.mergedFrom) || trace.mergedFrom.length < 2) errors.push(`${trace.id} merged query missing`);
    } else if (trace.mergedFrom !== null) {
      errors.push(`${trace.id} single-step query should not be merged`);
    }
    const session = sessions.get(trace.sessionId);
    if (session?.canSee?.length) errors.push(`${trace.sessionId} can see another session`);
  }

  const rootTrace = set.corpus.traces.find((trace) => trace.workspacePath === ledger?.root);
  const subdirTrace = set.corpus.traces.find((trace) => trace.workspacePath === `${ledger?.root}/src`);
  if (!rootTrace || !subdirTrace || rootTrace.projectId !== subdirTrace.projectId || subdirTrace.gitRoot !== ledger?.root) {
    errors.push("src session must stay on the ledger git root");
  }

  if (set.relay.questions.length !== 30) errors.push(`relay questions must be 30, got ${set.relay.questions.length}`);
  if (set.scoring.noProjectMemoryExpectedScore !== 0) errors.push("baseline score must be 0");
  const ruleFields = new Set(["projectRoot", "memoryScope", "checkpointBoundary", "checkpointSummary"]);
  const modelFields = new Set(["todolist", "decision", "rephrase", "topicAssign", "conflictReal"]);
  for (const row of set.scheme.extractors) {
    const expected = ruleFields.has(row.field) ? "rule" : modelFields.has(row.field) ? "model" : "";
    if (!expected || row.extractor !== expected) errors.push(`${row.field} extractor mismatch`);
  }

  for (const question of set.relay.questions) {
    const session = sessions.get(question.sessionId);
    if (!session || (traceCounts.get(question.sessionId) ?? 0) !== 0) errors.push(`${question.id} asking session is not empty`);
    if (session?.projectId !== question.projectId) errors.push(`${question.id} session project mismatch`);
    if (labeled.test(question.goldAnswer)) errors.push(`${question.id} gold is labeled`);
    if (!kinds.has(question.kind)) errors.push(`${question.id} kind missing`);
    if (!question.mustInclude?.length) errors.push(`${question.id} rubric missing`);
    if (question.kind !== "plain" && (!question.mustNotInclude?.length || !question.trapEvidenceIds?.length)) {
      errors.push(`${question.id} ${question.kind} question needs a trap`);
    }
    if (question.kind === "plain" && (question.mustNotInclude?.length || question.trapEvidenceIds?.length)) {
      errors.push(`${question.id} plain question should not carry a trap`);
    }
    for (const trace of set.corpus.traces) {
      for (const sentence of trace.answer.split(/[。！？]/).map((part) => part.trim()).filter((part) => part.length >= 8)) {
        if (question.question.includes(sentence)) errors.push(`${question.id} question copies a reply from ${trace.id}`);
      }
    }
    const evidence = textsFor(question.evidenceIds, traces, errors, question.id);
    const traps = textsFor(question.trapEvidenceIds, traces, errors, question.id);
    const evidenceText = evidence.join("\n");
    const trapText = traps.join("\n");
    for (const phrase of question.mustInclude ?? []) {
      if (!evidenceText.includes(phrase)) errors.push(`${question.id} gold phrase missing from evidence`);
      if (trapText.includes(phrase)) errors.push(`${question.id} gold phrase also in trap`);
      if (!question.goldAnswer.includes(phrase)) errors.push(`${question.id} gold answer misses ${phrase}`);
    }
    for (const phrase of question.mustNotInclude ?? []) {
      if (evidenceText.includes(phrase)) errors.push(`${question.id} trap phrase is in the current evidence`);
      if (!trapText.includes(phrase)) errors.push(`${question.id} trap phrase missing from trap`);
      if (question.goldAnswer.includes(phrase)) errors.push(`${question.id} gold answer hits the trap`);
    }
    const asked = Date.parse(question.askedAt);
    const newestEvidence = Math.max(...(question.evidenceIds ?? []).map((id) => Date.parse(traces.get(id)?.at ?? "")));
    for (const traceId of question.trapEvidenceIds ?? []) {
      const trap = traces.get(traceId);
      if (!trap) continue;
      if (question.kind === "stale" && (trap.projectId !== question.projectId || Date.parse(trap.at) >= newestEvidence)) {
        errors.push(`${question.id} stale trap ${traceId} must be an older reply in the same project`);
      }
      if (question.kind === "overridden" && (trap.projectId !== question.projectId || trap.level !== "write")) {
        errors.push(`${question.id} overridden trap ${traceId} must be a write-level reply in the same project`);
      }
      if (question.kind === "cross-project" && (trap.projectId === question.projectId || !trap.projectId)) {
        errors.push(`${question.id} cross-project trap ${traceId} must belong to the other project`);
      }
      if (question.kind === "scope-leak" && (question.projectId !== null || !trap.projectId)) {
        errors.push(`${question.id} scope-leak trap ${traceId} must be project memory asked from a window with no project`);
      }
    }
    if (!Number.isFinite(newestEvidence) || newestEvidence >= asked) errors.push(`${question.id} evidence is not older than the question`);
    // Any same-project reply that lands between the evidence and the question must not contradict it.
    for (const later of set.corpus.traces) {
      const at = Date.parse(later.at);
      if (at > newestEvidence && at < asked && later.projectId === question.projectId && (later.supersedes ?? []).some((id) => question.evidenceIds.includes(id))) {
        errors.push(`${question.id} evidence is superseded by ${later.id}`);
      }
    }
    for (const traceId of [...(question.evidenceIds ?? []), ...(question.trapEvidenceIds ?? [])]) {
      const trace = traces.get(traceId);
      if (!trace) continue;
      if (Date.parse(trace.at) >= Date.parse(question.askedAt)) errors.push(`${question.id} uses ${traceId} from the future`);
      if (question.evidenceIds.includes(traceId) && trace.projectId && trace.projectId !== question.projectId) {
        errors.push(`${question.id} evidence ${traceId} is another project`);
      }
    }
    if (scoreAnswer("", question) || !scoreAnswer(question.goldAnswer, question)) errors.push(`${question.id} score rubric broken`);
    const askFile = sessionFile(session, projects);
    if (askFile && existsSync(askFile)) {
      const body = readFileSync(askFile, "utf8");
      for (const phrase of [...(question.mustInclude ?? []), ...(question.mustNotInclude ?? [])]) {
        if (body.includes(phrase)) errors.push(`${question.id} asking session file contains ${phrase}`);
      }
    }
  }

  const pairs = new Map();
  for (const question of set.relay.questions) {
    if (!question.rephrasePairId) continue;
    const group = pairs.get(question.rephrasePairId) ?? [];
    group.push(question);
    pairs.set(question.rephrasePairId, group);
  }
  if (pairs.size === 0) errors.push("missing a rephrase pair");
  for (const [pairId, group] of pairs) {
    if (new Set(group.map((question) => question.goldAnswer)).size < 2) errors.push(`${pairId} gold answers do not change`);
    const decision = decisions.get(group[0]?.decisionId ?? "");
    if (!decision?.changedAt) {
      errors.push(`${pairId} missing decision`);
      continue;
    }
    const times = group.map((question) => Date.parse(question.askedAt));
    const changedAt = Date.parse(decision.changedAt);
    if (Math.min(...times) >= changedAt || Math.max(...times) <= changedAt) errors.push(`${pairId} does not straddle the rewrite`);
    if (decision.textBefore === decision.textAfter) errors.push(`${pairId} decision text does not change`);
  }

  if (!set.relay.questions.some((question) => question.trapEvidenceIds?.some((id) => traces.get(id)?.projectId === catalog?.id))) {
    errors.push("catalog needs a near-synonym trap");
  }

  if (set.conflicts.conflicts.length !== 10) errors.push("conflicts must be 10");
  const same = set.conflicts.conflicts.filter((conflict) => conflict.levelRelation === "same");
  const different = set.conflicts.conflicts.filter((conflict) => conflict.levelRelation === "different");
  if (same.length !== 5 || different.length !== 5) errors.push("conflicts must be 5 same and 5 different");
  for (const conflict of set.conflicts.conflicts) {
    if (!conflict.systemUpdateMustContain || !conflict.winner) errors.push(`${conflict.id} missing resolution`);
    for (const side of [conflict.sideA, conflict.sideB]) {
      const evidence = textsFor(side.evidenceIds, traces, errors, conflict.id).join("\n");
      if (!evidence.includes(side.claim)) errors.push(`${conflict.id} claim is not in evidence`);
      for (const traceId of side.evidenceIds) {
        const trace = traces.get(traceId);
        const level = trace?.level ?? "write";
        if (level !== side.level) errors.push(`${conflict.id} level does not match ${traceId}`);
      }
    }
    const sameLevel = conflict.sideA.level === conflict.sideB.level;
    if (conflict.levelRelation === "same" && (!sameLevel || conflict.expectOpen !== true)) errors.push(`${conflict.id} same level must stay open`);
    if (conflict.levelRelation === "different" && (sameLevel || conflict.expectOpen !== false)) errors.push(`${conflict.id} different level must resolve`);
  }

  if (set.todolists.todolistStatus === "generated") {
    const byId = new Map((set.todolists.items ?? []).map((item) => [item.traceId, item]));
    for (const trace of set.corpus.traces.filter((item) => item.needsTodolist)) {
      const item = byId.get(trace.id);
      if (!item || !Array.isArray(item.todos) || item.todos.length < 2) errors.push(`${trace.id} todolist missing`);
      if (JSON.stringify(item).includes("toolCallStart")) errors.push(`${trace.id} todolist invented a checkpoint range`);
    }
  } else if (set.todolists.todolistStatus !== "ungenerated") {
    errors.push("todolist status missing");
  } else if ((set.todolists.items ?? []).length > 0) {
    errors.push("ungenerated todolist still has items");
  }
  if (JSON.stringify(set.todolists).includes("toolCallStart")) errors.push("checkpoint range was written by hand");

  for (const session of set.corpus.sessions) {
    if (session.projectId === null) continue;
    const file = sessionFile(session, projects);
    if (!file || !existsSync(file)) {
      errors.push(`${session.id} session file missing`);
    } else if (readFileSync(file, "utf8") !== renderSession(session, set.corpus.traces)) {
      errors.push(`${session.id} session file differs from corpus; run build-sessions.mjs`);
    }
  }

  return errors;
}

function textsFor(ids, traces, errors, label) {
  return (ids ?? []).map((id) => {
    const trace = traces.get(id);
    if (!trace) {
      errors.push(`${label} evidence ${id} missing`);
      return "";
    }
    return `${trace.query}\n${trace.answer}`;
  });
}

export function renderSession(session, traces) {
  const own = traces.filter((trace) => trace.sessionId === session.id).sort((left, right) => left.at.localeCompare(right.at));
  if (own.length === 0) return `# ${session.id}\n\n这个窗口还没有消息。\n`;
  const blocks = own.map((trace) => `## ${trace.at}\n\n用户：${trace.query}\n\n回复：${trace.answer}\n`);
  return `# ${session.id}\n\n${blocks.join("\n")}`;
}

export function sessionFile(session, projects) {
  if (!session?.projectId) return null;
  const project = projects.get(session.projectId);
  if (!project) return null;
  return join(root, project.root, "sessions", `${session.id}.md`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const set = loadEvalSet();
  const errors = validateEvalSet(set);
  const amount = set.relay.questions.filter((question) => question.rephrasePairId === "amount-column");
  const rubricSound = set.relay.questions.every((question) => scoreAnswer("", question) === false && scoreAnswer(question.goldAnswer, question) === true);
  process.stdout.write(`${JSON.stringify({
    errors,
    questions: set.relay.questions.length,
    amountPairGold: new Set(amount.map((question) => question.goldAnswer)).size,
    rubricSound
  })}\n`);
  process.exit(errors.length === 0 && rubricSound ? 0 : 1);
}

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dataset = join(root, "dataset");
const read = (name) => JSON.parse(readFileSync(join(dataset, name), "utf8"));
const corpus = read("corpus.json");
const decisions = read("decisions.json").decisions;
const relay = read("relay.json").questions;
const conflicts = read("conflicts.json").conflicts;
const traces = new Map(corpus.traces.map((trace) => [trace.id, trace]));

// This is a deterministic mock of add_message extraction. The text and source ids are
// copied from the alpha gold; only the field assignment is reviewed against standard §2.2.5.
const review = {
  source: "eval/project-memory/dataset copied from dev-project-memory-alpha",
  method: "mock-add-message-extraction",
  reviewedAt: "2026-11-03",
  standard: [
    "decision 只保留范围、对外约定或共同约定",
    "experience 记录可复用做法或已证实不可行的做法",
    "evolution 只记录产出状态变化，不记录开始做某事或局部步骤"
  ],
  findings: [
    { id: "d_copy", original: "decision", reviewed: "experience", reason: "不把 catalog export 搬进 ledger 是局部实现取舍，不是范围、对外约定或共同约定。" },
    { id: "d_price", original: "decision", reviewed: "experience", reason: "price 表增加 amount 列是局部实现方案，不能作为项目决策金标。" },
    { id: "d_export", original: "decision", reviewed: "experience", reason: "先创建 output 目录再写文件是执行步骤，按 standard 不进入决策字段。" },
    { id: "d_csv", original: "decision", reviewed: "experience", reason: "选择 prices.csv 是局部实现细节；保留为经验/当前做法供检索题使用。" }
  ],
  acceptedDecisionIds: decisions.map((d) => d.id).filter((id) => !new Set(["d_copy", "d_price", "d_export", "d_csv"]).has(id)),
  // Facts that relay questions ask about but the alpha decisions never extracted. Text is the
  // trace answer verbatim; superseded (t_verbose, t_copy, t_sample) and overridden low-level
  // traces (t_write_*) are not current state and stay out of gold.
  addedEntries: [
    { traceId: "t_admin_bug", kind: "experience", goldTopic: "ledger-empty-customer", reason: "已证实补样例不能修复，问题在读取代码，是可复用的排查结论。" },
    { traceId: "t_ledger_tz", kind: "experience", goldTopic: "ledger-report-calculation", reason: "report.ts 切月规则是局部实现。" },
    { traceId: "t_ledger_round", kind: "experience", goldTopic: "ledger-report-calculation", reason: "金额累加精度是局部实现。" },
    { traceId: "t_ledger_dup", kind: "experience", goldTopic: "ledger-report-calculation", reason: "去重规则是局部实现。" },
    { traceId: "t_ledger_loc", kind: "experience", goldTopic: "ledger-report-output", reason: "输出目录与文件名是局部实现，与 d_export 的复核口径一致。" },
    { traceId: "t_cat_round", kind: "experience", goldTopic: "catalog-price-data", reason: "价格取整是局部实现。" },
    { traceId: "t_cat_tz", kind: "experience", goldTopic: "catalog-price-data", reason: "生效日切换规则是局部实现。" },
    { traceId: "t_cat_sku", kind: "experience", goldTopic: "catalog-price-data", reason: "sku 归一化是局部实现。" },
    { traceId: "t_cat_dup", kind: "experience", goldTopic: "catalog-price-data", reason: "重复 sku 取舍是局部实现。" },
    { traceId: "t_short", kind: "decision", goldTopic: "collab-communication", reason: "回复格式是用户与 agent 的共同约定，取代 t_verbose。" },
    { traceId: "t_admin_todo", kind: "decision", goldTopic: "collab-communication", reason: "admin 的协作约定，压过 t_write_split。" },
    { traceId: "t_admin_claim", kind: "decision", goldTopic: "collab-repo-safety", reason: "admin 的冲突判定口径是共同约定，压过 t_write_edit。" }
  ],
  // goldTopic groups entries by work object (module, output or rule area), not by single fact.
  // Topic induction is scored with label-free clustering, so these names never need to match
  // model topic ids.
  topicGroups: {
    "ledger-report-calculation": "月报怎么算：金额来源、精度、切月时区、分录去重",
    "ledger-empty-customer": "空客户行的处理规则与测试失败根因",
    "ledger-report-output": "月报输出：写到哪里，以及是否搬用 catalog export",
    "catalog-price-data": "价格数据口径：amount 列、取整、生效日时区、sku 归一与重复取舍",
    "catalog-price-export": "价格表导出：目录与文件格式",
    "collab-repo-safety": "仓库操作约定：连接串与 .env、分支、冲突判定",
    "collab-communication": "沟通约定：回复格式、无清单时是否拆段、跨窗口通知"
  }
};

const decisionTopic = {
  d_amount: "ledger-report-calculation",
  d_empty: "ledger-empty-customer",
  d_copy: "ledger-report-output",
  d_env: "collab-repo-safety",
  d_branch: "collab-repo-safety",
  d_notify: "collab-communication",
  d_price: "catalog-price-data",
  d_export: "catalog-price-export",
  d_csv: "catalog-price-export"
};
const latestTraceAt = (ids) => ids.map((id) => traces.get(id).at).sort().at(-1);

const findingById = new Map(review.findings.map((finding) => [finding.id, finding]));
const entries = [];
for (const decision of decisions) {
  const finding = findingById.get(decision.id);
  const kind = finding ? "experience" : "decision";
  entries.push({
    id: `${kind}_${decision.id}`,
    kind,
    projectId: decision.projectId,
    goldTopic: decisionTopic[decision.id],
    text: decision.textAfter,
    reason: decision.reason,
    sourceTraceIds: decision.sourceTraceIds,
    asOf: latestTraceAt(decision.sourceTraceIds),
    changedAt: decision.changedAt,
    relation: decision.relation,
    source: "copied-alpha-gold-reviewed"
  });
}

for (const added of review.addedEntries) {
  const trace = traces.get(added.traceId);
  entries.push({
    id: `${added.kind}_${added.traceId}`,
    kind: added.kind,
    projectId: trace.projectId,
    goldTopic: added.goldTopic,
    text: trace.answer,
    reason: added.reason,
    sourceTraceIds: [added.traceId],
    asOf: trace.at,
    source: "copied-alpha-corpus-reviewed"
  });
}

// Evolution is restricted to output status changes represented by supersedes or explicit
// completed/reverted/fixed outcomes in the copied corpus. Query/answer text is never rewritten.
const evolutionTopic = {
  t_column: "ledger-report-calculation",
  t_wait: "ledger-report-output",
  t_csv: "catalog-price-export",
  t_bug: "ledger-empty-customer",
  t_env: "collab-repo-safety",
  t_tell: "collab-communication",
  t_dryrun: "ledger-report-output"
};
for (const [id, goldTopic] of Object.entries(evolutionTopic)) {
  const trace = traces.get(id);
  entries.push({
    id: `evolution_${id}`,
    kind: "evolution",
    projectId: trace.projectId,
    goldTopic,
    text: trace.answer,
    sourceTraceIds: [id],
    asOf: trace.at,
    at: trace.at,
    supersedes: trace.supersedes ?? [],
    source: "copied-alpha-corpus"
  });
}
// Earlier or overridden statements of each gold fact. The judge uses them to tell a stale
// model entry apart from an unrelated one; they never count as correct.
const staleByWinner = new Map();
const addStale = (winner, loser) => staleByWinner.set(winner, new Set([...(staleByWinner.get(winner) ?? []), loser]));
for (const trace of corpus.traces) for (const id of trace.supersedes ?? []) addStale(trace.id, id);
for (const conflict of conflicts) {
  const [winner, loser] = conflict.winner === "a" ? [conflict.sideA, conflict.sideB] : [conflict.sideB, conflict.sideA];
  for (const w of winner.evidenceIds) for (const l of loser.evidenceIds) addStale(w, l);
}
const textBeforeById = new Map(decisions.map((decision) => [decision.id, decision.textBefore]));
for (const entry of entries) {
  if (!review.topicGroups[entry.goldTopic]) throw new Error(`${entry.id} has unknown goldTopic ${entry.goldTopic}`);
  const staleIds = entry.sourceTraceIds.flatMap((id) => [...(staleByWinner.get(id) ?? [])]);
  const before = textBeforeById.get(entry.id.replace(/^(decision|experience)_/, ""));
  entry.staleTexts = [...new Set([...(before ? [before] : []), ...staleIds.map((id) => traces.get(id).answer)])];
}

const timelineSpecs = [
  {
    id: "ledger-amount",
    title: "ledger 月报金额来源",
    projectId: "proj_ledger",
    traceIds: ["t_journal", "t_report", "t_column", "t_ledger_round", "t_ledger_tz", "t_ledger_loc", "t_ledger_dup"],
    questionIds: ["q01", "q02", "q05", "q20", "q25", "q22", "q26", "q28", "q29"]
  },
  {
    id: "ledger-empty-customer",
    title: "ledger 空客户行处理",
    projectId: "proj_ledger",
    traceIds: ["t_report", "t_sample", "t_admin_bug", "t_bug"],
    questionIds: ["q03", "q04", "q15", "q16", "q17"]
  },
  {
    id: "catalog-export",
    title: "catalog 价格导出",
    projectId: "proj_catalog",
    traceIds: ["t_price", "t_export", "t_cat_sku", "t_cat_round", "t_cat_tz", "t_cat_dup", "t_csv"],
    questionIds: ["q06", "q07", "q08", "q21", "q23", "q24", "q27", "q30"]
  },
  {
    id: "cross-project-copy",
    title: "catalog 导出方案是否进入 ledger",
    projectId: "proj_ledger",
    traceIds: ["t_copy", "t_wait", "t_dryrun"],
    questionIds: ["q09"]
  },
  {
    id: "cross-session-policy",
    title: "协作与安全策略",
    projectId: "proj_ledger",
    traceIds: ["t_verbose", "t_short", "t_write_split", "t_admin_todo", "t_write_secret", "t_admin_env", "t_write_edit", "t_admin_claim", "t_write_main", "t_admin_branch", "t_env", "t_silent", "t_tell"],
    questionIds: ["q10", "q11", "q12", "q13", "q14", "q18", "q19"]
  }
];

const output = {
  schemaVersion: 1,
  generatedAt: "2026-11-02T00:00:00.000Z",
  provenance: {
    sourceBranch: "dev-project-memory-alpha",
    sourcePath: "eval/project-memory/dataset",
    copiedBeforeReview: true,
    extraction: "mock add_message; no live add_message call",
    sourceIntegrity: "all answer text and evidence ids are copied; no question answer was manually regenerated"
  },
  review,
  entries,
  timelines: timelineSpecs.map((timeline) => ({
    ...timeline,
    events: timeline.traceIds.map((id) => {
      const trace = traces.get(id);
      return { traceId: id, at: trace.at, query: trace.query, answer: trace.answer, supersedes: trace.supersedes ?? [] };
    }).sort((left, right) => left.at.localeCompare(right.at)),
    questions: timeline.questionIds.map((id) => relay.find((question) => question.id === id)).filter(Boolean).map((question) => ({
      id: question.id,
      kind: question.kind,
      askedAt: question.askedAt,
      sessionId: question.sessionId,
      projectId: question.projectId,
      question: question.question,
      asksAbout: question.evidenceIds,
      trapEvidenceIds: question.trapEvidenceIds ?? [],
      mustInclude: question.mustInclude,
      mustNotInclude: question.mustNotInclude ?? [],
      goldAnswer: question.goldAnswer
    }))
  }))
};

mkdirSync(join(root, "generated"), { recursive: true });
writeFileSync(join(root, "generated/extracted-gold.json"), `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(join(root, "generated/review.json"), `${JSON.stringify(review, null, 2)}\n`);
console.log(JSON.stringify({ entries: entries.length, decisions: review.acceptedDecisionIds.length, reclassified: review.findings.length, added: review.addedEntries.length, topics: Object.keys(review.topicGroups).length, timelines: timelineSpecs.length, questions: relay.length }));

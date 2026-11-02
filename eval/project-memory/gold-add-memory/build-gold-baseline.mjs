import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dataset = join(root, "dataset");
const read = (name) => JSON.parse(readFileSync(join(dataset, name), "utf8"));
const corpus = read("corpus.json");
const decisions = read("decisions.json").decisions;
const relay = read("relay.json").questions;
const traces = new Map(corpus.traces.map((trace) => [trace.id, trace]));

// This is a deterministic mock of add_message extraction. The text and source ids are
// copied from the alpha gold; only the field assignment is reviewed against standard §2.2.5.
const review = {
  source: "eval/project-memory/dataset copied from dev-project-memory-alpha",
  method: "mock-add-message-extraction",
  reviewedAt: "2026-11-02",
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
  acceptedDecisionIds: decisions.map((d) => d.id).filter((id) => !new Set(["d_copy", "d_price", "d_export", "d_csv"]).has(id))
};

const findingById = new Map(review.findings.map((finding) => [finding.id, finding]));
const entries = [];
for (const decision of decisions) {
  const finding = findingById.get(decision.id);
  const kind = finding ? "experience" : "decision";
  entries.push({
    id: `${kind}_${decision.id}`,
    kind,
    topicId: decision.projectId === "proj_ledger" ? "ledger-monthly-report" : "catalog-price-export",
    text: decision.textAfter,
    reason: decision.reason,
    sourceTraceIds: decision.sourceTraceIds,
    changedAt: decision.changedAt,
    relation: decision.relation,
    source: "copied-alpha-gold-reviewed"
  });
}

// Evolution is restricted to output status changes represented by supersedes or explicit
// completed/reverted/fixed outcomes in the copied corpus. Query/answer text is never rewritten.
const evolutionIds = ["t_column", "t_wait", "t_csv", "t_bug", "t_env", "t_tell", "t_dryrun"];
for (const id of evolutionIds) {
  const trace = traces.get(id);
  entries.push({
    id: `evolution_${id}`,
    kind: "evolution",
    topicId: trace.projectId === "proj_ledger" ? "ledger-monthly-report" : "catalog-price-export",
    text: trace.answer,
    sourceTraceIds: [id],
    at: trace.at,
    supersedes: trace.supersedes ?? [],
    source: "copied-alpha-corpus"
  });
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
    traceIds: ["t_report", "t_sample", "t_bug"],
    questionIds: ["q03", "q04", "q15", "q16", "q17"]
  },
  {
    id: "catalog-export",
    title: "catalog 价格导出",
    projectId: "proj_catalog",
    traceIds: ["t_export", "t_csv", "t_cat_round", "t_cat_tz", "t_cat_dup"],
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
    traceIds: ["t_verbose", "t_short", "t_write_secret", "t_admin_env", "t_silent", "t_tell", "t_write_main", "t_admin_branch"],
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
    }),
    questions: timeline.questionIds.map((id) => relay.find((question) => question.id === id)).filter(Boolean).map((question) => ({
      id: question.id,
      kind: question.kind,
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
console.log(JSON.stringify({ entries: entries.length, decisions: review.acceptedDecisionIds.length, reclassified: review.findings.length, timelines: timelineSpecs.length, questions: relay.length }));

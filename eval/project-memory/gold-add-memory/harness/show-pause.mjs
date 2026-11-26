#!/usr/bin/env node
// Prints one pause of the step-by-step review as Markdown: the event, each issue, the Traces
// involved with their gold ops, MemOS's Episodes for them, and the Space's Topics now.
//   node harness/show-pause.mjs <run-dir> [pause-file]   (default: the latest pause)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDataset } from "../build-gold-baseline.mjs";
import { goldFor } from "../load-eval-set.mjs";

const [runDir, name] = process.argv.slice(2);
const dir = join(runDir, "pauses");
const file = name ?? readdirSync(dir).sort().at(-1);
const pause = JSON.parse(readFileSync(join(dir, file), "utf8"));
const ds = loadDataset();
const gold = goldFor(ds, { flush: true });
const traces = new Map(ds.corpus.traces.map((t) => [t.id, t]));
const labels = new Map(gold.traceLabels.map((l) => [l.trace, l]));
const cut = (text, n = 220) => { const s = String(text ?? "").replace(/\s+/g, " "); return s.length > n ? `${s.slice(0, n)}…` : s; };
const out = [];
out.push(`## ${file}: event ${pause.event_index} ${pause.id} @ ${pause.at}`);
if (pause.subject.trace) out.push(`当前事件 Add：${pause.subject.trace}（${pause.subject.conversation}）`);
else out.push(`当前事件问题：${pause.subject.question} ${pause.subject.text}`);
const involved = new Set();
for (const issue of pause.issues) {
  out.push(`\n### [${issue.type}] ${issue.trace ?? issue.question ?? issue.topic ?? ""} ${issue.entry ?? ""}`);
  for (const [key, label] of [["op", "op"], ["expected", "gold 期望"], ["expectedTopic", "gold Topic"], ["actual", "MemOS 实际"], ["actualTopic", "MemOS Topic"],
    ["actualTopicGold", "该 Topic 对应 gold"], ["topic", "MemOS Topic"], ["actualTopics", "MemOS Topics"], ["expectedConflicts", "gold conflicts"], ["actualConflicts", "MemOS conflicts"],
    ["expectedHistory", "gold history"], ["actualHistory", "MemOS history"], ["ids", "归属 gold"], ["reason", "判定理由"],
    ["text", "题目"], ["goldAnswer", "标准答案"], ["answer", "回答"], ["judge", "judge"], ["layer", "丢失层"], ["retrievedTopics", "检索到的 Topic"]]) {
    if (issue[key] === undefined || issue[key] === null || (Array.isArray(issue[key]) && !issue[key].length)) continue;
    out.push(`- ${label}：${Array.isArray(issue[key]) ? issue[key].map((x) => cut(typeof x === "string" ? x : JSON.stringify(x), 160)).join(" ｜ ") : cut(issue[key], 400)}`);
  }
  for (const fact of issue.facts ?? []) out.push(`- 事实 ${fact.entry}/${fact.part}：stored=${fact.stored.length} retrieved=${fact.retrieved} rank=${fact.rank} ${cut(fact.stored.map((s) => `${s.topic}: ${s.content}`).join(" ｜ "), 300)}`);
  for (const job of issue.jobs ?? []) out.push(`- Episode ${job.episode.slice(0, 8)} seq ${job.seq.join("-")} ${job.stage}/${job.outcome} drafts=${job.drafts} topics=${job.topics.length} starts=${JSON.stringify(job.boundary?.starts)} prev=${(job.previous ?? "-").slice(0, 8)} warn=${JSON.stringify(job.warnings)}`);
  if (issue.trace) involved.add(issue.trace);
}
for (const id of involved) {
  const t = traces.get(id);
  out.push(`\n### Trace ${id}（${t.conversation}，${t.chat_time}）gold ops：${JSON.stringify(labels.get(id)?.ops)}`);
  out.push(`- Q：${cut(t.query, 600)}`);
  out.push(`- A：${cut(t.answer, 400)}`);
}
console.log(out.join("\n"));

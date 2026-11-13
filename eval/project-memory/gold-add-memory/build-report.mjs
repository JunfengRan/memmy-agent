#!/usr/bin/env node
// Renders dataset v2 gold (and optionally scored reports) as one HTML page.
//   node build-report.mjs [report.json ...] [--template <explainer.html>] [--out <file>]
// Template: --template or MEMMY_EVAL_REPORT_TEMPLATE (the MemTensor explainer template); without one
// a minimal standalone page is written. Output defaults to eval/project-memory/runs/report.html.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finalPointTexts } from "./build-gold-baseline.mjs";
import { loadGold } from "./load-eval-set.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const templatePath = option("--template") ?? process.env.MEMMY_EVAL_REPORT_TEMPLATE;
const out = option("--out") ?? join(root, "..", "runs", "report.html");
const reports = args.map((path) => ({ path, report: JSON.parse(readFileSync(path, "utf8")) }));
const gold = loadGold();

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
const code = (text) => `<code>${esc(text)}</code>`;
const tag = (text, cls = "") => `<span class="tag ${cls}">${esc(text)}</span>`;
const day = (iso) => String(iso ?? "").slice(5, 16).replace("T", " ");
const member = Object.fromEntries(gold.members.map((m) => [m.user_id, m.name]));
const who = (ids) => (ids ?? []).map((id) => member[id] ?? id).join("、");
const table = (head, rows) => `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : esc(v ?? "—"));

const entries = new Map(gold.entries.map((e) => [e.id, e]));
const count = (pred) => gold.entries.filter(pred).length;
const outcomes = gold.traceLabels.reduce((acc, t) => ({ ...acc, [t.outcome]: (acc[t.outcome] ?? 0) + 1 }), {});
const scored = gold.questions.filter((q) => !q.excluded);
const kinds = scored.reduce((acc, q) => ({ ...acc, [q.kind]: (acc[q.kind] ?? 0) + 1 }), {});

const spacesHtml = table(["空间", "已登记领域", "主题"], gold.spaces.map((s) => [code(s.space_id), s.domains.map((d) => esc(d.domain)).join("、"), gold.topics.filter((t) => t.space_id === s.space_id).map((t) => esc(t.topic_name)).join("、")]));
const traceHtml = table(["轨迹", "空间", "结果", "写入", "不写原因"], gold.traceLabels.map((t) => [code(t.trace), code(t.space_id), tag(t.outcome, t.outcome === "not-written" ? "tag-memos" : "tag-positive"), t.ops.map(code).join(" "), esc(t.dropped.join("、"))]));
const entryHtml = (e) => {
  const lines = [`<li>${tag(e.kind, e.kind === "decision" ? "tag-memos" : "tag-memmy")}${e.category ? ` ${tag(e.category)}` : ""}${e.optional ? ` ${tag("optional")}` : ""} ${esc(e.content)} <span class="muted">（${day(e.time)}，${esc(who(e.user_ids))}）${code(e.id)}</span>`];
  for (const c of e.conflicts ?? []) lines.push(`<br><span class="muted">不一致：</span>${esc(c.content)} <span class="muted">（${day(c.time)}，${esc(who(c.user_ids))}）</span>`);
  for (const h of e.history ?? []) lines.push(`<br><span class="muted">此前：</span>${esc(h.content)} <span class="muted">（${day(h.time)}${h.reason ? `；原因：${esc(h.reason)}` : ""}）</span>`);
  return `${lines.join("")}</li>`;
};
const topicHtml = gold.topics.map((t) => `<h3>${esc(t.topic_name)} ${tag(t.domain)} ${code(t.id)}</h3><p>${esc(finalPointTexts(t.summaryKeyPoints).join("；"))}</p><ul>${t.entries.map((id) => entryHtml(entries.get(id))).join("")}</ul>`).join("");
const questionHtml = table(["题目", "类型", "提问时间", "问题", "标准答案", "期望", "陷阱"], gold.questions.map((q) => [
  code(q.id) + (q.excluded ? ` ${tag("excluded")}` : ""), tag(q.kind), esc(day(q.askedAt)), esc(q.question), esc(q.goldAnswer),
  q.expectedItems.map((i) => `${code(i.entry)} ${esc(i.part)}`).join("<br>"), q.trapItems.map((i) => `${code(i.entry)} ${esc(i.kind)}`).join("<br>")
]));
const negativeHtml = table(["不该写入", "轨迹", "原因"], gold.negatives.map((n) => [esc(n.text), code(n.trace), esc(n.reason)]));
const resultHtml = reports.length ? reports.map(({ path, report }) => `<h3>${esc(report.run?.kind ?? "run")} ${code(path)}</h3><p>被测模型 ${code(report.run?.sut?.model ?? "—")} · 阅读模型 ${code(report.run?.reader?.model ?? "—")} · 评委 ${code(report.judge?.model ?? "rule-only")}</p>${table(["得分", "值"], Object.entries(report.scores).map(([k, v]) => [code(k), fmt(v)]))}${table(["错误", "值"], Object.entries(report.errors).map(([k, v]) => [code(k), fmt(v)]))}`).join("") : "<p>未传入评分报告。用法见 README。</p>";

const title = "项目记忆评测数据集 v2";
const main = `
      <header class="doc-head"><p class="eyebrow">评测 ${tag("MemOS", "tag-memos")} ${tag("Memmy", "tag-memmy")}</p><h1>${title}</h1><div class="title-rule" aria-hidden="true"></div>
      <p class="lead">金标按 v3 §2.2.5–§2.2.9 从 ${gold.traceLabels.length} 条轨迹重推：${count((e) => e.kind === "decision")} 条决策、${count((e) => e.kind === "experience")} 条经验、${count((e) => e.kind === "timeline" && !e.optional)} 条必写进展（另 ${count((e) => e.optional)} 条可写可不写），${gold.topics.length} 个主题，${gold.negatives.length} 条不该写入的内容；${scored.length} 道计分题（${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(" · ")}），${gold.apiChecks.length} 项接口检查。轨迹结果：${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(" · ")}。</p></header>
      <section id="s1"><h2><span class="sec-no">01</span>空间与轨迹</h2>${spacesHtml}${traceHtml}</section>
      <section id="s2"><h2><span class="sec-no">02</span>金标主题与条目</h2>${topicHtml}<h3>不该写入的内容</h3>${negativeHtml}</section>
      <section id="s3"><h2><span class="sec-no">03</span>题目</h2>${questionHtml}</section>
      <section id="s4"><h2><span class="sec-no">04</span>评分结果</h2>${resultHtml}</section>`;

let html;
if (templatePath) {
  const template = readFileSync(templatePath, "utf8");
  const marker = "  <script>\n    (() => {";
  if (!template.includes("<body>") || !template.includes(marker)) throw new Error(`${templatePath} is not the explainer template (missing <body> or the script marker)`);
  const [head, rest] = template.split("<body>");
  const scripts = rest.slice(rest.indexOf(marker) + marker.length);
  const toc = `<nav class="toc" aria-label="目录"><p class="toc-brand"><span class="toc-org">MemTensor</span><span class="toc-kind">评测</span></p><a href="#s1" aria-current="true"><span class="toc-no">01</span>空间与轨迹</a><a href="#s2"><span class="toc-no">02</span>金标</a><a href="#s3"><span class="toc-no">03</span>题目</a><a href="#s4"><span class="toc-no">04</span>评分结果</a></nav>`;
  const body = `<body>\n  <div class="page-tools"><button type="button" class="theme-toggle" data-theme-toggle aria-label="切换配色"></button></div>\n  <div class="layout">\n    ${toc}\n    <main>${main}\n    </main>\n  </div>\n`;
  html = head.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`).replace("</head>", "<style>.muted{color:var(--muted);font-size:13px}</style></head>") + body + marker + scripts;
} else {
  html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>body{font:14px/1.6 system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border:1px solid #ddd;padding:4px 8px;vertical-align:top;text-align:left}.tag{display:inline-block;padding:0 6px;border-radius:4px;background:#eef;font-size:12px}.muted{color:#777;font-size:13px}code{font-size:12px}</style></head><body><main>${main}</main></body></html>\n`;
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(JSON.stringify({ out, template: templatePath ?? null, reports: reports.length }));

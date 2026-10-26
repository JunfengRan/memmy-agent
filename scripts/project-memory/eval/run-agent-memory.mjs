// Model-maintained project-memory evaluation.
// This arm deliberately reads only corpus.json and relay.json. It never reads
// decisions.json, conflicts.json, todolists.json, or scoring.json while building
// the memory. Haiku must decide what to retain, how to version it, and what to
// supersede from the raw trajectory itself.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreAnswer } from "../../../eval/project-memory/load-eval-set.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = join(repo, "eval/project-memory");
const runs = join(root, "runs");
const env = Object.fromEntries(readFileSync(join(homedir(), ".env"), "utf8").split(/\r?\n/)
  .filter((line) => line && !line.startsWith("#") && line.includes("="))
  .map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
// Keep the model-maintained arm physically unable to consume the gold decision,
// conflict, todo, or scoring files. The raw corpus and question relay are the
// only dataset inputs used here.
const evalSet = {
  corpus: JSON.parse(readFileSync(join(root, "dataset/corpus.json"), "utf8")),
  relay: JSON.parse(readFileSync(join(root, "dataset/relay.json"), "utf8"))
};
const projects = new Map(evalSet.corpus.projects.map((p) => [p.id, p.name]));
const traces = [...evalSet.corpus.traces].sort((a, b) => a.at.localeCompare(b.at));
const questions = evalSet.relay.questions.filter((q) => !q.excluded && q.id !== "q21").sort((a, b) => a.askedAt.localeCompare(b.askedAt));
const started = Date.now();
let modelCalls = 0;

function log(s) { process.stderr.write(`[agent-memory ${(Date.now() - started / 1) / 1000 | 0}s] ${s}\n`); }
function cleanJson(text) { return String(text).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim(); }
async function chat(messages, json = true) {
  const base = String(env.OPENAI_API_BASE).replace(/\/$/, "");
  let last = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: env.MODEL, messages, ...(json ? { response_format: { type: "json_object" } } : {}) }),
        signal: AbortSignal.timeout(120_000)
      });
      const text = await response.text();
      if (response.ok) { modelCalls += 1; return JSON.parse(text).choices?.[0]?.message?.content ?? ""; }
      last = `http ${response.status} ${text.slice(0, 160)}`;
      if (![429, 502, 503].includes(response.status)) break;
    } catch (e) { last = String(e); }
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
  throw new Error(last);
}
async function jsonChat(system, user) {
  const text = await chat([{ role: "system", content: system }, { role: "user", content: user }]);
  try { return JSON.parse(cleanJson(text)); } catch { return null; }
}
function raw(trace) {
  return `轨迹ID: ${trace.id}\n时间: ${trace.at}\n项目: ${trace.projectId ? projects.get(trace.projectId) : "全局"}\n文件: ${(trace.changedFiles ?? []).join(", ")}\n用户: ${trace.query}\n助手: ${trace.answer}`;
}
function visibleCards(cards, projectId) {
  return cards.filter((c) => c.status === "current" && (c.projectId === projectId || c.projectId === null || projectId === null && c.projectId === null));
}
function cardText(cards) {
  return cards.map((c) => `[${c.key}] ${c.projectName ?? "全局"} ${c.kind ?? "fact"}：${c.claim}（来源：${c.sourceTraceIds.join(",")}）`).join("\n");
}
function save(path, data) { writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`); }
function terms(text) { return String(text).toLowerCase().split(/[\s,，。！？、；：()（）/]+/).filter((x) => x.length > 1); }
function wikiHits(page, query) {
  const qs = new Set(terms(query));
  return page.split(/\n{2,}/).map((part) => ({ part, score: terms(part).filter((t) => qs.has(t)).length }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 8).map((x) => x.part).join("\n\n");
}

const extractSystem = `你是项目记忆维护 Agent。你只根据当前原始工作轨迹和已有记忆卡片维护记忆库，不得假设评测标准，也不能读取任何标注答案。请自行判断哪些内容值得长期记忆：项目规则、决定、版本变化、作用域、跨窗口通知、冲突和安全约束。遇到后来改口时，保留新旧版本，但把旧卡片标为 superseded，并用 supersedesKeys 指向它。不要把普通过程噪声写成长期事实。只返回 JSON：{"upserts":[{"key":"短英文或中文键","claim":"可核验的简洁事实，尽量保留原话","kind":"decision|constraint|workflow|fact|scope","supersedesKeys":[],"confidence":"high|medium|low"}],"supersedeKeys":[],"discardReason":"..."}.`;
const selectSystem = `你是项目记忆检索 Agent。根据问题和候选记忆卡片选择回答所需的卡片。遵守作用域：项目问题只能用该项目和全局卡片；全局问题只能用全局卡片。选择当前有效且直接相关的卡片，遇到同一主题的版本只选你判断仍有效的版本。只返回 JSON：{"keys":["卡片key"],"reason":"一句话"}`;

async function main() {
  const ledgerPath = join(runs, "agent-memory-ledger.json");
  let priorLedger = null;
  try { priorLedger = JSON.parse(readFileSync(ledgerPath, "utf8")); } catch { /* first run */ }
  const cards = Array.isArray(priorLedger?.cards) ? priorLedger.cards : [];
  const byKey = new Map(cards.map((c) => [c.key, c]));
  const ingestLog = Array.isArray(priorLedger?.ingestLog) ? priorLedger.ingestLog : [];
  const completed = new Set(ingestLog.map((x) => x.traceId));
  for (const trace of traces.filter((x) => !completed.has(x.id))) {
    const projectId = trace.projectId ?? null;
    const prior = visibleCards(cards, projectId);
    const result = await jsonChat(extractSystem, `已有当前记忆卡片：\n${cardText(prior) || "（空）"}\n\n请处理这一条原始轨迹：\n${raw(trace)}`);
    const upserts = Array.isArray(result?.upserts) ? result.upserts : [];
    const explicitSupersedes = new Set([...(result?.supersedeKeys ?? [])]);
    const created = [];
    for (const key of explicitSupersedes) {
      const old = byKey.get(key); if (old) old.status = "superseded";
    }
    for (const item of upserts) {
      if (!item?.claim) continue;
      const key = String(item.key || `card_${cards.length + 1}`).slice(0, 80);
      for (const oldKey of (item.supersedesKeys ?? [])) { const old = byKey.get(oldKey); if (old) old.status = "superseded"; }
      const card = { key, projectId, projectName: projectId ? projects.get(projectId) : null, claim: String(item.claim).trim(), kind: item.kind || "fact", confidence: item.confidence || "medium", status: "current", sourceTraceIds: [trace.id], createdAt: trace.at };
      const old = byKey.get(key);
      if (old) { old.claim = card.claim; old.kind = card.kind; old.confidence = card.confidence; old.status = "current"; old.sourceTraceIds = [...new Set([...old.sourceTraceIds, trace.id])]; }
      else { cards.push(card); byKey.set(key, card); }
      created.push(key);
    }
    ingestLog.push({ traceId: trace.id, at: trace.at, upserts: created, superseded: [...explicitSupersedes], discardReason: result?.discardReason ?? "" });
    save(ledgerPath, { method: "model-maintained-from-raw-traces", model: env.MODEL, cards, ingestLog });
    log(`${trace.id}: ${created.length} cards`);
  }

  const wikiPages = new Map();
  const wikiSystem = `你是项目 Wiki 维护者。只根据给定的原始工作轨迹和模型已经抽取的记忆卡片，写一份可检索的 Markdown 项目 Wiki。自行合并同一主题、保留版本关系并明确当前做法；不要读取或猜测任何评测标准。原始轨迹是证据，卡片可能有误，遇到冲突请重新判断。输出自包含 Markdown，不要解释。`;
  for (const [projectId, projectName] of projects) {
    const own = traces.filter((t) => (t.projectId ?? null) === projectId);
    const page = await chat([{ role: "system", content: wikiSystem }, { role: "user", content: `项目：${projectName}\n\n模型卡片：\n${cardText(visibleCards(cards, projectId))}\n\n原始轨迹：\n${own.map(raw).join("\n\n---\n\n")}` }], false);
    wikiPages.set(projectId, page);
  }
  const globalPage = await chat([{ role: "system", content: wikiSystem }, { role: "user", content: `项目：全局\n\n模型卡片：\n${cardText(visibleCards(cards, null))}\n\n原始轨迹：\n${traces.filter((t) => !t.projectId).map(raw).join("\n\n---\n\n")}` }], false);
  wikiPages.set(null, globalPage);

  const projectRows = [], wikiRows = [];
  for (const question of questions) {
    const candidate = visibleCards(cards, question.projectId);
    const picked = await jsonChat(selectSystem, `候选记忆卡片：\n${cardText(candidate) || "（空）"}\n\n问题所属项目：${question.projectId ? projects.get(question.projectId) : "全局"}\n问题：${question.question}`);
    const keys = Array.isArray(picked?.keys) ? picked.keys : [];
    const selected = candidate.filter((c) => keys.includes(c.key));
    const context = selected.map((c) => `${c.claim} [${c.sourceTraceIds.join(",")}]`).join("\n");
    const base = { id: question.id, kind: question.kind, question: question.question, goldAnswer: question.goldAnswer, mustInclude: question.mustInclude, mustNotInclude: question.mustNotInclude, selectedKeys: selected.map((c) => c.key), context, passed: scoreAnswer(context, question) };
    projectRows.push(base);
    const fullWiki = wikiPages.get(question.projectId) ?? "";
    const wikiText = wikiHits(fullWiki, question.question);
    const wikiContext = [context, wikiText].filter(Boolean).join("\n\n");
    wikiRows.push({ ...base, wikiContext, wikiHits: wikiText ? [{ title: "model-maintained-wiki", score: terms(wikiText).length }] : [], context: wikiContext, passed: scoreAnswer(wikiContext, question) });
    log(`${question.id}: project ${base.passed ? "pass" : "fail"}, wiki ${scoreAnswer(wikiContext, question) ? "pass" : "fail"}`);
  }
  const common = { method: "agent-maintained-memory", model: env.MODEL, questionCount: questions.length, excluded: ["q21"], modelCalls, seconds: Math.round((Date.now() - started) / 1000) };
  save(join(runs, "project-agent-recall.json"), { ...common, arm: "project-agent", passed: projectRows.filter((q) => q.passed).length, accuracy: projectRows.filter((q) => q.passed).length / questions.length, questions: projectRows });
  save(join(runs, "wiki-agent-recall.json"), { ...common, arm: "wiki-agent", passed: wikiRows.filter((q) => q.passed).length, accuracy: wikiRows.filter((q) => q.passed).length / questions.length, questions: wikiRows });
  process.stdout.write(`agent recall project ${projectRows.filter((q) => q.passed).length}/${questions.length}, wiki ${wikiRows.filter((q) => q.passed).length}/${questions.length}, ${modelCalls} model calls\n`);
}
await main();

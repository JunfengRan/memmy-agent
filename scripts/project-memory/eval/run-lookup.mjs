// Lookup arm: inject only the L3 body plus L2 and skill indexes.
// The model must call tools to read memory rows. This eval database has L1
// traces only, so the indexes are empty and the tools are what can return text.
// Search and get include L1. The agent tool renderer drops L1 from search and
// blanks an L1 get unless a raw turn is attached, so those two calls here read
// the stored row directly.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadEvalSet, scoreAnswer } from "../../../eval/project-memory/load-eval-set.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const runs = join(repo, "eval/project-memory/runs");
const evalSet = loadEvalSet();
const env = Object.fromEntries(
  readFileSync(join(homedir(), ".env"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
);
const base = String(env.OPENAI_API_BASE).replace(/\/$/, "");
const startedAt = Date.now();
let methodCalls = 0;
let judgeCalls = 0;

const db = new DatabaseSync(join(runs, "project-recall-db/memory.sqlite"), { readOnly: true });
const traceAt = new Map(evalSet.corpus.traces.map((trace) => [trace.id, trace.at]));
const traceProject = new Map(evalSet.corpus.traces.map((trace) => [trace.id, trace.projectId]));
const projectName = new Map(evalSet.corpus.projects.map((project) => [project.id, project.name]));
const rows = db.prepare(`
  SELECT m.id, m.memory_layer, m.memory_value, s.host_session_key
  FROM memories m
  JOIN sessions s ON s.id = m.session_id
  WHERE m.deleted_at IS NULL AND m.status = 'activated'
`).all();

function log(message) {
  process.stderr.write(`[lookup ${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}\n`);
}

function visible(askedAt) {
  return rows.filter((row) => {
    const at = traceAt.get(row.host_session_key);
    return at && at <= askedAt;
  });
}

function projectOf(row) {
  const id = traceProject.get(row.host_session_key);
  return id ? (projectName.get(id) ?? "global") : "global";
}

function indexLine(text) {
  const lines = String(text).split("\n").map((line) => line.trim()).filter(Boolean);
  const user = lines.indexOf("User:");
  const body = user >= 0 ? lines[user + 1] : lines[0];
  return String(body ?? "").slice(0, 48);
}

function tokens(value) {
  const out = String(value).toLowerCase().match(/[a-z0-9_./]{2,}/g) ?? [];
  for (const run of String(value).match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) out.push(run.slice(index, index + 2));
  }
  return out;
}

function search(records, query) {
  const wanted = new Set(tokens(query));
  return records
    .map((row) => ({ row, score: tokens(row.memory_value).filter((token) => wanted.has(token)).length }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.row.id.localeCompare(right.row.id))
    .slice(0, 5)
    .map((item) => `${item.row.id} [${item.row.memory_layer} ${projectOf(item.row)}] ${String(item.row.memory_value).replace(/\s+/g, " ").slice(0, 160)}`);
}

function list(records, layer) {
  const matched = records.filter((row) => !layer || row.memory_layer === layer);
  if (matched.length === 0) return [`${layer || "全部"} 没有记录`];
  return matched.map((row) => `${row.id} [${row.memory_layer} ${projectOf(row)}] ${indexLine(row.memory_value)}`);
}

function get(records, id) {
  const row = records.find((item) => item.id === id);
  if (!row) return `找不到 ${id}，或这题提问时它还不存在`;
  return `${row.id} [${row.memory_layer} ${projectOf(row)}]\n${String(row.memory_value).slice(0, 1500)}`;
}

function toolResult(records, call) {
  const tool = call?.tool;
  if (tool === "memory_list") return list(records, typeof call.layer === "string" ? call.layer : "").join("\n");
  if (tool === "memory_search") return search(records, String(call.query ?? "")).join("\n") || "没有命中";
  if (tool === "memory_get") return get(records, String(call.id ?? ""));
  return "未知工具。可用 memory_list、memory_search、memory_get。";
}

function indexContext() {
  return [
    "## L3 世界模型",
    "当前库有两个世界模型范围键，没有关联正文。",
    "## L2 索引",
    "空。",
    "## Skill 索引",
    "空。"
  ].join("\n");
}

const system = [
  "你只能根据下面给出的索引和你用工具查到的记录回答。不要使用索引和工具结果以外的知识。",
  "一次只返回一个 JSON 对象。查表：{\"tool\":\"memory_list\",\"layer\":\"L1\"}、{\"tool\":\"memory_search\",\"query\":\"关键词\"}、{\"tool\":\"memory_get\",\"id\":\"trace_...\"}。",
  "memory_list 只给短索引。要看原文用 memory_get。查完再返回 {\"answer\":\"中文回答\"}。",
  "只采用和当前问题同一个项目、而且没有被后来改口覆盖的事实。不要复述你否定的那句原话。"
].join("\n");

async function chat(messages, jsonMode = true) {
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: env.MODEL,
          messages,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {})
        }),
        signal: AbortSignal.timeout(90_000)
      });
      const text = await response.text();
      if (response.ok) {
        methodCalls += 1;
        return JSON.parse(text).choices?.[0]?.message?.content ?? "";
      }
      lastError = `http ${response.status} ${text.slice(0, 160)}`;
      if (response.status !== 429 && response.status !== 502 && response.status !== 503) break;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 4000 * (attempt + 1)));
  }
  throw new Error(lastError);
}

function parseJson(text) {
  try {
    return JSON.parse(String(text).replace(/^```json\s*|```$/g, "").trim());
  } catch {
    return null;
  }
}

async function answerQuestion(question) {
  const records = visible(question.askedAt);
  const messages = [
    { role: "system", content: system },
    { role: "user", content: `${indexContext()}\n\n问题：${question.question}` }
  ];
  const tools = [];
  let answer = "";
  for (let round = 0; round < 6; round += 1) {
    const raw = await chat(messages);
    const parsed = parseJson(raw);
    if (parsed && typeof parsed.answer === "string" && !parsed.tool) {
      answer = parsed.answer;
      break;
    }
    const result = toolResult(records, parsed ?? {});
    tools.push({ call: parsed ?? raw, result });
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: `工具结果：\n${result}` });
  }
  if (!answer) {
    messages.push({ role: "user", content: "不要再调用工具。只返回 {\"answer\":\"中文回答\"}。" });
    const raw = await chat(messages);
    answer = parseJson(raw)?.answer || raw;
  }
  const context = [indexContext(), ...tools.map((item) => `工具 ${JSON.stringify(item.call)}\n${item.result}`)].join("\n\n");
  return { context, answer, tools: tools.length, visible: records.length };
}

const judgeSystem = "你是评测裁判。只返回 JSON：{\"pass\":true或false,\"errorType\":\"empty|superseded|ambiguous|wrong_project|other|none\",\"reason\":\"一句话\"}。pass 为 true 时 errorType 用 none。答错时：empty 是召回空或答不出；superseded 是把已经过时的说法当成现行；ambiguous 是几条相似信息没有选；wrong_project 是用了另一个项目的说法；其余用 other。pass 为 true 的条件是：回答体现每一条现行要点，并且没有把任一陷阱说法当成现行事实。";

const questions = evalSet.relay.questions.filter((question) => question.id !== "q21" && !question.excluded);
const recallRows = [];
const answerRows = [];

for (const question of questions) {
  log(question.id);
  const result = await answerQuestion(question);
  const recallPassed = scoreAnswer(result.context, question);
  recallRows.push({
    id: question.id,
    kind: question.kind,
    question: question.question,
    goldAnswer: question.goldAnswer,
    mustInclude: question.mustInclude,
    mustNotInclude: question.mustNotInclude,
    context: result.context,
    toolCalls: result.tools,
    visibleRows: result.visible,
    passed: recallPassed
  });
  let judgment = { pass: false, errorType: "other", reason: "裁判失败" };
  let judgmentText = "";
  try {
    judgmentText = await chat([
      { role: "system", content: judgeSystem },
      { role: "user", content: JSON.stringify({
        question: question.question,
        mustInclude: question.mustInclude,
        mustNotInclude: question.mustNotInclude,
        answer: result.answer
      }) }
    ]);
    judgeCalls += 1;
    methodCalls -= 1;
    judgment = parseJson(judgmentText) ?? judgment;
  } catch (error) {
    judgment = { pass: false, errorType: "other", reason: String(error).slice(0, 160) };
  }
  answerRows.push({
    id: question.id,
    kind: question.kind,
    question: question.question,
    goldAnswer: question.goldAnswer,
    mustInclude: question.mustInclude,
    mustNotInclude: question.mustNotInclude,
    context: result.context,
    answer: result.answer,
    toolCalls: result.tools,
    judgmentText,
    passed: judgment.pass === true,
    errorType: judgment.pass === true ? "none" : (judgment.errorType || "other"),
    reason: judgment.reason ?? ""
  });
  const recallPassedCount = recallRows.filter((row) => row.passed).length;
  const answerPassedCount = answerRows.filter((row) => row.passed).length;
  writeFileSync(join(runs, "lookup-recall.json"), `${JSON.stringify({
    arm: "lookup",
    method: "index-then-tool",
    model: env.MODEL,
    modelCalls: methodCalls,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    questionCount: questions.length,
    excluded: ["q21"],
    passed: recallPassedCount,
    accuracy: recallPassedCount / questions.length,
    questions: recallRows
  }, null, 2)}\n`);
  writeFileSync(join(runs, "lookup-answer.json"), `${JSON.stringify({
    arm: "lookup",
    method: "memmy-model-answer",
    model: env.MODEL,
    modelCalls: methodCalls,
    judgeCalls,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    questionCount: questions.length,
    excluded: ["q21"],
    passed: answerPassedCount,
    accuracy: answerPassedCount / questions.length,
    questions: answerRows
  }, null, 2)}\n`);
  log(`${question.id} tools ${result.tools} recall ${recallPassedCount}/${recallRows.length} answer ${answerPassedCount}/${answerRows.length}`);
}

const recallPassedCount = recallRows.filter((row) => row.passed).length;
const answerPassedCount = answerRows.filter((row) => row.passed).length;
process.stdout.write(`lookup recall ${recallPassedCount}/${questions.length} answer ${answerPassedCount}/${questions.length} method calls ${methodCalls} judge calls ${judgeCalls}\n`);

// Project memory plus a searchable wiki.
// The project-memory half is the committed direct-recall context in
// runs/project-recall.json. Replaying completeTurn would draw a new summary
// sample and mix that noise into the wiki delta. Traces are ingested into a
// per-project wiki in the same time order as run-recall.ts. At each question
// the wiki is searched (hop 0) and the top two pages are read into the context.
//
// Usage: node scripts/project-memory/eval/run-wiki-recall.mjs [--recall-only]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalSet, scoreAnswer } from "../../../eval/project-memory/load-eval-set.mjs";
import { createSearchableWiki } from "../../../eval/project-memory/arms/searchable-wiki.mjs";

const recallOnly = process.argv.includes("--recall-only");
const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = join(repo, "eval/project-memory");
const runs = join(root, "runs");
const startedAt = Date.now();
const READ_LIMIT = 2;

const env = Object.fromEntries(
  readFileSync(join(homedir(), ".env"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    })
);

const evalSet = loadEvalSet();
const baseRecall = JSON.parse(readFileSync(join(runs, "project-recall.json"), "utf8"));
const baseById = new Map(baseRecall.questions.map((question) => [question.id, question]));
const projectName = new Map(evalSet.corpus.projects.map((project) => [project.id, project.name]));
const wiki = createSearchableWiki(join(runs, "wiki-recall-db"));
let modelCalls = 0;

function log(message) {
  process.stderr.write(`[wiki ${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}\n`);
}

async function chat(messages, jsonMode = false) {
  const body = { model: env.MODEL, messages };
  if (jsonMode) body.response_format = { type: "json_object" };
  const base = String(env.OPENAI_API_BASE).replace(/\/$/, "");
  let lastError = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sent = Date.now();
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000)
      });
      const text = await response.text();
      if (response.ok) {
        modelCalls += 1;
        const content = JSON.parse(text).choices?.[0]?.message?.content ?? "";
        log(`model call ${Date.now() - sent}ms`);
        return content;
      }
      lastError = `http ${response.status} ${text.slice(0, 180)}`;
      if (response.status !== 429 && response.status !== 502 && response.status !== 503) break;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 8000 * (attempt + 1)));
  }
  throw new Error(lastError);
}

async function complete(system, user) {
  return chat([
    { role: "system", content: system },
    { role: "user", content: user }
  ]);
}

function sourceText(trace) {
  const project = trace.projectId ? (projectName.get(trace.projectId) ?? trace.projectId) : "无";
  const files = (trace.changedFiles ?? []).join(" ");
  return `项目: ${project}\n时间: ${trace.at}\n文件: ${files}\n问: ${trace.query}\n答: ${trace.answer}\n`;
}

function renderPages(pages) {
  return pages.map((page) => `${page.title}\n${page.type}\n${page.body}`).join("\n\n");
}

function choose(hits, limit, predicate) {
  return hits.filter((hit) => hit.body && predicate(hit)).slice(0, limit);
}

function scoreWith(baseContext, addition, question) {
  const text = addition ? `${baseContext}\n\n${addition}` : baseContext;
  return scoreAnswer(text, question);
}

const events = [
  ...evalSet.corpus.traces.map((trace) => ({ at: trace.at, order: 0, trace })),
  ...evalSet.relay.questions.map((question) => ({ at: question.askedAt, order: 1, question }))
].sort((left, right) => left.at.localeCompare(right.at) || left.order - right.order);

const questions = [];
for (const event of events) {
  if (event.trace) {
    const trace = event.trace;
    const wikiId = trace.projectId ?? "global";
    const replies = [];
    try {
      const result = await wiki.ingest({
        wikiId,
        sourceName: `${trace.id}.md`,
        sourceText: sourceText(trace),
        quote: trace.answer,
        complete: async (system, user) => {
          const reply = await complete(system, user);
          replies.push(reply);
          return reply;
        }
      });
      log(`${trace.id} ${result.skipped ? "cached" : "ingested"} pages ${result.pageCount} maintained ${result.maintained ?? "-"} calls ${result.modelCalls}`);
    } catch (error) {
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(runs, "wiki-last-reply.txt"), replies.join("\n\n-----\n\n"));
      throw error;
    }
    continue;
  }
  const question = event.question;
  if (question.excluded || question.id === "q21") continue;
  const saved = baseById.get(question.id);
  if (!saved?.context) throw new Error(`missing project recall context for ${question.id}`);
  const wikiId = question.projectId ?? "global";
  const found = wiki.search(wikiId, question.question, { limit: 40, hop: 0 });
  const bodies = new Map(wiki.read(wikiId, found.results.map((hit) => hit.path)).map((page) => [page.path, page.body ?? ""]));
  const hits = found.results.map((hit) => ({ ...hit, body: bodies.get(hit.path) ?? "" }));
  const read1 = renderPages(choose(hits, 1, () => true));
  const read2 = renderPages(choose(hits, READ_LIMIT, () => true));
  const read3 = renderPages(choose(hits, 3, () => true));
  const maintained2 = renderPages(choose(hits, READ_LIMIT, (hit) => hit.type !== "source"));
  const snippet2 = choose(hits, READ_LIMIT, () => true).map((hit) => `${hit.title}\n${hit.type}\n${hit.snippet}`).join("\n\n");
  const basePassed = scoreAnswer(saved.context, question);
  const variants = {
    read1: scoreWith(saved.context, read1, question),
    read2: scoreWith(saved.context, read2, question),
    read3: scoreWith(saved.context, read3, question),
    maintained2: scoreWith(saved.context, maintained2, question),
    snippet2: scoreWith(saved.context, snippet2, question)
  };
  questions.push({
    id: question.id,
    kind: question.kind,
    question: question.question,
    goldAnswer: question.goldAnswer,
    mustInclude: question.mustInclude,
    mustNotInclude: question.mustNotInclude,
    basePassed,
    passed: variants.read2,
    variants,
    wikiContext: read2,
    context: read2 ? `${saved.context}\n\n${read2}` : saved.context,
    hits: hits.slice(0, 5).map((hit) => ({
      path: hit.path,
      title: hit.title,
      type: hit.type,
      score: Number(hit.score.toFixed(3)),
      hop: hit.hop
    }))
  });
  log(`${question.id} base ${basePassed ? "pass" : "fail"} wiki ${variants.read2 ? "pass" : "fail"}`);
}

function count(list, predicate) {
  return list.filter(predicate).length;
}

function byKind(list) {
  const table = {};
  for (const question of list) {
    const row = table[question.kind] ??= { total: 0, base: 0, wiki: 0 };
    row.total += 1;
    if (question.basePassed) row.base += 1;
    if (question.passed) row.wiki += 1;
  }
  return table;
}

const variantCounts = {
  read1: count(questions, (question) => question.variants.read1),
  read2: count(questions, (question) => question.variants.read2),
  read3: count(questions, (question) => question.variants.read3),
  maintained2: count(questions, (question) => question.variants.maintained2),
  snippet2: count(questions, (question) => question.variants.snippet2)
};
const basePassed = count(questions, (question) => question.basePassed);
const recallReport = {
  arm: "wiki",
  method: "recall",
  baseArm: "project",
  basePassed,
  readLimit: READ_LIMIT,
  hop: 0,
  model: env.MODEL,
  modelCalls,
  seconds: Math.round((Date.now() - startedAt) / 1000),
  questionCount: questions.length,
  excluded: ["q21"],
  passed: variantCounts.read2,
  accuracy: variantCounts.read2 / questions.length,
  variantCounts,
  byKind: byKind(questions),
  helped: questions.filter((question) => question.passed && !question.basePassed).map((question) => question.id),
  hurt: questions.filter((question) => !question.passed && question.basePassed).map((question) => question.id),
  questions: questions.sort((left, right) => left.id.localeCompare(right.id))
};
mkdirSync(runs, { recursive: true });
writeFileSync(join(runs, "wiki-recall.json"), `${JSON.stringify(recallReport, null, 2)}\n`);
process.stdout.write(
  `wiki recall ${recallReport.passed}/${questions.length} base ${basePassed}/${questions.length}`
  + ` maintained ${variantCounts.maintained2}/${questions.length}`
  + ` helped ${recallReport.helped.join(",") || "-"} hurt ${recallReport.hurt.join(",") || "-"}`
  + ` in ${recallReport.seconds}s, ${modelCalls} model calls\n`
);

if (recallOnly) process.exit(0);

const previous = JSON.parse(readFileSync(join(runs, "project-answer.json"), "utf8"));
const previousById = new Map(previous.questions.map((question) => [question.id, question]));
const answerPath = join(runs, "wiki-answer.json");
const done = new Map();
try {
  const existing = JSON.parse(readFileSync(answerPath, "utf8"));
  for (const item of existing.questions ?? []) {
    if (item?.id && item.answer) done.set(item.id, item);
  }
} catch {
  // First answer pass.
}

const answerSystem = "你根据给定记忆回答问题。记忆里可能有过时说法或其他项目的说法。只采用和当前问题同一个项目、而且没有被后来改口覆盖的事实。回答用普通中文，不要复述你否定的那句原话。";
const judgeSystem = "你是评测裁判。只返回 JSON：{\"pass\":true或false,\"errorType\":\"empty|superseded|ambiguous|wrong_project|other|none\",\"reason\":\"一句话\"}。pass 为 true 时 errorType 用 none。答错时：empty 是召回空或答不出；superseded 是把已经过时的说法当成现行；ambiguous 是几条相似信息没有选；wrong_project 是用了另一个项目的说法；其余用 other。pass 为 true 的条件是：回答体现每一条现行要点，并且没有把任一陷阱说法当成现行事实。";

function writeAnswers(results) {
  const passedNow = count(results, (item) => item.passed);
  writeFileSync(answerPath, `${JSON.stringify({
    arm: "wiki",
    method: "memmy-model-answer",
    pairedWith: "project-answer",
    model: env.MODEL,
    questionCount: results.length,
    excluded: ["q21"],
    passed: passedNow,
    accuracy: results.length === 0 ? 0 : passedNow / results.length,
    basePassed: previous.passed,
    helped: results.filter((item) => item.passed && item.basePassed === false).map((item) => item.id),
    hurt: results.filter((item) => !item.passed && item.basePassed === true).map((item) => item.id),
    rejudged: count(results, (item) => item.reused === false),
    questions: results
  }, null, 2)}\n`);
}

const answers = [];
for (const question of recallReport.questions) {
  if (done.has(question.id)) {
    answers.push(done.get(question.id));
    continue;
  }
  const earlier = previousById.get(question.id);
  if (!earlier) throw new Error(`missing project answer for ${question.id}`);
  let item;
  if (!question.wikiContext) {
    item = { ...earlier, reused: true, basePassed: earlier.passed === true, context: question.context };
  } else {
    log(`answer ${question.id}`);
    const answerPrompt = [
      { role: "system", content: answerSystem },
      { role: "user", content: `记忆：\n${question.context}\n\n问题：${question.question}` }
    ];
    const answer = await chat(answerPrompt);
    const judgePrompt = [
      { role: "system", content: judgeSystem },
      { role: "user", content: JSON.stringify({
        question: question.question,
        mustInclude: question.mustInclude,
        mustNotInclude: question.mustNotInclude,
        answer
      }) }
    ];
    let judgmentText = "";
    let judgment = null;
    for (let attempt = 0; attempt < 2 && !judgment; attempt += 1) {
      judgmentText = await chat(judgePrompt, true);
      try {
        judgment = JSON.parse(judgmentText.replace(/^```json\s*|```$/g, "").trim());
      } catch {
        judgment = null;
      }
    }
    if (!judgment) judgment = { pass: false, errorType: "other", reason: judgmentText.slice(0, 180) };
    item = {
      id: question.id,
      kind: question.kind,
      question: question.question,
      goldAnswer: question.goldAnswer,
      mustInclude: question.mustInclude,
      mustNotInclude: question.mustNotInclude,
      context: question.context,
      answerPrompt,
      answer,
      judgePrompt,
      judgmentText,
      passed: judgment.pass === true,
      errorType: judgment.pass === true ? "none" : (judgment.errorType || "other"),
      reason: judgment.reason ?? "",
      reused: false,
      basePassed: earlier.passed === true
    };
  }
  answers.push(item);
  writeAnswers(answers);
}

const answerPassed = count(answers, (item) => item.passed);
const answerReport = JSON.parse(readFileSync(answerPath, "utf8"));
process.stdout.write(
  `wiki answer ${answerPassed}/${answers.length} base ${previous.passed}/${previous.questionCount}`
  + ` rejudged ${answerReport.rejudged}`
  + ` helped ${answerReport.helped.join(",") || "-"} hurt ${answerReport.hurt.join(",") || "-"}`
  + ` in ${Math.round((Date.now() - startedAt) / 1000)}s, ${modelCalls} model calls\n`
);

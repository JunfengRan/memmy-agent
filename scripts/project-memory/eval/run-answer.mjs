import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const arm = process.argv[2] ?? "project";
const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const recall = JSON.parse(readFileSync(join(repo, "eval/project-memory/runs", `${arm}-recall.json`), "utf8"));
const env = Object.fromEntries(
  readFileSync(join(homedir(), ".env"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    })
);
const base = env.OPENAI_API_BASE.replace(/\/$/, "");

async function chat(messages) {
  let lastError = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({ model: env.MODEL, messages }),
        signal: AbortSignal.timeout(90_000)
      });
      const text = await response.text();
      if (response.ok) {
        const body = JSON.parse(text);
        return body.choices?.[0]?.message?.content ?? "";
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

async function one(question) {
  const answerPrompt = [
    { role: "system", content: "你根据给定记忆回答问题。记忆里可能有过时说法或其他项目的说法。只采用和当前问题同一个项目、而且没有被后来改口覆盖的事实。回答用普通中文，不要复述你否定的那句原话。" },
    { role: "user", content: `记忆：\n${question.context}\n\n问题：${question.question}` }
  ];
  const answer = await chat(answerPrompt);
  const judgePrompt = [
    { role: "system", content: "你是评测裁判。只返回 JSON：{\"pass\":true或false,\"errorType\":\"empty|superseded|ambiguous|wrong_project|other|none\",\"reason\":\"一句话\"}。pass 为 true 时 errorType 用 none。答错时：empty 是召回空或答不出；superseded 是把已经过时的说法当成现行；ambiguous 是几条相似信息没有选；wrong_project 是用了另一个项目的说法；其余用 other。pass 为 true 的条件是：回答体现每一条现行要点，并且没有把任一陷阱说法当成现行事实。" },
    { role: "user", content: JSON.stringify({
      question: question.question,
      mustInclude: question.mustInclude,
      mustNotInclude: question.mustNotInclude,
      answer
    }) }
  ];
  const judgmentText = await chat(judgePrompt);
  let judgment = { pass: false, errorType: "other", reason: "裁判输出无法解析" };
  try {
    judgment = JSON.parse(judgmentText.replace(/^```json\s*|```$/g, "").trim());
  } catch {
    judgment = { pass: false, errorType: "other", reason: judgmentText.slice(0, 180) };
  }
  return {
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
    reason: judgment.reason ?? ""
  };
}

const scored = recall.questions.filter((question) => !question.excluded);
const outPath = join(repo, "eval/project-memory/runs", `${arm}-answer.json`);
const done = new Map();
try {
  const previous = JSON.parse(readFileSync(outPath, "utf8"));
  for (const item of previous.questions ?? []) {
    if (item.id !== "q21" && item.answer) done.set(item.id, item);
  }
} catch { /* first run */ }
const results = [...done.values()];
for (const question of scored) {
  if (done.has(question.id)) continue;
  process.stderr.write(`${arm} ${question.id}\n`);
  const item = await one(question);
  results.push(item);
  const passedNow = results.filter((row) => row.passed).length;
  writeFileSync(outPath, `${JSON.stringify({
    arm,
    method: "memmy-model-answer",
    model: env.MODEL,
    questionCount: scored.length,
    excluded: ["q21"],
    passed: passedNow,
    accuracy: passedNow / scored.length,
    questions: results
  }, null, 2)}\n`);
}
const passed = results.filter((item) => item.passed).length;
process.stdout.write(`${arm} answer ${passed}/${scored.length} ${(passed / scored.length * 100).toFixed(1)}%\n`);

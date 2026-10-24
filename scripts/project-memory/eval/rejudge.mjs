// Re-judge (optionally re-answer) single questions in a Memmy-answer result file.
// Usage: node rejudge.mjs <runs file name> [--reanswer] <qid>...
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const file = args.shift();
const reanswer = args[0] === "--reanswer" ? Boolean(args.shift()) : false;
const ids = new Set(args);
if (!file || ids.size === 0) throw new Error("usage: rejudge.mjs <file> [--reanswer] <qid>...");

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const path = join(repo, "eval/project-memory/runs", file);
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
const judgeSystem = "你是评测裁判。只返回 JSON：{\"pass\":true或false,\"errorType\":\"empty|superseded|ambiguous|wrong_project|other|none\",\"reason\":\"一句话\"}。pass 为 true 时 errorType 用 none。答错时：empty 是召回空或答不出；superseded 是把已经过时的说法当成现行；ambiguous 是几条相似信息没有选；wrong_project 是用了另一个项目的说法；其余用 other。pass 为 true 的条件是：回答体现每一条现行要点，并且没有把任一陷阱说法当成现行事实。";

async function chat(messages) {
  let lastError = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: env.MODEL, messages }),
        signal: AbortSignal.timeout(90_000)
      });
      const text = await response.text();
      if (response.ok) return JSON.parse(text).choices?.[0]?.message?.content ?? "";
      lastError = `http ${response.status} ${text.slice(0, 180)}`;
      if (response.status !== 429 && response.status !== 502 && response.status !== 503) break;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 8000 * (attempt + 1)));
  }
  throw new Error(lastError);
}

const report = JSON.parse(readFileSync(path, "utf8"));
for (const item of report.questions) {
  if (!ids.has(item.id)) continue;
  if (reanswer) {
    if (!item.answerPrompt) throw new Error(`${item.id} has no answerPrompt to re-answer`);
    item.answer = await chat(item.answerPrompt);
  }
  const judgePrompt = [
    { role: "system", content: judgeSystem },
    { role: "user", content: JSON.stringify({
      question: item.question,
      mustInclude: item.mustInclude,
      mustNotInclude: item.mustNotInclude,
      answer: item.answer
    }) }
  ];
  const judgmentText = await chat(judgePrompt);
  let judgment;
  try {
    judgment = JSON.parse(judgmentText.replace(/^```json\s*|```$/g, "").trim());
  } catch {
    judgment = { pass: false, errorType: "other", reason: judgmentText.slice(0, 180) };
  }
  Object.assign(item, {
    judgePrompt,
    judgmentText,
    passed: judgment.pass === true,
    errorType: judgment.pass === true ? "none" : (judgment.errorType || "other"),
    reason: judgment.reason ?? "",
    rejudged: reanswer ? "answer+judge" : "judge"
  });
  process.stdout.write(`${file} ${item.id} ${item.passed ? "pass" : "fail"} ${item.errorType} ${item.reason.slice(0, 60)}\n`);
}
report.passed = report.questions.filter((item) => item.passed).length;
report.accuracy = report.passed / report.questions.length;
if ("helped" in report) {
  report.helped = report.questions.filter((item) => item.passed && item.basePassed === false).map((item) => item.id);
  report.hurt = report.questions.filter((item) => !item.passed && item.basePassed === true).map((item) => item.id);
}
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${file} passed ${report.passed}/${report.questions.length}\n`);

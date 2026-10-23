import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dataset = join(dirname(fileURLToPath(import.meta.url)), "../../../eval/project-memory/dataset");
const outPath = join(dataset, "todolists.json");
const corpus = JSON.parse(readFileSync(join(dataset, "corpus.json"), "utf8"));
const pending = corpus.traces.filter((trace) => trace.needsTodolist).map((trace) => ({
  traceId: trace.id,
  query: trace.query
}));

const env = readEnv();
const model = env.MODEL ?? "";

function writeUngenerated(httpStatus) {
  writeFileSync(outPath, `${JSON.stringify({
    todolistStatus: "ungenerated",
    model,
    httpStatus,
    items: []
  }, null, 2)}\n`);
}

if (!env.OPENAI_API_BASE || !env.OPENAI_API_KEY || !model) {
  writeUngenerated(null);
  process.stderr.write("todolist ungenerated: model env incomplete\n");
  process.exit(1);
}

const response = await fetch(`${env.OPENAI_API_BASE.replace(/\/$/, "")}/chat/completions`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${env.OPENAI_API_KEY}`
  },
  body: JSON.stringify({
    model,
    messages: [
      {
        role: "system",
        content: "把每条用户任务拆成待办。每条至少两项。只返回 JSON：{\"items\":[{\"traceId\":\"...\",\"todos\":[{\"text\":\"...\",\"status\":\"pending\"}]}] }。status 只能是 pending、in_progress、completed、cancelled。不要写检查点区间，不要写工具调用。"
      },
      { role: "user", content: JSON.stringify(pending) }
    ]
  })
}).catch(() => null);

if (!response) {
  writeUngenerated(null);
  process.stderr.write("todolist ungenerated: request failed\n");
  process.exit(1);
}

if (!response.ok) {
  const detail = (await response.text()).replace(/sk-[A-Za-z0-9_-]+/g, "sk-redacted").slice(0, 400);
  writeUngenerated(response.status);
  process.stderr.write(`todolist ungenerated: http ${response.status} ${detail}\n`);
  process.exit(1);
}

const body = await response.json();
const text = body.choices?.[0]?.message?.content ?? "";
const parsed = JSON.parse(String(text).replace(/^```json\s*|```$/g, ""));
const items = Array.isArray(parsed.items) ? parsed.items : [];
const allowed = new Set(["pending", "in_progress", "completed", "cancelled"]);
const complete = pending.every((trace) => {
  const item = items.find((row) => row.traceId === trace.traceId);
  return Array.isArray(item?.todos)
    && item.todos.length >= 2
    && item.todos.every((todo) => typeof todo.text === "string" && todo.text.trim() && allowed.has(todo.status));
});
if (!complete) {
  writeUngenerated(response.status);
  process.stderr.write("todolist ungenerated: model output incomplete\n");
  process.exit(1);
}

writeFileSync(outPath, `${JSON.stringify({
  todolistStatus: "generated",
  model,
  httpStatus: response.status,
  items: pending.map((trace) => {
    const item = items.find((row) => row.traceId === trace.traceId);
    return {
      traceId: trace.traceId,
      todos: item.todos.map((todo) => ({ text: todo.text.trim(), status: todo.status }))
    };
  })
}, null, 2)}\n`);
process.stdout.write(`todolist generated ${pending.length}\n`);

function readEnv() {
  return Object.fromEntries(
    readFileSync(join(homedir(), ".env"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

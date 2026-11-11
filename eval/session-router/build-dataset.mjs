#!/usr/bin/env node
// Build a session-router dataset from Cursor agent transcripts.
// Within each conversation, turns stay in file order. Conversations are then
// round-robin interleaved, so order inside a conversation is kept and the
// global stream is not a strict timeline merge.
import { createReadStream, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "/Users/junfengran/.cursor/projects";
const TURNS_PER_CONVERSATION = 4;
const QUERY_CHARS = 700;
const ANSWER_CHARS = 280;
const SOURCES = [
  ["memmy-agent", "Users-junfengran-repos-memmy-agent", "97cf4aac"],
  ["MemOS", "Users-junfengran-repos-MemOS", "015583eb"],
  ["hindsight", "Users-junfengran-git-repos-hindsight", "73fe86ec"],
  ["TencentDB", "Users-junfengran-repos-TencentDB-Agent-Memory", "71c36740"],
  ["Hy-Memory", "Users-junfengran-git-repos-Hy-Memory", "209a462f"],
  ["weekly", "Users-junfengran-chat", "dc6b879b"],
];
const SKIP_PREFIXES = [
  "Briefly inform the user about the task result",
  "Implement the plan as specified",
];

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "runs");
const outFile = join(outDir, "dataset.json");

function redact(value) {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-REDACTED")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer REDACTED")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=REDACTED");
}

function clip(value, max) {
  const text = redact(value).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function skipQuery(query) {
  if (SKIP_PREFIXES.some((prefix) => query.startsWith(prefix))) return true;
  // A bare credential pasted into a query. URLs and file paths contain slashes, so they stay.
  return /(?:^|\s)(?!https?:)[A-Za-z0-9+/_=-]{28,}(?=\s|$)/.test(query);
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function userTurn(text) {
  const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (!query) return null;
  const at = text.match(/<timestamp>(.*?)<\/timestamp>/);
  return { at: at?.[1]?.trim() ?? "", query: query[1].trim() };
}

async function readTurns(file) {
  const turns = [];
  let pending = null;
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.role === "user") {
      if (pending && turns.length < TURNS_PER_CONVERSATION) turns.push({ ...pending, answer: pending.answer ?? "" });
      const parsed = userTurn(textOf(obj.message));
      pending = parsed && !skipQuery(parsed.query) ? parsed : null;
      if (turns.length >= TURNS_PER_CONVERSATION) break;
      continue;
    }
    if (obj.role === "assistant" && pending && !pending.answer) {
      const answer = textOf(obj.message).trim();
      if (answer) pending.answer = answer;
    }
  }
  if (pending && turns.length < TURNS_PER_CONVERSATION) turns.push({ ...pending, answer: pending.answer ?? "" });
  return turns.slice(0, TURNS_PER_CONVERSATION);
}

function findTranscript(projectDir, stem) {
  const dir = join(ROOT, projectDir, "agent-transcripts");
  const match = readdirSync(dir).find((name) => name.startsWith(stem));
  if (!match) throw new Error(`no transcript starting with ${stem} in ${dir}`);
  return join(dir, match, `${match}.jsonl`);
}

const conversations = [];
for (const [project, dir, stem] of SOURCES) {
  const file = findTranscript(dir, stem);
  const turns = await readTurns(file);
  if (!turns.length) throw new Error(`no user turns in ${file}`);
  conversations.push({
    gold: `${project}:${stem}`,
    project,
    turns: turns.map((turn) => ({
      at: turn.at,
      query: clip(turn.query, QUERY_CHARS),
      answer: clip(turn.answer, ANSWER_CHARS),
    })),
  });
}

const stream = [];
const max = Math.max(...conversations.map((item) => item.turns.length));
for (let index = 0; index < max; index += 1) {
  for (const conversation of conversations) {
    const turn = conversation.turns[index];
    if (!turn) continue;
    stream.push({
      id: `t${String(stream.length + 1).padStart(2, "0")}`,
      gold: conversation.gold,
      project: conversation.project,
      at: turn.at,
      query: turn.query,
      answer: turn.answer,
    });
  }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, `${JSON.stringify({
  order: "round-robin across conversations; each conversation keeps file order",
  turnsPerConversation: TURNS_PER_CONVERSATION,
  turns: stream,
}, null, 2)}\n`);

for (const turn of stream) {
  console.log(`${turn.id} ${turn.project} ${turn.query.slice(0, 72)}`);
}
console.log(`wrote ${stream.length} turns to ${outFile}`);

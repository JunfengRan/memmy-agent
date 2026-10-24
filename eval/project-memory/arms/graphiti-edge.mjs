/**
 * Graphiti fact edges, in the project-memory eval slot.
 * Graphiti has no attribute tree. A memory is an edge with valid_at, and a later
 * contradicting edge sets the earlier edge's invalid_at to the new valid_at.
 * The model only chooses which open edges contradict the new fact. Code applies
 * the timestamp. Invalid edges are omitted, and their text is removed from flat recall.
 * group_id is the project. Other projects stay out.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const METHOD = "graphiti-temporal-edge";

const FILE_PATTERN = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|\b[\w.-]+\.[A-Za-z0-9]+\b/g;
const CORRECTION = /改为|改成|改口|不再|不要再|不是|不把|不写|不用|换成|纠正|取代|撤回|instead\b|rather than|no longer/i;

let calls = 0;
let chain = Promise.resolve();
const judged = new Map();

export function modelCalls() {
  return calls;
}

export function renderAttributeTree(records, query, _round, sessionProject = null) {
  const view = viewOf(recordsFromMemories(records).map((record, index) => ({ ...record, id: `e${index}`, invalidAt: null })), query, sessionProject);
  return render(view.open, query);
}

export async function controlRecall(recall, records, query, round, sessionProject = null) {
  const normalized = recordsFromMemories(records);
  const edges = await enqueue(() => replay(normalized));
  const view = viewOf(edges, query, sessionProject);
  const rendered = render(view.open, query);
  const kept = view.open.map((edge) => edge.text).join("\n");
  const stripped = strip(recall, view.closed.map((edge) => edge.text), view.outside, kept);
  return `${rendered}\n${stripped}`;
}

function enqueue(work) {
  const run = chain.then(work, work);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function replay(records) {
  const edges = [];
  for (const record of records) {
    const edge = { ...record, id: `e${edges.length}`, invalidAt: null };
    const open = edges.filter((item) => item.invalidAt === null && item.project === record.project);
    const keys = await contradictingKeys(open, edge);
    for (const key of keys) {
      const previous = open.find((item) => edgeKey(item) === key);
      if (previous) previous.invalidAt = record.at;
    }
    edges.push(edge);
  }
  return edges;
}

async function contradictingKeys(open, edge) {
  const cacheKey = `${edgeKey(edge)}|${open.map(edgeKey).join(",")}`;
  if (judged.has(cacheKey)) return judged.get(cacheKey);
  let keys = [];
  if (CORRECTION.test(edge.text)) keys = fallbackInvalidate(open, edge);
  const relevant = open.filter((item) => !item.file || !edge.file || item.file === edge.file).slice(-8);
  if (process.env.MEMMY_ATTR_TREE_OFFLINE !== "1" && relevant.length > 0 && CORRECTION.test(edge.text)) {
    const picked = await judge(relevant, edge);
    if (picked) keys = picked;
  }
  const known = new Set(open.map(edgeKey));
  const result = keys.filter((key) => known.has(key));
  judged.set(cacheKey, result);
  return result;
}

function fallbackInvalidate(open, edge) {
  if (!CORRECTION.test(edge.text)) return [];
  const mine = new Set(tokens(edge.text));
  return open.filter((item) => {
    if (item.file && edge.file && item.file !== edge.file) return false;
    const shared = tokens(item.text).filter((token) => mine.has(token));
    return shared.length >= 2;
  }).map(edgeKey);
}

async function judge(open, edge) {
  const facts = open.slice(-40).map((item) => ({
    id: edgeKey(item),
    file: item.file,
    kind: item.kind,
    text: clip(item.text, 240)
  }));
  const prompt = [
    "你在维护 Graphiti 的事实边。一条事实有生效时间。只有新事实和旧事实说法冲突时，旧事实才失效。",
    "同一文件后来又被改过，但两句话可以同时成立时，不要让旧事实失效。",
    `已生效事实：${JSON.stringify(facts)}`,
    `新事实：${JSON.stringify({ file: edge.file, kind: edge.kind, text: clip(edge.text, 400) })}`,
    '只返回 JSON：{"invalidate":["id"]}'
  ].join("\n");
  const raw = await chat(prompt);
  if (!raw) return null;
  try {
    const ids = JSON.parse(raw.replace(/^```json\s*|```$/g, "").trim()).invalidate;
    return Array.isArray(ids) ? ids.map(String) : null;
  } catch {
    return null;
  }
}

function viewOf(edges, query, sessionProject) {
  const records = edges;
  const project = resolveProject(records, query, sessionProject);
  const inScope = (record) => record.project === "global" || (project !== null && record.project === project);
  return {
    open: edges.filter((edge) => edge.invalidAt === null && inScope(edge)),
    closed: edges.filter((edge) => edge.invalidAt !== null && inScope(edge)),
    outside: edges.filter((edge) => !inScope(edge)).map((edge) => edge.text)
  };
}

function render(edges, query) {
  const ranked = [...edges].sort((left, right) => overlap(query, right.text) - overlap(query, left.text) || String(right.at).localeCompare(String(left.at)));
  const lines = ranked.map((edge) => `- ${lineKey(edge)} valid_at=${edge.at}: ${edge.agent} ${edge.text}`);
  return [`<attribute_tree method="graphiti">`, ...lines, "</attribute_tree>"].join("\n");
}

function edgeKey(record) {
  return `${record.at}|${record.project}|${record.file}|${record.kind}|${record.text.slice(0, 80)}`;
}

function recordsFromMemories(rows) {
  const records = [];
  for (const row of rows ?? []) {
    if (row?.info?.duplicate_of) continue;
    const text = String(row?.text ?? row?.memoryValue ?? "").replace(/[ \t]+/g, " ").trim();
    if (!text) continue;
    const project = projectName(row);
    const agent = String(row.agent || "unknown");
    const at = String(row.at || row.updatedAt || "");
    const files = filesIn(row, text);
    for (const kind of kindsFor(row, text, files)) {
      const targets = files.length > 0 ? files : [""];
      for (const file of targets) records.push({ project, file, kind, agent, at, text });
    }
  }
  return records.sort((left, right) => left.at.localeCompare(right.at) || left.text.localeCompare(right.text) || lineKey(left).localeCompare(lineKey(right)));
}

function lineKey(record) {
  const project = `project/${record.project}`;
  if (!record.file) return `${project}/${record.kind}`;
  return `${project}/module/${moduleOf(record.file)}/file/${record.file}/${record.kind}`;
}

function kindsFor(row, text, files) {
  const stored = String(row.kind || row.memoryKind || "");
  if (stored === "decision" || stored === "convention" || stored === "recent_edit") return [stored];
  if (row.layer === "L2" || stored === "policy") return ["decision"];
  if (stored === "work_memory") return ["convention"];
  const kinds = [];
  if (/chose|决定|coefficient|cap is \d+/i.test(text)) kinds.push("decision");
  if (/约定|convention|return Task|stores return/i.test(text)) kinds.push("convention");
  if (kinds.length === 0 || /edited|改了|改动/i.test(text) || files.length > 0) kinds.push("recent_edit");
  return [...new Set(kinds)];
}

function projectName(row) {
  if (row.project === "global" || row.projectName === "global") return "global";
  if (row.info?.memory_scope === "global" && !row.project && !row.projectName) return "global";
  const name = row.project ?? row.projectName;
  return typeof name === "string" && name.trim() ? name.trim() : "global";
}

function filesIn(row, text) {
  const found = [];
  const add = (file) => {
    const normalized = String(file || "").trim().replace(/^\.\//, "");
    if (!normalized || normalized.includes("://") || found.includes(normalized)) return;
    found.push(normalized);
  };
  if (typeof row.file === "string") add(row.file);
  for (const file of row.changedFiles ?? row.info?.changed_files ?? []) add(file);
  for (const file of text.match(FILE_PATTERN) ?? []) add(file);
  return found.filter((file) => !found.some((other) => other !== file && other.endsWith(`/${file}`)));
}

function resolveProject(records, query, sessionProject) {
  const files = queryFiles(query);
  const named = namedProjects(records, query);
  const fileHits = records.filter((record) => files.some((file) => fileMatches(record.file, file)));
  if (fileHits.length > 0) {
    const projects = [...new Set(fileHits.map((record) => record.project))];
    const namedHit = projects.find((item) => named.includes(item));
    if (namedHit) return namedHit;
    if (sessionProject && projects.includes(sessionProject)) return sessionProject;
    if (projects.length === 1) return projects[0];
  } else if (named.length === 1) return named[0];
  else if (sessionProject && (named.length === 0 || named.includes(sessionProject))) return sessionProject;
  return sessionProject ?? null;
}

function namedProjects(records, query) {
  const names = [...new Set(records.map((record) => record.project).filter((project) => project && project !== "global"))];
  return names.filter((project) => new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(project)}(?:$|[^A-Za-z0-9_])`).test(query));
}

function queryFiles(query) {
  return [...new Set(String(query).match(FILE_PATTERN) ?? [])].filter((file) => !file.includes("://"));
}

function fileMatches(recordFile, queryFile) {
  if (!recordFile || !queryFile) return false;
  const stored = recordFile.replace(/^\.\//, "");
  const asked = queryFile.replace(/^\.\//, "");
  if (stored === asked || stored.endsWith(`/${asked}`) || asked.endsWith(`/${stored}`)) return true;
  return !asked.includes("/") && stored.split("/").pop() === asked;
}

function moduleOf(file) {
  return file.split("/")[0] || "root";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function overlap(query, text) {
  const words = new Set(tokens(query));
  return tokens(text).filter((token) => words.has(token)).length;
}

function tokens(value) {
  return String(value).toLowerCase().match(/[a-z0-9_./]{2,}|[\u4e00-\u9fff]{2}/g) ?? [];
}

function clip(value, limit) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function pieces(text) {
  return String(text).split(/[。\n；;]+/).map((item) => item.trim()).filter((item) => item.length >= 12);
}

function strip(recall, deadTexts, outsideTexts, kept) {
  let out = String(recall ?? "");
  for (const text of [...deadTexts, ...outsideTexts]) {
    for (const piece of pieces(text)) {
      if (kept.includes(piece)) continue;
      out = out.split(piece).join("");
    }
  }
  return out;
}

async function chat(prompt) {
  const env = loadEnv();
  if (!env.OPENAI_API_KEY || !env.OPENAI_API_BASE || !env.MODEL) return "";
  const base = String(env.OPENAI_API_BASE).replace(/\/$/, "");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: env.MODEL,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" }
        }),
        signal: AbortSignal.timeout(60_000)
      });
      const text = await response.text();
      if (!response.ok) continue;
      calls += 1;
      process.stderr.write(`[graphiti tree] call ${calls}\n`);
      return JSON.parse(text).choices?.[0]?.message?.content ?? "";
    } catch {
      /* try once more, then fall back to the rule */
    }
  }
  return "";
}

function loadEnv() {
  try {
    return Object.fromEntries(
      readFileSync(join(homedir(), ".env"), "utf8")
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
    );
  } catch {
    return {};
  }
}

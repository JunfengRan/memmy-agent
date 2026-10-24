/**
 * MemOS profile attribute tree, in the project-memory eval slot.
 * MemOS Enterprise keeps this in process_profile_memory.py. Open-source MemOS does not.
 * The template is project / module / file / kind. A leaf updates only when the model
 * says so, then _strict_merge_values rules apply in code:
 * objective leaves (decision, recent_edit) stay put unless the new memory explicitly
 * corrects them; descriptive leaves (convention) keep both sides; a locked leaf
 * (algorithm_updatable false) is never written. No key is invented by the model.
 * Other projects are outside this cube. Closed leaf text is removed from flat recall.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const METHOD = "memos-profile-leaf-merge";

const OBJECTIVE = new Set(["decision", "recent_edit"]);
const FILE_PATTERN = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|\b[\w.-]+\.[A-Za-z0-9]+\b/g;
const CORRECTION = /改为|改成|改口|不再|不要再|不是|不把|不写|不用|换成|纠正|取代|撤回|instead\b|rather than|no longer/i;

let calls = 0;
let chain = Promise.resolve();
const decisions = new Map();

export function modelCalls() {
  return calls;
}

export function renderAttributeTree(records, query, _round, sessionProject = null) {
  const view = viewOf(recordsFromMemories(records), query, sessionProject);
  return render(view.leaves, query);
}

export async function controlRecall(recall, records, query, round, sessionProject = null) {
  const normalized = recordsFromMemories(records);
  const state = await enqueue(() => replay(normalized));
  const view = viewOf(normalized, query, sessionProject, state.leaves);
  view.dead.push(...state.rejected);
  const rendered = render(view.leaves, query);
  const kept = view.leaves.map((leaf) => leaf.value).join("\n");
  const stripped = strip(recall, view.dead, view.outside, kept);
  return `${rendered}\n${stripped}`;
}

function enqueue(work) {
  const run = chain.then(work, work);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function replay(records) {
  const leaves = new Map();
  const rejected = [];
  for (const record of records) {
    const key = lineKey(record);
    const leaf = leaves.get(key) ?? {
      key,
      value: "",
      at: "",
      agent: "",
      objective: OBJECTIVE.has(record.kind),
      locked: false,
      superseded: []
    };
    if (record.locked || leaf.locked) {
      if (!leaf.value) assign(leaf, record);
      leaf.locked = true;
      leaves.set(key, leaf);
      continue;
    }
    const action = await actionFor(leaf, record);
    if (action === "merge" && record.text) {
      if (leaf.value && !leaf.value.includes(record.text)) leaf.value = `${leaf.value}\n${record.text}`;
      else if (!leaf.value) leaf.value = record.text;
      leaf.at = record.at;
      leaf.agent = record.agent;
    } else if (action === "replace") {
      if (leaf.value && leaf.value !== record.text) leaf.superseded.push(leaf.value);
      assign(leaf, record);
    } else if (leaf.value) {
      rejected.push(record.text);
    } else {
      assign(leaf, record);
    }
    leaves.set(key, leaf);
  }
  return { leaves, rejected };
}

function assign(leaf, record) {
  leaf.value = record.text;
  leaf.at = record.at;
  leaf.agent = record.agent;
}

async function actionFor(leaf, record) {
  const cacheKey = `${record.at}|${record.project}|${record.file}|${record.kind}|${record.text}`;
  if (decisions.has(cacheKey)) return decisions.get(cacheKey);
  let action = fallbackAction(leaf, record);
  if (process.env.MEMMY_ATTR_TREE_OFFLINE !== "1" && leaf.value && action === "replace") {
    const judged = await judge(leaf, record);
    if (judged) action = judged;
  }
  decisions.set(cacheKey, action);
  return action;
}

function fallbackAction(leaf, record) {
  if (!leaf.value) return "replace";
  if (record.kind === "convention") return "merge";
  return CORRECTION.test(record.text) ? "replace" : "keep";
}

async function judge(leaf, record) {
  const prompt = [
    "你在维护一棵固定模板的属性树。不要复述原文，不要发明路径。",
    "客观叶子（decision、recent_edit）已有值时，只有新记忆明确更正这一叶子才替换，否则保持。",
    "描述叶子（convention）如果新旧冲突，两边都保留。",
    `叶子路径：${leaf.key}`,
    `叶子种类：${record.kind}`,
    `当前值：${clip(leaf.value, 500)}`,
    `新记忆：${clip(record.text, 700)}`,
    '只返回 JSON：{"action":"replace"|"keep"|"merge"}'
  ].join("\n");
  const raw = await chat(prompt);
  if (!raw) return null;
  try {
    const action = JSON.parse(raw.replace(/^```json\s*|```$/g, "").trim()).action;
    return action === "replace" || action === "keep" || action === "merge" ? action : null;
  } catch {
    return null;
  }
}

function viewOf(records, query, sessionProject, leaves = null) {
  const built = leaves ?? new Map();
  const project = resolveProject(records, query, sessionProject);
  const inScope = (record) => record.project === "global" || (project !== null && record.project === project);
  const visible = [];
  const dead = [];
  for (const leaf of built.values()) {
    const record = records.find((item) => lineKey(item) === leaf.key);
    const scoped = record ? inScope(record) : leaf.key.startsWith(`project/${project}/`) || leaf.key.startsWith("project/global/");
    if (!scoped || !leaf.value) {
      dead.push(...leaf.superseded, leaf.value);
      continue;
    }
    visible.push(leaf);
    dead.push(...leaf.superseded);
  }
  const outside = records.filter((record) => !inScope(record)).map((record) => record.text);
  return { leaves: visible, dead, outside };
}

function render(leaves, query) {
  const ranked = [...leaves].sort((left, right) => overlap(query, right.value) - overlap(query, left.value) || String(right.at).localeCompare(String(left.at)));
  const lines = ranked.map((leaf) => `- ${leaf.key}: ${leaf.agent} ${leaf.at} ${leaf.value}`);
  return [`<attribute_tree method="memos">`, ...lines, "</attribute_tree>"].join("\n");
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
    const locked = row.info?.algorithm_updatable === false;
    for (const kind of kindsFor(row, text, files)) {
      const targets = files.length > 0 ? files : [""];
      for (const file of targets) records.push({ project, file, kind, agent, at, text, locked });
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
      process.stderr.write(`[memos tree] call ${calls}\n`);
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

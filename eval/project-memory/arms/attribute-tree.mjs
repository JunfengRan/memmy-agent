/**
 * Read-time project attribute tree. Recall scoring stays on the original Memmy path.
 * Rounds only change grain, path match, and how much text is injected.
 * round 1: project nodes, 280 characters
 * round 2: module nodes, 700 characters
 * round 3: file nodes plus ancestors, 1400 characters
 */

const ROUND = {
  1: { grain: "project", budget: 280 },
  2: { grain: "module", budget: 700 },
  3: { grain: "file", budget: 1400 }
};

const FILE_PATTERN = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|\b[\w.-]+\.[A-Za-z0-9]+\b/g;

export function recordsFromMemories(rows) {
  const records = [];
  for (const row of rows ?? []) {
    if (row?.info?.duplicate_of) continue;
    const text = String(row?.text ?? row?.memoryValue ?? "").replace(/\s+/g, " ").trim();
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
  return records;
}

export function renderAttributeTree(records, query, round, sessionProject = null) {
  const spec = ROUND[round] ?? ROUND[3];
  const selected = selectRecords(recordsFromMemories(records), query, spec.grain, sessionProject);
  const lines = renderLines(selected, spec.grain);
  let used = 0;
  const kept = [];
  for (const line of lines) {
    if (used + line.length > spec.budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return [`<attribute_tree round="${round}">`, ...kept, "</attribute_tree>"].join("\n");
}

export function controlRecall(recall, records, query, round, sessionProject = null) {
  return `${renderAttributeTree(records, query, round, sessionProject)}\n${recall}`;
}

function projectName(row) {
  if (row.project === "global" || row.projectName === "global") return "global";
  if (row.info?.memory_scope === "global" && !row.project && !row.projectName) return "global";
  const name = row.project ?? row.projectName;
  return typeof name === "string" && name.trim() ? name.trim() : "global";
}

function kindsFor(row, text, files) {
  const stored = String(row.kind || row.memoryKind || "");
  if (row.layer === "L2" || stored === "policy") return ["decision"];
  if (stored === "work_memory") return ["convention"];
  const kinds = [];
  if (/chose|决定|coefficient|cap is \d+/i.test(text)) kinds.push("decision");
  if (/约定|convention|return Task|stores return/i.test(text)) kinds.push("convention");
  if (kinds.length === 0 || /edited|改了|改动/i.test(text) || files.length > 0) kinds.push("recent_edit");
  return [...new Set(kinds)];
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
  return found;
}

function selectRecords(records, query, grain, sessionProject) {
  const files = queryFiles(query);
  const named = namedProjects(records, query);
  const fileHits = records.filter((record) => files.some((file) => fileMatches(record.file, file)));
  let project = null;
  if (fileHits.length > 0) {
    const projects = [...new Set(fileHits.map((record) => record.project))];
    const namedHit = projects.find((item) => named.includes(item));
    if (namedHit) project = namedHit;
    else if (sessionProject && projects.includes(sessionProject)) project = sessionProject;
    else if (projects.length === 1) project = projects[0];
  } else if (named.length === 1) {
    project = named[0];
  } else if (sessionProject && (named.length === 0 || named.includes(sessionProject))) {
    project = sessionProject;
  }
  const inScope = records.filter((record) => record.project === "global" || (project !== null && record.project === project));
  if (grain === "project" || files.length === 0) return inScope;
  if (grain === "module") {
    const modules = new Set(files.map(moduleOf));
    return inScope.filter((record) => !record.file || modules.has(moduleOf(record.file)) || record.kind !== "recent_edit");
  }
  return inScope.filter((record) => {
    if (record.project === "global" || !record.file) return true;
    if (files.some((file) => fileMatches(record.file, file))) return true;
    if (record.kind === "decision" || record.kind === "convention") {
      return files.some((file) => moduleOf(file) === moduleOf(record.file));
    }
    return false;
  });
}

function renderLines(records, grain) {
  const sorted = [...records].sort((left, right) => String(right.at).localeCompare(String(left.at)) || left.text.localeCompare(right.text));
  const seen = new Set();
  const lines = [];
  const push = (key, record) => {
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(`- ${key}: ${record.agent} ${record.text}`);
  };
  for (const record of sorted) push(lineKey(record, grain), record);
  for (const record of sorted) push(`agent/${record.agent}/last_session`, record);
  return lines;
}

function lineKey(record, grain) {
  const kind = record.kind || "recent_edit";
  const project = `project/${record.project}`;
  if (grain === "project" || !record.file) return `${project}/${kind}`;
  const module = `module/${moduleOf(record.file)}`;
  if (grain === "module") return `${project}/${module}/${kind}`;
  return `${project}/${module}/file/${record.file}/${kind}`;
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
  if (!file) return "root";
  return file.split("/")[0] || "root";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

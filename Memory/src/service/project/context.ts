const ACTIVITY_BUDGET = 800;

export interface ProjectActivityEvent {
  agent: string;
  at: string;
  summary: string;
  changedFiles: string[];
}

export function renderProjectActivity(input: {
  projectName: string;
  projectId: string;
  events: readonly ProjectActivityEvent[];
  decisions?: readonly string[];
  checkpoints?: readonly string[];
  topics?: readonly string[];
}): { markdown: string; activityCount: number; truncated: boolean } {
  const header = [
    `<memmy_project_context project="${escapeAttr(input.projectName)}" project_id="${escapeAttr(input.projectId)}">`,
    ...section("现行结论", input.decisions ?? []),
    ...section("检查点", input.checkpoints ?? []),
    ...section("事项", input.topics ?? []),
    "## 其他 Agent 最近做了什么"
  ];
  const lines: string[] = [];
  let used = 0;
  let truncated = false;
  for (const event of input.events) {
    const line = formatActivityLine(event);
    if (used + line.length + 1 > ACTIVITY_BUDGET) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (input.events.length > lines.length) truncated = true;
  const body = lines.length > 0 ? lines : ["- 还没有其他 Agent 的近期改动"];
  return {
    markdown: [...header, ...body, "</memmy_project_context>"].join("\n"),
    activityCount: lines.length,
    truncated
  };
}

export function formatActivityStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

export function displayAgent(agent: string | null | undefined): string {
  const value = agent?.trim() || "unknown";
  return value.includes(":") ? value : `${value}:main`;
}

export function activitySectionLength(markdown: string): number {
  const marker = "## 其他 Agent 最近做了什么";
  const start = markdown.indexOf(marker);
  const end = markdown.lastIndexOf("</memmy_project_context>");
  if (start < 0 || end < start) return markdown.length;
  return markdown.slice(start + marker.length, end).trim().length;
}

function section(title: string, lines: readonly string[]): string[] {
  const unique = [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
  if (unique.length === 0) return [];
  return [`## ${title}`, ...unique.slice(0, 8).map((line) => `- ${line}`)];
}

function formatActivityLine(event: ProjectActivityEvent): string {
  const files = event.changedFiles.length > 0 ? ` · ${event.changedFiles.join("、")}` : "";
  const summary = event.summary.trim() || "更新了项目";
  return `- [${displayAgent(event.agent)} · ${formatActivityStamp(event.at)}] ${summary}${files}`;
}

function escapeAttr(value: string): string {
  return value.replace(/[&"<>]/g, "");
}

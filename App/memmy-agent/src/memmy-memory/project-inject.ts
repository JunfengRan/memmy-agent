/**
 * Duplicated from Memory/src/service/project-memory/inject/render.ts and prompts/inject.ts.
 * memmy-agent does not import the Memory package. Keep the hint and the empty sentence identical.
 */
export const PROJECT_MEMORY_GUIDE_BODY = `当前任务属于项目「{space_name}」。成员共用一份按主题记下的项目记忆，内容是现状、已经确定的决策、可复用的经验和产出进展。

1. 会话开始附有 <project_index>，列出正在推进的主题。用户每次提问后，系统在 <memories> 里补上和本轮问题相关的主题。
2. <memories> 里的决策是成员已经确定的结论。按它做，不要向用户复述，也不要再问已经确定的事。
3. 标有「不一致」的决策还没有定论。本轮问题涉及它时，逐项列出各项结论和提出的成员，请用户确认以哪项为准；不涉及就不要提。
4. 用户本轮的结论和已有决策不同时，按用户的要求做，并说明它和哪条已有决策、哪位成员的结论不同。
5. 本轮 <memories> 没有覆盖、但又需要项目上下文时，调用 search_project_memory。每轮最多 2 次。
6. 项目记忆只记结论，不含讨论原文。{source_hint}`;

export const PROJECT_MEMORY_INDEX_LEAD = "当前会话所属空间里正在推进的主题如下。谈到具体内容时，当轮会再补上相关的决策和经验。";

export const PROJECT_MEMORY_TURN_CLOSING = "以上是指定空间和领域中已记下的内容，和本轮问题相关时采用。带有不一致结论的决策尚未确定：本轮问题涉及该决策时，列出各项结论及其成员，请用户确认以哪项为准；不涉及时不提及。";

export const PROJECT_MEMORY_DEGRADED_HINT = "本次检索有部分召回降级，结果可能不全；需要时换个说法再查一次。";

export const PROJECT_MEMORY_EMPTY_RESULT = "没有找到相关的项目记忆。";

export type MemosContextKind = "session" | "turn" | "tool";

export interface RenderEntry {
  content?: string;
  time?: string;
  user_ids?: string[];
  reason?: string | null;
  history?: RenderEntry[];
  conflicts?: RenderEntry[];
}

/** Search / get topic shape. Extra lists such as user_memory are not read. */
export interface RenderTopic {
  id?: string;
  space_id?: string;
  space_name?: string;
  domain?: string;
  topic_name?: string;
  topic_summary?: string;
  topic_description?: string;
  update_time?: string;
  decisions?: RenderEntry[];
  experiences?: RenderEntry[];
  timeline?: RenderEntry[];
}

export interface ProjectIndexGroup {
  spaceName: string;
  topics: readonly RenderTopic[];
}

export interface TurnRenderInput {
  kind: "turn" | "tool";
  topics?: readonly RenderTopic[];
  degraded?: readonly string[];
  spaceNames?: Readonly<Record<string, string>>;
  memberNames?: Readonly<Record<string, string>>;
  /** Character estimate (length / 4). Omitted means do not trim. */
  budgetTokens?: number;
}

const INDEX_LIMIT = 8;

/** Approximate token count used by the injection budget. Not a model tokenizer. */
export function estimateInjectTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function escapeInjectedMarkers(value: string): string {
  return value.replace(/<\/?(?:memos_context|project_index)/gi, (match) => `＜${match.slice(1)}`);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? escapeInjectedMarkers(value) : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

/** `YYYY-MM-DD` sliced from the time string. No timezone conversion. */
export function monthDay(time: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(time.trim());
  return match ? `${match[2]}/${match[3]}` : "";
}

function userIds(entry: RenderEntry): string[] {
  return Array.isArray(entry.user_ids) ? entry.user_ids.filter((id) => typeof id === "string" && id.length > 0) : [];
}

function memberLabel(ids: readonly string[], names: Readonly<Record<string, string>> | undefined): string {
  return ids.map((id) => textOf(names?.[id] || id)).join("、");
}

function dated(time: string, members: string, reason?: string | null): string {
  const day = monthDay(time);
  const when = day || time.trim();
  const reasonText = reason?.trim() ? `；原因：${escapeInjectedMarkers(reason.trim())}` : "";
  if (!when && !members) return reasonText ? `（${reasonText.slice(1)}）` : "";
  if (!members) return `（${when}${reasonText}）`;
  return `（${when}，${members}${reasonText}）`;
}

function compareTime(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface HistoryLine {
  content: string;
  time: string;
  members: string;
  reason: string | null;
}

interface DecisionView {
  content: string;
  time: string;
  members: string;
  conflicts: Array<{ content: string; time: string; members: string }>;
  history: HistoryLine[];
}

interface TopicView {
  updateTime: string;
  spaceName: string;
  topicName: string;
  domain: string;
  summary: string;
  description: string;
  decisions: DecisionView[];
  experiences: Array<{ content: string; time: string; members: string }>;
  timeline: Array<{ content: string; time: string; members: string }>;
}

function spaceLabel(topic: RenderTopic, names: Readonly<Record<string, string>> | undefined): string {
  if (topic.space_name?.trim()) return textOf(topic.space_name.trim());
  const id = topic.space_id?.trim() ?? "";
  if (id && names?.[id]) return textOf(names[id]);
  return textOf(id);
}

function historyLines(entry: RenderEntry, names: Readonly<Record<string, string>> | undefined): HistoryLine[] {
  const items = Array.isArray(entry.history) ? entry.history : [];
  return items.map((item, index) => ({
    index,
    content: textOf(item.content),
    time: typeof item.time === "string" ? item.time : "",
    members: memberLabel(userIds(item), names),
    reason: typeof item.reason === "string" ? item.reason : null
  })).sort((left, right) => compareTime(right.time, left.time) || right.index - left.index)
    .map(({ content, time, members, reason }) => ({ content, time, members, reason }));
}

function toTopic(topic: RenderTopic, names: Readonly<Record<string, string>> | undefined, memberNames: Readonly<Record<string, string>> | undefined): TopicView {
  const decisions = (topic.decisions ?? []).map((decision) => {
    const conflicts = (decision.conflicts ?? []).map((item, index) => ({
      index,
      content: textOf(item.content),
      time: typeof item.time === "string" ? item.time : "",
      members: memberLabel(userIds(item), memberNames)
    })).sort((left, right) => compareTime(left.time, right.time) || left.index - right.index);
    return {
      content: textOf(decision.content),
      time: typeof decision.time === "string" ? decision.time : "",
      members: memberLabel(userIds(decision), memberNames),
      conflicts: conflicts.map(({ content, time, members }) => ({ content, time, members })),
      history: historyLines(decision, memberNames)
    };
  });
  const experiences = (topic.experiences ?? []).map((item) => ({
    content: textOf(item.content),
    time: typeof item.time === "string" ? item.time : "",
    members: memberLabel(userIds(item), memberNames)
  }));
  const timeline = (topic.timeline ?? []).map((item) => ({
    content: textOf(item.content),
    time: typeof item.time === "string" ? item.time : "",
    members: memberLabel(userIds(item), memberNames)
  }));
  return {
    updateTime: typeof topic.update_time === "string" ? topic.update_time : "",
    spaceName: spaceLabel(topic, names),
    topicName: textOf(topic.topic_name) || textOf(topic.id),
    domain: textOf(topic.domain),
    summary: textOf(topic.topic_summary),
    description: textOf(topic.topic_description),
    decisions,
    experiences,
    timeline
  };
}

function line(content: string, time: string, members: string, reason?: string | null): string {
  const suffix = dated(time, members, reason);
  return suffix ? `${content}${suffix}` : content;
}

function renderTopics(topics: readonly TopicView[]): string {
  const blocks = topics.map((topic) => {
    const lines = [`-[${topic.updateTime}] ${topic.spaceName} · ${topic.topicName}`];
    if (topic.domain) lines.push(`      领域：${topic.domain}`);
    lines.push(`      摘要：${topic.summary}`);
    if (topic.description) lines.push(`      ${topic.description}`);
    if (topic.decisions.length > 0) {
      lines.push("      相关决策：");
      for (const decision of topic.decisions) {
        lines.push(`      - ${line(decision.content, decision.time, decision.members)}`);
        for (const conflict of decision.conflicts) {
          lines.push(`        不一致：${line(conflict.content, conflict.time, conflict.members)}`);
        }
        const shown = decision.history.slice(0, 2);
        for (const item of shown) {
          lines.push(`        此前：${line(item.content, item.time, item.members, item.reason)}`);
        }
        const older = decision.history.length - shown.length;
        if (older > 0) lines.push(`        另有 ${older} 次更早的变更`);
      }
    }
    if (topic.experiences.length > 0) {
      lines.push("      相关经验：");
      for (const item of topic.experiences) lines.push(`      - ${line(item.content, item.time, item.members)}`);
    }
    if (topic.timeline.length > 0) {
      lines.push("      相关进展：");
      for (const item of topic.timeline) lines.push(`      - ${line(item.content, item.time, item.members)}`);
    }
    return lines.join("\n");
  });
  return ["<memories>", "  <projects>", ...blocks, "  </projects>", "</memories>", PROJECT_MEMORY_TURN_CLOSING].join("\n");
}

function cloneTopics(topics: readonly TopicView[]): TopicView[] {
  return topics.map((topic) => ({
    ...topic,
    decisions: topic.decisions.map((decision) => ({
      ...decision,
      conflicts: decision.conflicts.map((item) => ({ ...item })),
      history: decision.history.map((item) => ({ ...item }))
    })),
    experiences: topic.experiences.map((item) => ({ ...item })),
    timeline: topic.timeline.map((item) => ({ ...item }))
  }));
}

function hasTimeline(topics: readonly TopicView[]): boolean {
  return topics.some((topic) => topic.timeline.length > 0);
}

function hasExperience(topics: readonly TopicView[]): boolean {
  return topics.some((topic) => topic.experiences.length > 0);
}

function hasCollapsedHistory(topics: readonly TopicView[]): boolean {
  return topics.some((topic) => topic.decisions.some((decision) => decision.history.length > 2));
}

function hasHistory(topics: readonly TopicView[]): boolean {
  return topics.some((topic) => topic.decisions.some((decision) => decision.history.length > 0));
}

/** Drop order: timeline, experience, older history, then topics from the end. */
function fitBudget(topics: TopicView[], budgetTokens: number, extra: string, kind: "turn" | "tool"): TopicView[] {
  const fits = (current: readonly TopicView[]) => estimateInjectTokens(renderTurnDocument(renderTopics(current), extra, kind)) <= budgetTokens;
  if (fits(topics)) return topics;
  if (hasTimeline(topics)) {
    for (const topic of topics) topic.timeline = [];
    return fitBudget(topics, budgetTokens, extra, kind);
  }
  if (hasExperience(topics)) {
    for (const topic of topics) topic.experiences = [];
    return fitBudget(topics, budgetTokens, extra, kind);
  }
  if (hasCollapsedHistory(topics)) {
    for (const topic of topics) {
      for (const decision of topic.decisions) {
        if (decision.history.length > 2) decision.history = decision.history.slice(0, 2);
      }
    }
    return fitBudget(topics, budgetTokens, extra, kind);
  }
  if (hasHistory(topics)) {
    for (const topic of topics) {
      for (const decision of topic.decisions) {
        if (decision.history.length > 0) {
          decision.history = decision.history.slice(0, -1);
          return fitBudget(topics, budgetTokens, extra, kind);
        }
      }
    }
  }
  if (topics.length > 1) {
    topics.pop();
    return fitBudget(topics, budgetTokens, extra, kind);
  }
  return topics;
}

function renderTurnDocument(body: string, extra: string, kind: "turn" | "tool"): string {
  const inner = [body, extra].filter(Boolean).join("\n");
  return wrapMemosContext(kind, inner);
}

export function wrapMemosContext(kind: MemosContextKind, body: string): string {
  return `<memos_context v="1" kind="${kind}">\n${body}\n</memos_context>`;
}

export function renderProjectGuide(input: { spaceName: string; sourceHint?: string }): string {
  const hint = input.sourceHint?.trim() ? escapeInjectedMarkers(input.sourceHint.trim()) : "";
  const body = PROJECT_MEMORY_GUIDE_BODY
    .replaceAll("{space_name}", escapeInjectedMarkers(input.spaceName))
    .replaceAll("{source_hint}", hint);
  return `<project_memory_guide>\n${body}\n</project_memory_guide>`;
}

function newestTimeline(topic: RenderTopic): RenderEntry | null {
  const items = topic.timeline ?? [];
  if (items.length === 0) return null;
  let best = items[0]!;
  let bestTime = typeof best.time === "string" ? best.time : "";
  for (let index = 1; index < items.length; index += 1) {
    const item = items[index]!;
    const time = typeof item.time === "string" ? item.time : "";
    if (compareTime(time, bestTime) > 0) {
      best = item;
      bestTime = time;
    }
  }
  return best;
}

export function renderProjectIndex(input: { groups: readonly ProjectIndexGroup[]; limit?: number }): string {
  const limit = input.limit ?? INDEX_LIMIT;
  const lines = [PROJECT_MEMORY_INDEX_LEAD];
  let remaining = limit;
  for (const group of input.groups) {
    if (remaining <= 0) break;
    lines.push(`■ ${escapeInjectedMarkers(group.spaceName)}`);
    for (const topic of group.topics) {
      if (remaining <= 0) break;
      remaining -= 1;
      const name = textOf(topic.topic_name) || textOf(topic.id);
      const summary = textOf(topic.topic_summary);
      lines.push(`- ${name}：${summary}`);
      const latest = newestTimeline(topic);
      if (!latest) continue;
      const content = textOf(latest.content);
      const time = typeof latest.time === "string" ? latest.time : "";
      const day = monthDay(time);
      lines.push(day ? `  最新进展（${day}）：${content}` : `  最新进展：${content}`);
    }
  }
  return `<project_index>\n${lines.join("\n")}\n</project_index>`;
}

export function renderSessionInjection(input: {
  spaceName: string;
  sourceHint?: string;
  groups: readonly ProjectIndexGroup[];
}): string {
  return wrapMemosContext("session", `${renderProjectGuide(input)}\n${renderProjectIndex({ groups: input.groups })}`);
}

function degradedHint(degraded: readonly string[] | undefined): string {
  return degraded && degraded.length > 0 ? PROJECT_MEMORY_DEGRADED_HINT : "";
}

/**
 * Template 3. `kind: "turn"` with no topics and no degraded returns null (Q-33).
 * A tool result always returns text.
 */
export function renderTurnMemories(input: TurnRenderInput): string | null {
  const hint = degradedHint(input.degraded);
  const topics = input.topics ?? [];
  if (topics.length === 0) {
    if (input.kind === "turn") {
      return hint ? wrapMemosContext("turn", hint) : null;
    }
    const body = [PROJECT_MEMORY_EMPTY_RESULT, hint].filter(Boolean).join("\n");
    return wrapMemosContext("tool", body);
  }
  let views = topics.map((topic) => toTopic(topic, input.spaceNames, input.memberNames));
  if (input.budgetTokens !== undefined) views = fitBudget(cloneTopics(views), input.budgetTokens, hint, input.kind);
  const inner = [renderTopics(views), hint].filter(Boolean).join("\n");
  return wrapMemosContext(input.kind, inner);
}

export function renderDomainInvalid(unregistered: readonly string[], available: readonly string[]): string {
  const missing = unregistered.map((item) => escapeInjectedMarkers(item)).join("、") || "（无）";
  const known = available.map((item) => escapeInjectedMarkers(item)).join("、") || "（无）";
  return wrapMemosContext("tool", `未登记的领域：${missing}\n可用领域：${known}`);
}

function domainInvalidLists(payload: unknown): { unregistered: string[]; available: string[] } | null {
  const root = asRecord(payload);
  if (!root) return null;
  const data = asRecord(root.data) ?? root;
  const invalid = root.message === "DOMAIN_INVALID" || root.code === 40002;
  if (!invalid) return null;
  return { unregistered: stringList(data.domains), available: stringList(data.available_domains) };
}

export function projectPayloadView(payload: unknown): { topics: RenderTopic[]; degraded: string[] } {
  const root = asRecord(payload) ?? {};
  const data = asRecord(root.data) ?? root;
  const topics = Array.isArray(data.topic_detail_list)
    ? data.topic_detail_list.filter((item): item is RenderTopic => Boolean(asRecord(item)))
    : [];
  const degraded = Array.isArray(data.degraded) ? data.degraded.filter((item): item is string => typeof item === "string") : [];
  return { topics, degraded };
}

/** Template 3 inside `kind="tool"`, or the domain error text. */
export function renderToolResult(payload: unknown, options: Omit<TurnRenderInput, "kind" | "topics" | "degraded"> = {}): string {
  const invalid = domainInvalidLists(payload);
  if (invalid) return renderDomainInvalid(invalid.unregistered, invalid.available);
  const view = projectPayloadView(payload);
  return renderTurnMemories({ kind: "tool", topics: view.topics, degraded: view.degraded, ...options }) ?? wrapMemosContext("tool", PROJECT_MEMORY_EMPTY_RESULT);
}

/** Tool HTTP errors only. A normal search body is not an error. */
export function renderDomainInvalidError(error: unknown): string | null {
  const body = error && typeof error === "object" && "body" in error
    ? (error as { body?: unknown }).body
    : null;
  if (!domainInvalidLists(body)) return null;
  return renderToolResult(body);
}

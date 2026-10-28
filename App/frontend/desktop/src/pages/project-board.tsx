import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ProjectTopic } from "@memmy/local-api-contracts";
import { BookOpen, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, Folder, GanttChart, LayoutDashboard, Lightbulb, Link2, Loader2, MessageSquare, MoreHorizontal, PanelRight, Pencil, Plus, PlugZap, Search, Sparkles, TriangleAlert, Trash2, Users, X } from "lucide-react";
import { z } from "zod";
import { requestJson } from "../api/http.js";
import type { MemmyAgentProject, ProjectBoard } from "../api/memmy-agent-client.js";
import type { MemoryRuntimeClient } from "../api/memory-runtime-client.js";
import { useApiClients } from "../app/providers.js";
import { useTranslation } from "../i18n/use-translation.js";
import type { AgentTaskView } from "../state/agent-chat-slice.js";
import { agentSourceDisplayName, agentSourceLogoUrl } from "./agent-source-logos.js";
import { memoryDisplaySource } from "./memory/memory-display.js";
import "./project-board.css";
import { openProjectBoard, useProjectBoardSession } from "./project-board-session.js";

const EMPTY_BOARD: ProjectBoard = {
  instruction: "",
  knowledgeBaseIds: [],
  skillIds: [],
  connectorIds: [],
  citations: []
};

const MENTION_LIMIT = 8;
const SOURCE_PREVIEW_LIMIT = 3;
const SKILL_PAGE_LIMIT = 25;
const NARROW_BOARD_WIDTH = 860;

const CONNECTORS: NamedItem[] = [
  { id: "email", name: "邮箱", detail: "读取邮件与附件" },
  { id: "slack", name: "Slack", detail: "搜索频道与消息" },
  { id: "github", name: "GitHub", detail: "访问 issue、PR 与代码" },
  { id: "dingtalk", name: "钉钉", detail: "读取文档、群聊与日程" }
];

const KnowledgeSettingsSchema = z.object({
  bases: z.array(z.object({ id: z.string(), name: z.string() })).default([])
}).passthrough();

export interface BoardMention {
  kind: "session" | "knowledge" | "skill";
  id: string;
  label: string;
  detail?: string;
}

/** Names sent with a project task as `project_refs`; the gateway adds the board instruction itself. */
export interface ProjectRefs {
  knowledge: string[];
  skills: string[];
  sessions: string[];
}

export type ProjectProgressView = "board" | "timeline" | "calendar";

export interface ProjectTimelineRow {
  topic: ProjectTopic;
  status: "active" | "waiting" | "done";
  inferred: boolean;
  firstTime?: string;
  lastTime?: string;
  milestones: Array<{ id: string; text: string; time: string; agent?: string }>;
}

export interface ProjectCalendarEvent {
  id: string;
  date: string;
  title: string;
  text: string;
  topicId: string;
  agent?: string;
}

export interface ProjectProgressSnapshot {
  activeSessions: number;
  itemCount: number;
  agentCount: number;
  conflictCount: number;
  lastActivity?: string;
  rows: ProjectTimelineRow[];
  calendar: ProjectCalendarEvent[];
}

type LinkKind = "knowledge" | "skills" | "connectors";
type NamedItem = { id: string; name: string; detail?: string };

export function projectRefs(input: {
  knowledgeNames: readonly string[];
  skillNames: readonly string[];
  citedTitles?: readonly string[];
}): ProjectRefs | null {
  const refs = {
    knowledge: unique(input.knowledgeNames),
    skills: unique(input.skillNames),
    sessions: unique(input.citedTitles ?? [])
  };
  return refs.knowledge.length || refs.skills.length || refs.sessions.length ? refs : null;
}

export function matchingProjectTopic<T extends { name: string; summary?: string }>(draft: string, topics: readonly T[]): T | null {
  const text = draft.trim();
  if (text.length < 2) return null;
  const byName = topics.find((topic) => topic.name.length >= 2 && text.includes(topic.name));
  if (byName) return byName;
  return [...topics]
    .filter((topic) => (topic.summary?.length ?? 0) >= 2 && text.includes(topic.summary ?? ""))
    .sort((left, right) => (right.summary?.length ?? 0) - (left.summary?.length ?? 0))[0] ?? null;
}

export function topicsForBoard<T extends { name: string; updatedAt: string }>(topics: readonly T[]): T[] {
  return [...topics].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name));
}

export function latestTopicEvent<T extends { text: string; time?: string }>(topic: { events: readonly T[] }): T | null {
  return topic.events.at(-1) ?? null;
}

export function latestTopicProgress(topic: { events: readonly { text: string }[] }): string {
  return topic.events.at(-1)?.text ?? "";
}

export function projectProgressSnapshot(topics: readonly ProjectTopic[], tasks: readonly AgentTaskView[]): ProjectProgressSnapshot {
  const rows = topicsForBoard(topics).map((topic) => {
    const times = topic.events.map((event) => event.time).filter((time): time is string => Boolean(time)).sort();
    const latest = latestTopicEvent(topic);
    const text = `${topic.summary} ${latest?.text ?? ""}`.toLocaleLowerCase();
    const done = /完成|已解决|done|complete|merged|released/.test(text);
    const waiting = /等待|阻塞|blocked|pending|待确认|分歧/.test(text);
    return {
      topic,
      status: done ? "done" : waiting ? "waiting" : "active",
      inferred: !done && !waiting,
      ...(times.length > 0 ? { firstTime: times[0], lastTime: times.at(-1) } : {}),
      milestones: topic.events.filter((event): event is typeof event & { time: string } => Boolean(event.time)).map((event) => ({
        id: event.id,
        text: event.text,
        time: event.time,
        ...(event.agent ? { agent: event.agent } : {})
      }))
    } satisfies ProjectTimelineRow;
  });
  const calendar = rows.flatMap((row) => row.milestones.map((event) => ({
    id: event.id,
    date: event.time.slice(0, 10),
    title: row.topic.name,
    text: event.text,
    topicId: row.topic.id,
    ...(event.agent ? { agent: event.agent } : {})
  })));
  const agents = unique([
    ...topics.flatMap((topic) => topic.agents ?? []),
    ...tasks.map((task) => task.sourceAgent ?? "memmy")
  ]);
  const lastActivity = [...calendar.map((event) => event.date), ...tasks.map((task) => task.updatedAt ?? "")].sort().at(-1);
  return {
    activeSessions: tasks.filter((task) => Boolean(task.runStartedAt)).length,
    itemCount: topics.length,
    agentCount: agents.length,
    conflictCount: topics.reduce((count, topic) => count + topic.conflicts.length, 0),
    ...(lastActivity ? { lastActivity } : {}),
    rows,
    calendar: calendar.sort((left, right) => right.date.localeCompare(left.date))
  };
}

export function mentionQuery(draft: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(draft);
  return match ? match[1] ?? "" : null;
}

export function draftWithoutMentionQuery(draft: string): string {
  return draft.replace(/(^|\s)@[^\s@]*$/, "$1").trimEnd();
}

export function mentionChoices(input: {
  query: string;
  tasks: readonly AgentTaskView[];
  allTasks?: readonly AgentTaskView[];
  projectId?: string;
  knowledgeBases: readonly NamedItem[];
  skills: readonly NamedItem[];
}): { sessions: BoardMention[]; projectSessions: BoardMention[]; otherSessions: BoardMention[]; knowledge: BoardMention[]; skills: BoardMention[] } {
  const query = input.query.trim().toLocaleLowerCase();
  const matches = (label: string) => !query || label.toLocaleLowerCase().includes(query);
  const projectSessions = input.tasks.filter((task) => matches(task.title)).slice(0, MENTION_LIMIT)
    .map((task) => ({ kind: "session" as const, id: task.sessionKey, label: task.title }));
  const allTasks = input.allTasks ?? input.tasks;
  const otherSessions = input.projectId ? allTasks
    .filter((task) => task.projectId != null && task.groupProjectId !== input.projectId && task.projectId !== input.projectId)
    .filter((task) => matches(task.title))
    .slice(0, MENTION_LIMIT)
    .map((task) => ({ kind: "session" as const, id: task.sessionKey, label: task.title })) : [];
  return {
    sessions: projectSessions,
    projectSessions,
    otherSessions,
    knowledge: input.knowledgeBases
      .filter((item) => matches(item.name))
      .slice(0, MENTION_LIMIT)
      .map((item) => ({ kind: "knowledge", id: item.id, label: item.name })),
    skills: input.skills
      .filter((item) => matches(item.name))
      .slice(0, MENTION_LIMIT)
      .map((item) => ({ kind: "skill", id: item.id, label: item.name, ...(item.detail ? { detail: item.detail } : {}) }))
  };
}

/** Lists every activated skill, labelled with its source agent so same-named skills stay distinguishable. */
export async function loadSkillChoices(client: Pick<MemoryRuntimeClient, "listPanelItems">): Promise<NamedItem[]> {
  const items: NamedItem[] = [];
  for (let page = 1; page <= SKILL_PAGE_LIMIT; page += 1) {
    const result = await client.listPanelItems({ layer: "Skill", status: "activated", page });
    for (const item of result.items) {
      const source = memoryDisplaySource(item);
      items.push({ id: item.id, name: item.title, detail: source === "unknown" ? undefined : agentSourceDisplayName(source) });
    }
    if (!result.hasNext) break;
  }
  return items.sort((left, right) => left.name.localeCompare(right.name) || (left.detail ?? "").localeCompare(right.detail ?? ""));
}

export function citationLinks(
  citations: readonly { fromSessionKey: string; toSessionKey: string }[],
  sessionKey: string
): { outgoing: string[]; incoming: string[] } {
  return {
    outgoing: unique(citations.filter((item) => item.fromSessionKey === sessionKey).map((item) => item.toSessionKey)),
    incoming: unique(citations
      .filter((item) => item.toSessionKey === sessionKey && item.fromSessionKey !== sessionKey)
      .map((item) => item.fromSessionKey))
  };
}

/** Records that `fromSessionKey` cites each of `toSessionKeys`; returns the same board when nothing is new. */
export function withSessionCitations(board: ProjectBoard, fromSessionKey: string, toSessionKeys: readonly string[]): ProjectBoard {
  const added = unique(toSessionKeys)
    .filter((toSessionKey) => toSessionKey !== fromSessionKey)
    .filter((toSessionKey) => !board.citations.some((item) => item.fromSessionKey === fromSessionKey && item.toSessionKey === toSessionKey))
    .map((toSessionKey) => ({ fromSessionKey, toSessionKey }));
  return added.length === 0 ? board : { ...board, citations: [...board.citations, ...added] };
}

export function addMention(mentions: readonly BoardMention[], mention: BoardMention): BoardMention[] {
  return mentions.some((item) => item.kind === mention.kind && item.id === mention.id) ? [...mentions] : [...mentions, mention];
}

export async function loadProjectRefs(
  clients: NonNullable<ReturnType<typeof useApiClients>["clients"]>,
  projectId: string,
  extras?: { knowledgeNames?: string[]; skillNames?: string[]; citedTitles?: string[] }
): Promise<ProjectRefs | null> {
  const board = await clients.memmyAgent.readProjectBoard(projectId);
  const [knowledgeNames, skillNames] = await Promise.all([
    lookupKnowledgeNames(clients, board.knowledgeBaseIds),
    lookupSkillNames(clients, board.skillIds)
  ]);
  return projectRefs({
    knowledgeNames: [...knowledgeNames, ...(extras?.knowledgeNames ?? [])],
    skillNames: [...skillNames, ...(extras?.skillNames ?? [])],
    citedTitles: extras?.citedTitles ?? []
  });
}

export function ProjectBoardPage(props: {
  project: MemmyAgentProject;
  tasks: AgentTaskView[];
  allTasks?: AgentTaskView[];
  draft: string;
  onDraftChange: (value: string) => void;
  mentions: BoardMention[];
  onMentionsChange: (mentions: BoardMention[]) => void;
  onOpenTask: (task: AgentTaskView) => void;
  onDeleteTask?: (task: AgentTaskView) => Promise<void> | void;
  renderComposer: (chips: ReactNode) => ReactNode;
}) {
  const { clients } = useApiClients();
  const session = useProjectBoardSession();
  const [tab, setTab] = useState<"progress" | "sessions" | "items">(session.topicId ? "items" : "progress");
  const [topics, setTopics] = useState<ProjectTopic[]>([]);
  const [board, setBoard] = useState<ProjectBoard>(EMPTY_BOARD);
  const [knowledgeBases, setKnowledgeBases] = useState<NamedItem[]>([]);
  const [skills, setSkills] = useState<NamedItem[]>([]);
  const [configOpen, setConfigOpen] = useState<boolean | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [dismissedTopicId, setDismissedTopicId] = useState<string | null>(null);
  const [previewTask, setPreviewTask] = useState<AgentTaskView | null>(null);

  useEffect(() => {
    if (session.topicId) setTab("items");
  }, [session.topicId]);

  useEffect(() => {
    if (!clients) return;
    let cancelled = false;
    void clients.memmyAgent.readProjectBoard(props.project.id).then((next) => {
      if (!cancelled) setBoard(next);
    }).catch(() => undefined);
    void clients.memoryRuntime.listProjectTopics(props.project.rootPath).then((result) => {
      if (!cancelled) setTopics(result.topics);
    }).catch(() => {
      if (!cancelled) setTopics([]);
    });
    void requestJson({
      config: clients.runtimeConfig,
      path: "/api/knowledge/settings",
      schema: KnowledgeSettingsSchema
    }).then((settings) => {
      if (!cancelled) setKnowledgeBases(settings.bases);
    }).catch(() => undefined);
    void loadSkillChoices(clients.memoryRuntime).then((items) => {
      if (!cancelled) setSkills(items);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [clients, props.project.id, props.project.rootPath]);

  async function saveBoard(next: ProjectBoard): Promise<boolean> {
    if (!clients) return false;
    const previous = board;
    setBoard(next);
    try {
      setBoard(await clients.memmyAgent.saveProjectBoard(props.project.id, next));
      setSaveFailed(false);
      return true;
    } catch {
      setBoard(previous);
      setSaveFailed(true);
      return false;
    }
  }

  async function deleteTopic(topic: ProjectTopic): Promise<void> {
    if (clients && topic.memoryIds.length > 0) {
      await Promise.allSettled(topic.memoryIds.map((id) => clients.memoryRuntime.deleteMemory(id)));
    }
    setTopics((current) => current.filter((item) => item.id !== topic.id));
    if (session.topicId === topic.id) openProjectBoard(props.project.id, null);
  }

  const match = matchingProjectTopic(props.draft, topics);
  return (
    <>
      <ProjectBoardView
      projectName={props.project.name}
      projectId={props.project.id}
      tasks={props.tasks}
      allTasks={props.allTasks ?? props.tasks}
      topics={topics}
      board={board}
      knowledgeBases={knowledgeBases}
      skills={skills}
      tab={tab}
      selectedTopic={topics.find((topic) => topic.id === session.topicId) ?? null}
      draft={props.draft}
      mentions={props.mentions}
      match={match && match.id !== dismissedTopicId ? match : null}
      configOpen={configOpen}
      saveFailed={saveFailed}
      onTab={(next) => {
        setTab(next);
        if (session.topicId) openProjectBoard(props.project.id, null);
      }}
      onSelectTopic={(topicId) => {
        setTab("items");
        openProjectBoard(props.project.id, topicId);
      }}
      onOpenTask={(task) => setPreviewTask(task)}
      onDeleteTask={props.onDeleteTask}
      onDeleteTopic={deleteTopic}
      onInsertMention={(mention) => {
        props.onMentionsChange(addMention(props.mentions, mention));
        if (mentionQuery(props.draft) !== null) props.onDraftChange(draftWithoutMentionQuery(props.draft));
      }}
      onRemoveMention={(mention) => props.onMentionsChange(props.mentions.filter((item) => item.kind !== mention.kind || item.id !== mention.id))}
      onCloseMentions={() => props.onDraftChange(draftWithoutMentionQuery(props.draft))}
      onCiteTopic={(topic) => {
        const task = sourceTaskForTopic(topic, props.tasks);
        if (task) props.onMentionsChange(addMention(props.mentions, { kind: "session", id: task.sessionKey, label: task.title }));
        setDismissedTopicId(topic.id);
      }}
      onSaveBoard={saveBoard}
      onToggleConfig={setConfigOpen}
      renderComposer={props.renderComposer}
      />
      {previewTask ? (
      <SessionPreviewDialog
        task={previewTask}
        onClose={() => setPreviewTask(null)}
        onOpen={() => {
          setPreviewTask(null);
          props.onOpenTask(previewTask);
        }}
      />
      ) : null}
    </>
  );
}

export function ProjectBoardView(props: {
  projectName: string;
  projectId?: string;
  tasks: AgentTaskView[];
  allTasks?: AgentTaskView[];
  topics: ProjectTopic[];
  board: ProjectBoard;
  knowledgeBases: NamedItem[];
  skills: NamedItem[];
  tab: "progress" | "sessions" | "items";
  selectedTopic: ProjectTopic | null;
  draft: string;
  mentions: BoardMention[];
  match: ProjectTopic | null;
  /** `null` follows the board width: open when wide, closed when narrow. */
  configOpen: boolean | null;
  saveFailed?: boolean;
  onTab: (tab: "progress" | "sessions" | "items") => void;
  onSelectTopic: (topicId: string | null) => void;
  onOpenTask: (task: AgentTaskView) => void;
  onDeleteTask?: (task: AgentTaskView) => Promise<void> | void;
  onDeleteTopic?: (topic: ProjectTopic) => Promise<void> | void;
  onInsertMention: (mention: BoardMention) => void;
  onRemoveMention: (mention: BoardMention) => void;
  onCloseMentions: () => void;
  onCiteTopic: (topic: ProjectTopic) => void;
  onSaveBoard: (board: ProjectBoard) => Promise<boolean>;
  onToggleConfig: (open: boolean) => void;
  renderComposer: (chips: ReactNode) => ReactNode;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLElement>(null);
  const narrow = useNarrowBoard(rootRef);
  const sessions = [...props.tasks].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  const topics = topicsForBoard(props.topics);
  const query = mentionQuery(props.draft);
  const [agentFilter, setAgentFilter] = useState<string>("");
  const [listQuery, setListQuery] = useState("");
  const [deleteTopic, setDeleteTopic] = useState<ProjectTopic | null>(null);
  const topicAgents = (topic: ProjectTopic): string[] => topic.agents?.length
    ? topic.agents
    : unique(topic.sourceSessionIds.map((id) => props.tasks.find((task) => task.sessionKey === id)?.sourceAgent ?? "memmy"));
  const agentOptions = unique([
    ...props.tasks.map((task) => task.sourceAgent ?? "memmy"),
    ...topics.flatMap((topic) => topic.agents ?? [])
  ]);
  const filteredSessions = sessions.filter((task) =>
    (!agentFilter || (task.sourceAgent ?? "memmy") === agentFilter)
    && (!listQuery.trim() || `${task.title} ${task.preview}`.toLocaleLowerCase().includes(listQuery.trim().toLocaleLowerCase()))
  );
  const filteredTopics = topics.filter((topic) =>
    (!agentFilter || topicAgents(topic).includes(agentFilter))
    && (!listQuery.trim() || `${topic.name} ${topic.summary} ${latestTopicProgress(topic)}`.toLocaleLowerCase().includes(listQuery.trim().toLocaleLowerCase()))
  );
  const choices = query === null ? null : mentionChoices({
    query,
    tasks: props.tasks,
    allTasks: props.allTasks ?? props.tasks,
    projectId: props.projectId,
    knowledgeBases: props.knowledgeBases,
    skills: props.skills
  });
  const chips = props.mentions.length > 0 ? (
    <div className="project-board__chips">
      {props.mentions.map((mention) => (
        <span key={`${mention.kind}:${mention.id}`} className="project-board__chip">
          <MentionIcon kind={mention.kind} />
          <span className="project-board__chip-label">{mention.label}</span>
          <button type="button" className="project-board__chip-remove" aria-label={t("projectBoard.removeItem", { name: mention.label })} onClick={() => props.onRemoveMention(mention)}>
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  ) : null;
  const configOpen = props.configOpen ?? !narrow;
  const toggleConfig = () => props.onToggleConfig(!configOpen);

  return (
    <section ref={rootRef} className={`project-board${narrow ? " is-narrow" : ""}`} aria-label={t("projectBoard.title")}>
      <div className="project-board__main">
        {props.selectedTopic ? (
          <TopicDetail
            projectName={props.projectName}
            topic={props.selectedTopic}
            tasks={props.tasks}
            onBack={() => props.onSelectTopic(null)}
            onOpenTask={props.onOpenTask}
          />
        ) : (
          <div className="project-board__scroll">
            <div className="project-board__wrap">
              <div className="project-board__head">
                <span className="project-board__icon" aria-hidden="true"><Folder size={22} strokeWidth={1.8} /></span>
                <h1 className="project-board__title">{props.projectName}</h1>
                {configOpen ? null : (
                  <button type="button" className="project-board__icon-button" aria-label={t("projectBoard.config")} title={t("projectBoard.config")} onClick={toggleConfig}>
                    <PanelRight size={18} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="project-board__tabs" role="tablist">
                <button type="button" role="tab" aria-selected={props.tab === "progress"} className={`project-board__tab${props.tab === "progress" ? " is-active" : ""}`} onClick={() => props.onTab("progress")}>{t("projectBoard.progress")}</button>
                <button type="button" role="tab" aria-selected={props.tab === "sessions"} className={`project-board__tab${props.tab === "sessions" ? " is-active" : ""}`} onClick={() => props.onTab("sessions")}>{t("projectBoard.sessions")}</button>
                <button type="button" role="tab" aria-selected={props.tab === "items"} className={`project-board__tab${props.tab === "items" ? " is-active" : ""}`} onClick={() => props.onTab("items")}>{t("projectBoard.items")}</button>
              </div>
              <BoardFilterBar
                agents={agentOptions}
                agent={agentFilter}
                query={listQuery}
                onAgentChange={setAgentFilter}
                onQueryChange={setListQuery}
              />
              {props.tab === "progress" ? (
                <ProjectProgressOverview
                  snapshot={projectProgressSnapshot(filteredTopics, filteredSessions)}
                  board={props.board}
                  tasks={filteredSessions}
                  onSelectTopic={props.onSelectTopic}
                  onOpenTask={props.onOpenTask}
                />
              ) : props.tab === "sessions" ? (
                filteredSessions.length === 0 ? (
                  <EmptyState title={t("projectBoard.emptySessions")} body={t("projectBoard.emptySessionsHint")} />
                ) : (
                  <div className="project-board__list">
                    {filteredSessions.map((task) => (
                      <SessionRow key={task.sessionKey} task={task} onOpen={props.onOpenTask} onDelete={props.onDeleteTask} onCite={() => props.onInsertMention({
                        kind: "session",
                        id: task.sessionKey,
                        label: task.title
                      })} />
                    ))}
                  </div>
                )
              ) : filteredTopics.length === 0 ? (
                <EmptyState title={t("projectBoard.emptyItems")} body={t("projectBoard.emptyItemsHint")} />
              ) : (
                <div className="project-board__list">
                  {filteredTopics.map((topic) => {
                    const latest = latestTopicEvent(topic);
                    return (
                      <div key={topic.id} className="project-board__row project-board__row--go">
                        <button type="button" className="project-board__row-open project-board__row-open--item" onClick={() => props.onSelectTopic(topic.id)}>
                        <span className="project-board__row-main">
                          <span className="project-board__row-title">{topic.name}</span>
                          {topic.summary ? <span className="project-board__row-text">{topic.summary}</span> : null}
                          {latest ? (
                            <span className="project-board__row-latest">
                              {latest.time
                                ? t("projectBoard.latestAt", { date: shortDate(latest.time), text: latest.text })
                                : t("projectBoard.latest", { text: latest.text })}
                            </span>
                          ) : null}
                        </span>
                        <ChevronRight size={16} className="project-board__row-chevron" aria-hidden="true" />
                        </button>
                        <button type="button" className="project-board__icon-button project-board__icon-button--sm project-board__item-delete" aria-label={t("common.delete")} title={t("common.delete")} onClick={() => setDeleteTopic(topic)}><Trash2 size={14} /></button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="project-board__composer">
          <div className="project-board__composer-column">
            {choices ? (
              <MentionMenu choices={choices} onPick={props.onInsertMention} onClose={props.onCloseMentions} />
            ) : null}
            {props.match && !choices ? (
              <TopicHint
                topic={props.match}
                canCite={Boolean(sourceTaskForTopic(props.match, props.tasks))}
                onView={() => props.onSelectTopic(props.match!.id)}
                onCite={() => props.onCiteTopic(props.match!)}
              />
            ) : null}
            {props.renderComposer(chips)}
          </div>
        </div>
      </div>
      {configOpen && narrow ? <div className="project-board__config-mask" onClick={toggleConfig} /> : null}
      {configOpen ? (
        <ConfigAside
          board={props.board}
          knowledgeBases={props.knowledgeBases}
          skills={props.skills}
          saveFailed={Boolean(props.saveFailed)}
          onSaveBoard={props.onSaveBoard}
          onClose={toggleConfig}
        />
      ) : null}
      {deleteTopic ? (
        <BoardDialog
          title={t("projectBoard.deleteItemTitle")}
          description={t("projectBoard.deleteItemDescription", { name: deleteTopic.name })}
          width={440}
          onClose={() => setDeleteTopic(null)}
          footer={(
            <>
              <button type="button" className="project-board__button project-board__button--ghost" onClick={() => setDeleteTopic(null)}>{t("projectBoard.cancel")}</button>
              <button type="button" className="project-board__button project-board__button--primary" onClick={() => {
                const topic = deleteTopic;
                setDeleteTopic(null);
                void props.onDeleteTopic?.(topic);
              }}>{t("common.delete")}</button>
            </>
          )}
        >
          <p className="project-board__dialog-copy">{t("projectBoard.deleteItemWarning")}</p>
        </BoardDialog>
      ) : null}
    </section>
  );
}

function ProjectProgressOverview(props: {
  snapshot: ProjectProgressSnapshot;
  board: ProjectBoard;
  tasks: AgentTaskView[];
  onSelectTopic: (topicId: string | null) => void;
  onOpenTask: (task: AgentTaskView) => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<ProjectProgressView>("board");
  const [scale, setScale] = useState<"week" | "month">("week");
  const statusLabel = (status: ProjectTimelineRow["status"]) => status === "done" ? t("projectBoard.progressDone") : status === "waiting" ? t("projectBoard.progressWaiting") : t("projectBoard.progressActive");
  const grouped = (status: ProjectTimelineRow["status"]) => props.snapshot.rows.filter((row) => row.status === status);
  const connectorItems = CONNECTORS.filter((item) => props.board.connectorIds.includes(item.id));
  return (
    <div className="project-progress">
      <div className="project-progress__metrics">
        <ProgressMetric icon={<Loader2 size={15} />} label={t("projectBoard.progressActiveSessions")} value={props.snapshot.activeSessions} />
        <ProgressMetric icon={<CheckCircle2 size={15} />} label={t("projectBoard.progressItems")} value={props.snapshot.itemCount} />
        <ProgressMetric icon={<Users size={15} />} label={t("projectBoard.progressAgents")} value={props.snapshot.agentCount} />
        <ProgressMetric icon={<TriangleAlert size={15} />} label={t("projectBoard.progressConflicts")} value={props.snapshot.conflictCount} />
      </div>
      <div className="project-progress__toolbar">
        <div className="project-progress__view-switcher" role="tablist">
          <button type="button" className={view === "board" ? "is-active" : ""} onClick={() => setView("board")}><LayoutDashboard size={14} />{t("projectBoard.progressBoard")}</button>
          <button type="button" className={view === "timeline" ? "is-active" : ""} onClick={() => setView("timeline")}><GanttChart size={14} />{t("projectBoard.progressTimeline")}</button>
          <button type="button" className={view === "calendar" ? "is-active" : ""} onClick={() => setView("calendar")}><CalendarDays size={14} />{t("projectBoard.progressCalendar")}</button>
        </div>
        {view === "timeline" ? <div className="project-progress__scale"><button type="button" className={scale === "week" ? "is-active" : ""} onClick={() => setScale("week")}>{t("projectBoard.progressWeek")}</button><button type="button" className={scale === "month" ? "is-active" : ""} onClick={() => setScale("month")}>{t("projectBoard.progressMonth")}</button></div> : null}
      </div>
      {view === "board" ? (
        <div className="project-progress__columns">
          {(["active", "waiting", "done"] as const).map((status) => (
            <section key={status} className="project-progress__column"><header><span>{statusLabel(status)}</span><b>{grouped(status).length}</b></header>{grouped(status).map((row) => <ProgressTopicCard key={row.topic.id} row={row} onSelect={() => props.onSelectTopic(row.topic.id)} />)}{grouped(status).length === 0 ? <p className="project-board__muted">{t("projectBoard.progressEmpty")}</p> : null}</section>
          ))}
        </div>
      ) : view === "timeline" ? (
        <div className={`project-progress__timeline project-progress__timeline--${scale}`}>
          {props.snapshot.rows.map((row) => <TimelineRow key={row.topic.id} row={row} onSelect={() => props.onSelectTopic(row.topic.id)} />)}
          {props.snapshot.rows.length === 0 ? <p className="project-board__muted">{t("projectBoard.progressEmpty")}</p> : null}
        </div>
      ) : (
        <div className="project-progress__calendar"><div className="project-progress__calendar-grid">{props.snapshot.calendar.map((event) => <button type="button" key={event.id} className="project-progress__calendar-event" onClick={() => props.onSelectTopic(event.topicId)}><small>{event.date}</small><strong>{event.title}</strong><span>{event.text}</span></button>)}{props.snapshot.calendar.length === 0 ? <p className="project-board__muted">{t("projectBoard.progressEmpty")}</p> : null}</div></div>
      )}
      <section className="project-progress__connectors"><header><span><PlugZap size={15} />{t("projectBoard.progressConnectors")}</span><small>{connectorItems.length ? t("projectBoard.progressConnected", { count: connectorItems.length }) : t("projectBoard.progressNoConnectors")}</small></header><div>{(connectorItems.length ? connectorItems : CONNECTORS).map((connector) => <span key={connector.id} className={`project-progress__connector ${connectorItems.some((item) => item.id === connector.id) ? "is-connected" : ""}`}><PlugZap size={13} /><b>{connector.name}</b><small>{connectorItems.some((item) => item.id === connector.id) ? t("projectBoard.progressConnectedShort") : t("projectBoard.progressAvailable")}</small></span>)}</div></section>
      {props.snapshot.lastActivity ? <p className="project-progress__last-update">{t("projectBoard.progressLastActivity", { date: shortDate(props.snapshot.lastActivity) })}</p> : null}
    </div>
  );
}

function ProgressMetric(props: { icon: ReactNode; label: string; value: number }) {
  return <div className="project-progress__metric"><span>{props.icon}</span><small>{props.label}</small><b>{props.value}</b></div>;
}

function ProgressTopicCard(props: { row: ProjectTimelineRow; onSelect: () => void }) {
  return <button type="button" className="project-progress__topic-card" onClick={props.onSelect}><strong>{props.row.topic.name}</strong><span>{props.row.topic.summary || latestTopicProgress(props.row.topic)}</span><small>{props.row.topic.agents?.join(" · ") || "memmy"}{props.row.inferred ? " · 推断状态" : ""}</small></button>;
}

function TimelineRow(props: { row: ProjectTimelineRow; onSelect: () => void }) {
  const { t } = useTranslation();
  return <button type="button" className="project-progress__timeline-row" onClick={props.onSelect}><span className="project-progress__timeline-label"><strong>{props.row.topic.name}</strong><small>{props.row.firstTime ? `${shortDate(props.row.firstTime)} — ${shortDate(props.row.lastTime ?? props.row.firstTime)}` : t("projectBoard.progressNoTime")}</small></span><span className="project-progress__timeline-track">{props.row.milestones.map((milestone) => <i key={milestone.id} title={milestone.text} style={{ left: `${timelinePosition(milestone.time, props.row.firstTime, props.row.lastTime)}%` }} />)}</span><span className="project-progress__timeline-agents">{unique(props.row.topic.agents ?? ["memmy"]).map((agent) => <em key={agent}>{agent.slice(0, 2).toUpperCase()}</em>)}</span></button>;
}

function timelinePosition(time: string, first?: string, last?: string): number {
  if (!first || !last || first === last) return 50;
  const start = Date.parse(first);
  const end = Date.parse(last);
  const current = Date.parse(time);
  return Math.max(2, Math.min(98, ((current - start) / Math.max(1, end - start)) * 96 + 2));
}

export function ProjectCitationPanel(props: {
  projectId: string;
  sessionKey: string;
  tasks: AgentTaskView[];
  onOpenSession: (task: AgentTaskView) => void;
  onClose: () => void;
}) {
  const { clients } = useApiClients();
  const [board, setBoard] = useState<ProjectBoard>(EMPTY_BOARD);
  useEffect(() => {
    if (!clients) return;
    let cancelled = false;
    void clients.memmyAgent.readProjectBoard(props.projectId).then((next) => {
      if (!cancelled) setBoard(next);
    }).catch(() => {
      if (!cancelled) setBoard(EMPTY_BOARD);
    });
    return () => {
      cancelled = true;
    };
  }, [clients, props.projectId, props.sessionKey]);
  return (
    <ProjectCitationPanelView
      citations={board.citations}
      sessionKey={props.sessionKey}
      tasks={props.tasks}
      onOpenSession={props.onOpenSession}
      onClose={props.onClose}
    />
  );
}

export function ProjectCitationPanelView(props: {
  citations: ProjectBoard["citations"];
  sessionKey: string;
  tasks: AgentTaskView[];
  onOpenSession: (task: AgentTaskView) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const links = citationLinks(props.citations, props.sessionKey);
  const current = props.tasks.find((task) => task.sessionKey === props.sessionKey);
  const row = (sessionKey: string) => {
    const task = props.tasks.find((item) => item.sessionKey === sessionKey);
    return (
      <button key={sessionKey} type="button" className="project-citation__row" disabled={!task} onClick={() => task && props.onOpenSession(task)}>
        <span className="project-citation__node" aria-hidden="true"><MessageSquare size={13} /></span>
        <span className="project-citation__row-main">
          <span className="project-citation__row-title">{task?.title ?? t("projectBoard.missingSession")}</span>
          {task ? <span className="project-citation__row-meta">{taskStatusText(task, t)}</span> : null}
        </span>
      </button>
    );
  };
  return (
    <aside className="project-citation-panel" aria-label={t("projectBoard.references")}>
      <div className="project-board__aside-head">
        <strong>{t("projectBoard.references")}</strong>
        <button type="button" className="project-board__icon-button" aria-label={t("common.close")} title={t("common.close")} onClick={props.onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="project-citation__body">
        {links.outgoing.length + links.incoming.length === 0 ? (
          <p className="project-board__muted">{t("projectBoard.noCitations")}</p>
        ) : (
          <div className="project-citation__lineage">
            {links.outgoing.length > 0 ? <div className="project-citation__label">{t("projectBoard.citedOutgoing")}</div> : null}
            {links.outgoing.map(row)}
            <div className="project-citation__current">
              <span className="project-citation__current-dot" aria-hidden="true"><i /></span>
              <span className="project-citation__current-box">
                <small>{t("projectBoard.thisSession")}</small>
                <b>{current?.title ?? ""}</b>
              </span>
            </div>
            {links.incoming.length > 0 ? <div className="project-citation__label">{t("projectBoard.citedIncoming")}</div> : null}
            {links.incoming.map(row)}
          </div>
        )}
      </div>
    </aside>
  );
}

export function ProjectTopicHint(props: {
  project: MemmyAgentProject | null;
  draft: string;
  onOpen: (projectId: string, topicId: string) => void;
}) {
  const { clients } = useApiClients();
  const [topics, setTopics] = useState<ProjectTopic[]>([]);
  useEffect(() => {
    if (!props.project || !clients) return;
    let cancelled = false;
    void clients.memoryRuntime.listProjectTopics(props.project.rootPath).then((result) => {
      if (!cancelled) setTopics(result.topics);
    }).catch(() => {
      if (!cancelled) setTopics([]);
    });
    return () => {
      cancelled = true;
    };
  }, [clients, props.project]);
  const match = props.project ? matchingProjectTopic(props.draft, topics) : null;
  if (!props.project || !match) return null;
  return <TopicHint topic={match} canCite={false} onView={() => props.onOpen(props.project!.id, match.id)} />;
}

function TopicHint(props: { topic: ProjectTopic; canCite: boolean; onView: () => void; onCite?: () => void }) {
  const { t } = useTranslation();
  const progress = latestTopicProgress(props.topic);
  return (
    <div className="project-topic-hint" role="status">
      <span className="project-topic-hint__icon" aria-hidden="true"><Sparkles size={13} /></span>
      <span className="project-topic-hint__text">
        {t("projectBoard.relatedPrefix")}<b>{props.topic.name}</b>
        {progress ? <span className="project-topic-hint__progress">{t("projectBoard.latest", { text: progress })}</span> : null}
      </span>
      <button type="button" className="project-board__button project-board__button--ghost" onClick={props.onView}>{t("projectBoard.openDetail")}</button>
      {props.canCite && props.onCite ? (
        <button type="button" className="project-board__button" onClick={props.onCite}>{t("projectBoard.cite")}</button>
      ) : null}
    </div>
  );
}

function MentionMenu(props: {
  choices: ReturnType<typeof mentionChoices>;
  onPick: (mention: BoardMention) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const total = props.choices.projectSessions.length + props.choices.otherSessions.length + props.choices.knowledge.length + props.choices.skills.length;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return (
    <div className="project-board__mention-menu" role="listbox" aria-label={t("projectBoard.references")}>
      <MentionGroup title={t("projectBoard.projectSessions")} items={props.choices.projectSessions} onPick={props.onPick} />
      <MentionGroup title={t("projectBoard.otherProjectSessions")} items={props.choices.otherSessions} onPick={props.onPick} />
      <MentionGroup title={t("projectBoard.knowledge")} items={props.choices.knowledge} onPick={props.onPick} />
      <MentionGroup title={t("projectBoard.skills")} items={props.choices.skills} onPick={props.onPick} />
      {total === 0 ? <p className="project-board__mention-empty">{t("projectBoard.mentionEmpty")}</p> : null}
    </div>
  );
}

function MentionGroup(props: {
  title: string;
  items: BoardMention[];
  onPick: (mention: BoardMention) => void;
}) {
  if (props.items.length === 0) return null;
  return (
    <div className="project-board__mention-group">
      <div className="project-board__mention-label">{props.title}</div>
      {props.items.map((item) => (
        <button
          key={`${item.kind}:${item.id}`}
          type="button"
          role="option"
          aria-selected={false}
          className="project-board__mention"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onPick(item)}
        >
          <span className="project-board__mini-icon" aria-hidden="true"><MentionIcon kind={item.kind} /></span>
          <span className="project-board__mention-text">{item.label}</span>
          {item.detail ? <span className="project-board__muted">{item.detail}</span> : null}
        </button>
      ))}
    </div>
  );
}

function AgentMark(props: { agent?: string }) {
  const agent = props.agent?.trim();
  if (!agent) return null;
  const name = agentSourceDisplayName(agent);
  const logo = agentSourceLogoUrl(agent);
  return (
    <span className="project-board__agent" title={name}>
      {logo ? <img src={logo} alt="" /> : null}
      <span>{name}</span>
    </span>
  );
}

function MentionIcon(props: { kind: BoardMention["kind"] }) {
  if (props.kind === "knowledge") return <BookOpen size={12} aria-hidden="true" />;
  if (props.kind === "skill") return <Sparkles size={12} aria-hidden="true" />;
  return <MessageSquare size={12} aria-hidden="true" />;
}

function SessionRow(props: {
  task: AgentTaskView;
  onOpen: (task: AgentTaskView) => void;
  onDelete?: (task: AgentTaskView) => Promise<void> | void;
  onCite: () => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpen]);
  const running = Boolean(props.task.runStartedAt);
  return (
    <div className={`project-board__row project-board__row--session${menuOpen ? " is-menu-open" : ""}`}>
      <button type="button" className="project-board__row-open" onClick={() => props.onOpen(props.task)}>
        <span className="project-board__session-icon" aria-hidden="true"><MessageSquare size={15} /></span>
        <span className="project-board__row-main">
          <span className="project-board__row-title project-board__row-title--sm">{props.task.title}</span>
          {props.task.preview && props.task.preview.trim() !== props.task.title.trim() ? <span className="project-board__row-text project-board__row-text--one">{props.task.preview}</span> : null}
        </span>
        <span className={`project-board__row-meta${running ? " is-live" : ""}`}>
          <AgentMark agent={props.task.sourceAgent ?? "memmy"} />
          {running ? <><span className="project-board__live-dot" aria-hidden="true" />{t("projectBoard.running")}</> : shortDate(props.task.updatedAt)}
        </span>
      </button>
      <span className="project-board__row-actions" onPointerDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="project-board__icon-button project-board__icon-button--sm"
          aria-label={t("projectBoard.more")}
          aria-expanded={menuOpen}
          title={t("projectBoard.more")}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MoreHorizontal size={15} aria-hidden="true" />
        </button>
        {menuOpen ? (
          <div className="project-board__menu" role="menu">
            <button type="button" role="menuitem" className="project-board__menu-item" onClick={() => {
              setMenuOpen(false);
              props.onCite();
            }}>{t("projectBoard.citeInChat")}</button>
            {props.onDelete ? <button type="button" role="menuitem" className="project-board__menu-item project-board__menu-item--danger" onClick={() => {
              setMenuOpen(false);
              void props.onDelete?.(props.task);
            }}>{t("common.delete")}</button> : null}
          </div>
        ) : null}
      </span>
    </div>
  );
}

function BoardFilterBar(props: {
  agents: string[];
  agent: string;
  query: string;
  onAgentChange: (value: string) => void;
  onQueryChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="project-board__filters">
      <label className="project-board__agent-filter">
        <select aria-label={t("projectBoard.allAgents")} value={props.agent} onChange={(event) => props.onAgentChange(event.target.value)}>
          <option value="">{t("projectBoard.allAgents")}</option>
          {props.agents.map((agent) => <option key={agent} value={agent}>{agentSourceDisplayName(agent)}</option>)}
        </select>
      </label>
      <label className="project-board__filter-search">
        <Search size={14} aria-hidden="true" />
        <input value={props.query} placeholder={t("projectBoard.searchSessionsAndItems")} aria-label={t("projectBoard.searchSessionsAndItems")} onChange={(event) => props.onQueryChange(event.target.value)} />
      </label>
    </div>
  );
}

function SessionPreviewDialog(props: { task: AgentTaskView; onClose: () => void; onOpen: () => void }) {
  const { clients } = useApiClients();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<unknown[]>([]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (!clients) return () => { cancelled = true; };
    void clients.memmyAgent.readWebuiThread(props.task.sessionKey).then((thread) => {
      if (!cancelled) setMessages(thread.messages);
    }).catch(() => {
      if (!cancelled) setMessages([]);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [clients, props.task.sessionKey]);
  const preview = previewMessages(messages);
  return (
    <BoardDialog
      title={props.task.title}
      description={<span className="project-board__preview-agent"><AgentMark agent={props.task.sourceAgent ?? "memmy"} /></span>}
      width={680}
      onClose={props.onClose}
      footer={(
        <>
          <button type="button" className="project-board__button project-board__button--ghost" onClick={props.onClose}>{t("projectBoard.cancel")}</button>
          <button type="button" className="project-board__button project-board__button--primary" onClick={props.onOpen}>{t("projectBoard.openSession")}</button>
        </>
      )}
    >
      {loading ? <div className="project-board__preview-loading"><Loader2 size={16} className="animate-spin" />{t("projectBoard.loadingPreview")}</div> : preview.length === 0 ? <p className="project-board__dialog-copy">{props.task.preview || t("projectBoard.previewEmpty")}</p> : (
        <div className="project-board__preview-list">
          {preview.map((item, index) => (
            <div key={`message:${index}`} className="project-board__preview-row project-board__preview-row--message">
              {item.text ? <><span className="project-board__preview-kind">{item.role === "user" ? t("projectBoard.question") : t("projectBoard.answer")}</span><span className="project-board__preview-message">{item.text}</span></> : null}
              {item.tools.map((tool, toolIndex) => (
                <details key={`${tool.name}:${toolIndex}`} className="project-board__preview-tool">
                  <summary><span className="project-board__preview-kind">{t("projectBoard.toolCall")}</span><span>{tool.name}</span></summary>
                  <div className="project-board__preview-tool-body">
                    {tool.input ? <pre><b>{t("projectBoard.toolInput")}</b>{tool.input}</pre> : null}
                    {tool.output ? <pre><b>{t("projectBoard.toolOutput")}</b>{tool.output}</pre> : null}
                  </div>
                </details>
              ))}
            </div>
          ))}
        </div>
      )}
    </BoardDialog>
  );
}

function previewMessages(messages: unknown[]): Array<{ role: string; text: string; tools: Array<{ name: string; input: string; output: string }> }> {
  const result: Array<{ role: string; text: string; tools: Array<{ name: string; input: string; output: string }> }> = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const role = typeof item.role === "string" ? item.role : typeof item.message_role === "string" ? item.message_role : "assistant";
    const content = typeof item.content === "string" ? item.content : typeof item.text === "string" ? item.text : typeof item.message === "string" ? item.message : "";
    const toolEvents = Array.isArray(item.tool_events) ? item.tool_events : Array.isArray(item.toolEvents) ? item.toolEvents : [];
    const tools: Array<{ name: string; input: string; output: string }> = [];
    for (const tool of toolEvents) {
      if (!tool || typeof tool !== "object") continue;
      const record = tool as Record<string, unknown>;
      const name = record.name;
      if (typeof name !== "string" || !name.trim()) continue;
      tools.push({
        name: name.trim(),
        input: compactPreviewValue(record.arguments ?? record.input ?? record.params),
        output: compactPreviewValue(record.result ?? record.output ?? record.error)
      });
    }
    if (!content.trim() && tools.length === 0) continue;
    result.push({ role, text: content.trim().slice(0, 1000), tools });
    if (result.length >= 12) break;
  }
  return result;
}

function compactPreviewValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, 1200);
  try {
    return JSON.stringify(value, null, 2).slice(0, 1200);
  } catch {
    return String(value).slice(0, 1200);
  }
}

function TopicDetail(props: {
  projectName: string;
  topic: ProjectTopic;
  tasks: AgentTaskView[];
  onBack: () => void;
  onOpenTask: (task: AgentTaskView) => void;
}) {
  const { t } = useTranslation();
  const [allSources, setAllSources] = useState(false);
  const timeline = [...props.topic.events].reverse();
  const sources = unique(props.topic.sourceSessionIds).filter((id) => props.tasks.some((task) => task.sessionKey === id));
  const shownSources = allSources ? sources : sources.slice(0, SOURCE_PREVIEW_LIMIT);
  return (
    <div className="project-board__detail">
      <div className="project-board__crumb">
        <button type="button" className="project-board__crumb-link" aria-label={t("projectBoard.backToProject", { name: props.projectName })} onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onBack();
        }}>
          <Folder size={14} aria-hidden="true" />{props.projectName}
        </button>
        <ChevronRight size={13} aria-hidden="true" />
        <b>{props.topic.name}</b>
      </div>
      <div className="project-board__scroll">
        <div className="project-board__wrap">
          <div className="project-topic__top">
            <h1 className="project-topic__title">{props.topic.name}</h1>
            <span className="project-topic__updated">{t("projectBoard.updatedAt", { date: shortDate(props.topic.updatedAt) })}</span>
          </div>
          {props.topic.summary ? (
            <div className="project-topic__summary"><b>{t("projectBoard.summary")}</b><span>{props.topic.summary}</span></div>
          ) : null}
          {(props.topic.agents?.length ?? 0) > 0 ? (
            <div className="project-topic__summary"><b>{t("projectBoard.participatingAgents")}</b><span className="project-topic__agents">{props.topic.agents.map((agent) => <AgentMark key={agent} agent={agent} />)}</span></div>
          ) : null}
          <div className="project-topic__grid">
            <div>
              {props.topic.description.trim() ? (
                <TopicSection title={t("projectBoard.description")}><p className="project-topic__text">{props.topic.description}</p></TopicSection>
              ) : null}
              <TopicItems title={t("projectBoard.decisions")} items={props.topic.decisions} icon={<CheckCircle2 size={14} />} />
              <TopicItems title={t("projectBoard.experiences")} items={props.topic.experiences} icon={<Lightbulb size={14} />} tone="warm" />
              <TopicItems title={t("projectBoard.conflicts")} items={props.topic.conflicts} icon={<TriangleAlert size={14} />} tone="warm" />
            </div>
            <div>
              {timeline.length > 0 ? (
                <TopicSection title={t("projectBoard.events")}>
                  <div className="project-topic__timeline">
                    {timeline.map((event) => (
                      <div key={event.id} className="project-topic__event">
                        <span className="project-topic__event-dot" aria-hidden="true" />
                        {event.agent || event.time ? (
                          <div className="project-topic__event-date">
                            <AgentMark agent={event.agent} />
                            {event.time ? <span>{shortDate(event.time)}</span> : null}
                          </div>
                        ) : null}
                        <div className="project-topic__event-text">{event.text}</div>
                      </div>
                    ))}
                  </div>
                </TopicSection>
              ) : null}
              {sources.length > 0 ? (
                <TopicSection title={t("projectBoard.sources")}>
                  {shownSources.map((id) => {
                    const task = props.tasks.find((item) => item.sessionKey === id);
                    return (
                      <button key={id} type="button" className="project-topic__source" disabled={!task} onClick={() => task && props.onOpenTask(task)}>
                        <span className="project-board__session-icon project-board__session-icon--sm" aria-hidden="true"><MessageSquare size={13} /></span>
                        <span className="project-board__row-main">
                          <span className="project-topic__source-title">{task?.title ?? t("projectBoard.missingSession")}</span>
                          {task ? (
                            <span className="project-topic__source-meta">
                              <AgentMark agent={task.sourceAgent ?? "memmy"} />
                              <span>{taskStatusText(task, t)}</span>
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                  {sources.length > SOURCE_PREVIEW_LIMIT ? (
                    <button type="button" className="project-topic__more" onClick={() => setAllSources((open) => !open)}>
                      {allSources ? t("projectBoard.collapse") : t("projectBoard.allSources", { count: sources.length })}
                      {allSources ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
                    </button>
                  ) : null}
                </TopicSection>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TopicSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="project-topic__section">
      <h2 className="project-topic__section-title">{props.title}</h2>
      {props.children}
    </section>
  );
}

function TopicItems(props: {
  title: string;
  items: ProjectTopic["decisions"];
  icon: ReactNode;
  tone?: "warm";
}) {
  if (props.items.length === 0) return null;
  return (
    <TopicSection title={props.title}>
      {props.items.map((item) => (
        <div key={item.id} className="project-topic__item">
          <span className={`project-topic__item-icon${props.tone === "warm" ? " is-warm" : ""}`} aria-hidden="true">{props.icon}</span>
          <div className="project-board__row-main">
            <div className="project-topic__item-text">{item.text}</div>
            {item.agent || item.time ? (
              <div className="project-topic__item-meta">
                <AgentMark agent={item.agent} />
                {item.time ? <span>{shortDate(item.time)}</span> : null}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </TopicSection>
  );
}

function ConfigAside(props: {
  board: ProjectBoard;
  knowledgeBases: NamedItem[];
  skills: NamedItem[];
  saveFailed: boolean;
  onSaveBoard: (board: ProjectBoard) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<null | "instruction" | LinkKind>(null);
  const linkedKnowledge = linkedItems(props.board.knowledgeBaseIds, props.knowledgeBases);
  const linkedSkills = linkedItems(props.board.skillIds, props.skills);
  const linkedConnectors = linkedItems(props.board.connectorIds, CONNECTORS);
  const instruction = props.board.instruction.trim();
  return (
    <aside className="project-board__config" aria-label={t("projectBoard.config")}>
      <div className="project-board__aside-head">
        <strong>{t("projectBoard.config")}</strong>
        <button type="button" className="project-board__icon-button" aria-label={t("projectBoard.hideConfig")} title={t("projectBoard.hideConfig")} onClick={props.onClose}>
          <PanelRight size={17} aria-hidden="true" />
        </button>
      </div>
      <div className="project-board__config-body">
        {props.saveFailed ? <p className="project-board__error" role="alert">{t("projectBoard.saveFailed")}</p> : null}
        <ConfigCard
          title={t("projectBoard.instruction")}
          actionLabel={instruction ? t("projectBoard.edit") : t("projectBoard.add")}
          actionIcon={instruction ? <Pencil size={13} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
          onAction={() => setDialog("instruction")}
        >
          {instruction ? (
            <button type="button" className="project-board__instruction" onClick={() => setDialog("instruction")}>{instruction}</button>
          ) : (
            <p className="project-board__card-empty">{t("projectBoard.instructionEmpty")}</p>
          )}
        </ConfigCard>
        <ConfigCard
          title={t("projectBoard.knowledge")}
          actionLabel={t("projectBoard.addKnowledge")}
          actionIcon={<Plus size={15} aria-hidden="true" />}
          onAction={() => setDialog("knowledge")}
        >
          <LinkedRows
            items={linkedKnowledge}
            icon={<BookOpen size={13} aria-hidden="true" />}
            empty={t("projectBoard.knowledgeEmpty")}
            onRemove={(id) => void props.onSaveBoard({ ...props.board, knowledgeBaseIds: props.board.knowledgeBaseIds.filter((item) => item !== id) })}
          />
        </ConfigCard>
        <ConfigCard
          title={t("projectBoard.skills")}
          actionLabel={t("projectBoard.addSkill")}
          actionIcon={<Plus size={15} aria-hidden="true" />}
          onAction={() => setDialog("skills")}
        >
          <LinkedRows
            items={linkedSkills}
            icon={<Sparkles size={13} aria-hidden="true" />}
            empty={t("projectBoard.skillsEmpty")}
            onRemove={(id) => void props.onSaveBoard({ ...props.board, skillIds: props.board.skillIds.filter((item) => item !== id) })}
          />
        </ConfigCard>
        <ConfigCard
          title={t("projectBoard.connectors")}
          actionLabel={t("projectBoard.addConnector")}
          actionIcon={<Plus size={15} aria-hidden="true" />}
          onAction={() => setDialog("connectors")}
        >
          <LinkedRows
            items={linkedConnectors}
            icon={<Link2 size={13} aria-hidden="true" />}
            empty={t("projectBoard.connectorsEmpty")}
            onRemove={(id) => void props.onSaveBoard({ ...props.board, connectorIds: props.board.connectorIds.filter((item) => item !== id) })}
          />
        </ConfigCard>
      </div>
      {dialog === "instruction" ? (
        <InstructionDialog
          value={props.board.instruction}
          onClose={() => setDialog(null)}
          onSave={async (value) => {
            if (await props.onSaveBoard({ ...props.board, instruction: value })) setDialog(null);
          }}
        />
      ) : null}
      {dialog === "knowledge" || dialog === "skills" || dialog === "connectors" ? (
        <LinkDialog
          kind={dialog}
          items={dialog === "knowledge" ? props.knowledgeBases : dialog === "skills" ? props.skills : CONNECTORS}
          linkedIds={dialog === "knowledge" ? props.board.knowledgeBaseIds : dialog === "skills" ? props.board.skillIds : props.board.connectorIds}
          onClose={() => setDialog(null)}
          onAdd={async (ids) => {
            const next = dialog === "knowledge"
              ? { ...props.board, knowledgeBaseIds: unique([...props.board.knowledgeBaseIds, ...ids]) }
              : dialog === "skills"
                ? { ...props.board, skillIds: unique([...props.board.skillIds, ...ids]) }
                : { ...props.board, connectorIds: unique([...props.board.connectorIds, ...ids]) };
            if (await props.onSaveBoard(next)) setDialog(null);
          }}
        />
      ) : null}
    </aside>
  );
}

function ConfigCard(props: {
  title: string;
  actionLabel: string;
  actionIcon: ReactNode;
  onAction: () => void;
  children: ReactNode;
}) {
  return (
    <section className="project-board__card">
      <div className="project-board__card-head">
        <span>{props.title}</span>
        <button type="button" className="project-board__icon-button project-board__icon-button--sm" aria-label={props.actionLabel} title={props.actionLabel} onClick={props.onAction}>
          {props.actionIcon}
        </button>
      </div>
      {props.children}
    </section>
  );
}

function LinkedRows(props: {
  items: NamedItem[];
  icon: ReactNode;
  empty: string;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (props.items.length === 0) return <p className="project-board__card-empty">{props.empty}</p>;
  return (
    <>
      {props.items.map((item) => (
        <div key={item.id} className="project-board__linked-row">
          <span className="project-board__mini-icon" aria-hidden="true">{props.icon}</span>
          <span className="project-board__linked-name">{item.name}</span>
          {item.detail ? <span className="project-board__muted">{item.detail}</span> : null}
          <button type="button" className="project-board__icon-button project-board__icon-button--xs" aria-label={t("projectBoard.removeItem", { name: item.name })} title={t("projectBoard.removeItem", { name: item.name })} onClick={() => props.onRemove(item.id)}>
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ))}
    </>
  );
}

function BoardDialog(props: { title: string; description?: ReactNode; width: number; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return (
    <div className="project-board__dialog-layer">
      <div className="project-board__mask" onClick={props.onClose} />
      <div className="project-board__dialog" role="dialog" aria-modal="true" aria-label={props.title} style={{ width: props.width }}>
        <div className="project-board__dialog-head">
          <div className="project-board__row-main">
            <h2>{props.title}</h2>
            {props.description ? <p>{props.description}</p> : null}
          </div>
          <button type="button" className="project-board__icon-button" aria-label={t("common.close")} title={t("common.close")} onClick={props.onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {props.children}
        <div className="project-board__dialog-foot">{props.footer}</div>
      </div>
    </div>
  );
}

function InstructionDialog(props: { value: string; onClose: () => void; onSave: (value: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(props.value);
  const [saving, setSaving] = useState(false);
  return (
    <BoardDialog
      title={t("projectBoard.instructionTitle")}
      description={t("projectBoard.instructionDescription")}
      width={560}
      onClose={props.onClose}
      footer={(
        <>
          <button type="button" className="project-board__button project-board__button--ghost" onClick={props.onClose}>{t("projectBoard.cancel")}</button>
          <button type="button" className="project-board__button project-board__button--primary" disabled={saving} onClick={() => {
            setSaving(true);
            void props.onSave(value.trim()).finally(() => setSaving(false));
          }}>{t("projectBoard.save")}</button>
        </>
      )}
    >
      <textarea
        className="project-board__instruction-input"
        value={value}
        autoFocus
        placeholder={t("projectBoard.instructionPlaceholder")}
        onChange={(event) => setValue(event.target.value)}
      />
    </BoardDialog>
  );
}

function LinkDialog(props: {
  kind: LinkKind;
  items: NamedItem[];
  linkedIds: string[];
  onClose: () => void;
  onAdd: (ids: string[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const knowledge = props.kind === "knowledge";
  const connectors = props.kind === "connectors";
  const needle = query.trim().toLocaleLowerCase();
  const visible = props.items.filter((item) => !needle || item.name.toLocaleLowerCase().includes(needle));
  return (
    <BoardDialog
      title={knowledge ? t("projectBoard.addKnowledge") : connectors ? t("projectBoard.addConnector") : t("projectBoard.addSkill")}
      description={knowledge ? t("projectBoard.addKnowledgeDescription") : connectors ? t("projectBoard.addConnectorDescription") : t("projectBoard.addSkillDescription")}
      width={520}
      onClose={props.onClose}
      footer={(
        <>
          <button type="button" className="project-board__button project-board__button--ghost" onClick={props.onClose}>{t("projectBoard.cancel")}</button>
          <button type="button" className="project-board__button project-board__button--primary" disabled={picked.length === 0 || saving} onClick={() => {
            setSaving(true);
            void props.onAdd(picked).finally(() => setSaving(false));
          }}>{t("projectBoard.add")}</button>
        </>
      )}
    >
      <input
        className="project-board__search"
        value={query}
        placeholder={knowledge ? t("projectBoard.searchKnowledge") : connectors ? t("projectBoard.searchConnectors") : t("projectBoard.searchSkills")}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="project-board__select-list">
        {visible.length === 0 ? <p className="project-board__card-empty">{t("projectBoard.noneToAdd")}</p> : visible.map((item) => {
          const linked = props.linkedIds.includes(item.id);
          const checked = linked || picked.includes(item.id);
          return (
            <button
              key={item.id}
              type="button"
              role="checkbox"
              aria-checked={checked}
              disabled={linked}
              className="project-board__select-row"
              onClick={() => setPicked((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])}
            >
              <span className={`project-board__checkbox${checked ? " is-checked" : ""}`} aria-hidden="true">{checked ? <Check size={11} strokeWidth={3} /> : null}</span>
              <span className="project-board__mini-icon" aria-hidden="true">{knowledge ? <BookOpen size={13} /> : connectors ? <Link2 size={13} /> : <Sparkles size={13} />}</span>
              <span className="project-board__linked-name">{item.name}</span>
              {item.detail ? <span className="project-board__muted">{item.detail}</span> : null}
              {linked ? <span className="project-board__muted">{t("projectBoard.linked")}</span> : null}
            </button>
          );
        })}
      </div>
    </BoardDialog>
  );
}

function EmptyState(props: { title: string; body: string }) {
  return (
    <div className="project-board__empty">
      <b>{props.title}</b>
      <p>{props.body}</p>
    </div>
  );
}

function sourceTaskForTopic(topic: ProjectTopic, tasks: readonly AgentTaskView[]): AgentTaskView | null {
  return tasks.find((task) => topic.sourceSessionIds.includes(task.sessionKey)) ?? null;
}

function useNarrowBoard(ref: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    setNarrow(element.getBoundingClientRect().width < NARROW_BOARD_WIDTH);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < NARROW_BOARD_WIDTH);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

function linkedItems(ids: readonly string[], items: readonly NamedItem[]): NamedItem[] {
  return ids.map((id) => items.find((item) => item.id === id) ?? { id, name: id });
}

function taskStatusText(task: AgentTaskView, t: ReturnType<typeof useTranslation>["t"]): string {
  return task.runStartedAt ? t("projectBoard.running") : shortDate(task.updatedAt);
}

export function shortDate(value: string | null | undefined, now = new Date()): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const pad = (part: number) => String(part).padStart(2, "0");
  if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const monthDay = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}/${monthDay}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function lookupKnowledgeNames(
  clients: NonNullable<ReturnType<typeof useApiClients>["clients"]>,
  ids: string[]
): Promise<string[]> {
  if (ids.length === 0) return [];
  const settings = await requestJson({
    config: clients.runtimeConfig,
    path: "/api/knowledge/settings",
    schema: KnowledgeSettingsSchema
  });
  const names = new Map(settings.bases.map((base) => [base.id, base.name]));
  return ids.flatMap((id) => names.get(id) ?? []);
}

async function lookupSkillNames(
  clients: NonNullable<ReturnType<typeof useApiClients>["clients"]>,
  ids: string[]
): Promise<string[]> {
  if (ids.length === 0) return [];
  const names = new Map((await loadSkillChoices(clients.memoryRuntime)).map((item) => [item.id, item.name]));
  return ids.flatMap((id) => names.get(id) ?? []);
}

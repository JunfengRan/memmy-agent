import { useEffect, useState } from "react";
import type { ProjectTopic } from "@memmy/local-api-contracts";
import { z } from "zod";
import { requestJson } from "../api/http.js";
import type { MemmyAgentProject, ProjectBoard } from "../api/memmy-agent-client.js";
import { useApiClients } from "../app/providers.js";
import { useTranslation } from "../i18n/use-translation.js";
import type { AgentTaskView } from "../state/agent-chat-slice.js";
import { useAppState } from "../state/app-state.js";
import { agentActions, appActions } from "../state/app-actions.js";
import "./project-board.css";
import { closeProjectBoard, openProjectBoard, useProjectBoardSession } from "./project-board-session.js";

const EMPTY_BOARD: ProjectBoard = {
  instruction: "",
  knowledgeBaseIds: [],
  skillIds: [],
  citations: []
};

const KnowledgeSettingsSchema = z.object({
  bases: z.array(z.object({ id: z.string(), name: z.string() })).default([])
}).passthrough();

export function projectTaskContextPrefix(input: {
  instruction: string;
  knowledgeNames: string[];
  skillNames: string[];
}): string {
  const lines: string[] = [];
  const instruction = input.instruction.trim();
  if (instruction) lines.push(`项目指令：\n${instruction}`);
  if (input.knowledgeNames.length > 0) lines.push(`项目知识库：${input.knowledgeNames.join("、")}`);
  if (input.skillNames.length > 0) lines.push(`项目技能：${input.skillNames.join("、")}`);
  if (lines.length === 0) return "";
  return `<memmy_project_board>\n${lines.join("\n")}\n</memmy_project_board>`;
}

export function matchingProjectTopic<T extends { name: string }>(draft: string, topics: readonly T[]): T | null {
  const text = draft.trim();
  if (text.length < 2) return null;
  return topics.find((topic) => topic.name.length >= 2 && text.includes(topic.name)) ?? null;
}

export async function loadProjectTaskContextPrefix(
  clients: NonNullable<ReturnType<typeof useApiClients>["clients"]>,
  projectId: string
): Promise<string> {
  const board = await clients.memmyAgent.readProjectBoard(projectId);
  const [knowledgeNames, skillNames] = await Promise.all([
    lookupKnowledgeNames(clients, board.knowledgeBaseIds),
    lookupSkillNames(clients, board.skillIds)
  ]);
  return projectTaskContextPrefix({
    instruction: board.instruction,
    knowledgeNames,
    skillNames
  });
}

export function ProjectBoardPage(props: {
  project: MemmyAgentProject;
  tasks: AgentTaskView[];
  onSend: (text: string) => Promise<boolean>;
}) {
  const { clients } = useApiClients();
  const { state, dispatch } = useAppState();
  const session = useProjectBoardSession();
  const [tab, setTab] = useState<"sessions" | "items">("sessions");
  const [topics, setTopics] = useState<ProjectTopic[]>([]);
  const [board, setBoard] = useState<ProjectBoard>(EMPTY_BOARD);
  const [knowledgeBases, setKnowledgeBases] = useState<Array<{ id: string; name: string }>>([]);
  const [skills, setSkills] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(session.topicId);
  const [draft, setDraft] = useState("");
  const [configOpen, setConfigOpen] = useState(true);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (session.topicId) {
      setSelectedTopicId(session.topicId);
      setTab("items");
    }
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
    void clients.memoryRuntime.listPanelItems({ layer: "Skill", page: 1 }).then((page) => {
      if (!cancelled) setSkills(page.items.map((item) => ({ id: item.id, name: item.title })));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [clients, props.project.id, props.project.rootPath]);

  const selectedTopic = topics.find((topic) => topic.id === selectedTopicId) ?? null;
  const match = matchingProjectTopic(draft, topics);

  async function saveBoard(next: ProjectBoard): Promise<void> {
    if (!clients) return;
    const saved = await clients.memmyAgent.saveProjectBoard(props.project.id, next);
    setBoard(saved);
    setStatus("saved");
  }

  async function cite(task: AgentTaskView): Promise<void> {
    const fromSessionKey = state.agent.currentSessionKey ?? `draft:${props.project.id}`;
    const citations = board.citations.some((item) => item.fromSessionKey === fromSessionKey && item.toSessionKey === task.sessionKey)
      ? board.citations
      : [...board.citations, { fromSessionKey, toSessionKey: task.sessionKey }];
    await saveBoard({ ...board, citations });
    setDraft((current) => current.includes(`「引用 ${task.title}」`) ? current : `「引用 ${task.title}」${current}`);
  }

  return (
    <ProjectBoardView
      projectName={props.project.name}
      tasks={props.tasks}
      topics={topics}
      board={board}
      knowledgeBases={knowledgeBases}
      skills={skills}
      tab={tab}
      selectedTopic={selectedTopic}
      draft={draft}
      match={match}
      configOpen={configOpen}
      status={status}
      onTab={setTab}
      onClose={() => closeProjectBoard()}
      onDraft={setDraft}
      onSelectTopic={(topicId) => {
        setTab("items");
        setSelectedTopicId(topicId);
      }}
      onOpenTask={(task) => {
        closeProjectBoard();
        const chatId = clients?.memmyAgent.sessionKeyToChatId(task.sessionKey) ?? task.chatId;
        dispatch(agentActions.historyLoading(task.sessionKey, chatId, `${chatId}:board`));
        dispatch(appActions.navigate("/main"));
        if (!clients) return;
        void clients.memmyAgent.readWebuiThread(task.sessionKey).then((thread) => {
          dispatch(agentActions.historyLoaded(thread, `${chatId}:board`));
        }).catch(() => undefined);
      }}
      onCite={(task) => void cite(task)}
      onChangeBoard={setBoard}
      onSave={() => void saveBoard(board)}
      onToggleConfig={() => setConfigOpen((open) => !open)}
      onSend={() => void props.onSend(draft).then((sent) => {
        if (sent) setDraft("");
      })}
    />
  );
}

export function ProjectBoardView(props: {
  projectName: string;
  tasks: AgentTaskView[];
  topics: ProjectTopic[];
  board: ProjectBoard;
  knowledgeBases: Array<{ id: string; name: string }>;
  skills: Array<{ id: string; name: string }>;
  tab: "sessions" | "items";
  selectedTopic: ProjectTopic | null;
  draft: string;
  match: ProjectTopic | null;
  configOpen: boolean;
  status: string | null;
  onTab: (tab: "sessions" | "items") => void;
  onClose: () => void;
  onDraft: (value: string) => void;
  onSelectTopic: (topicId: string) => void;
  onOpenTask: (task: AgentTaskView) => void;
  onCite: (task: AgentTaskView) => void;
  onChangeBoard: (board: ProjectBoard) => void;
  onSave: () => void;
  onToggleConfig: () => void;
  onSend: () => void;
}) {
  const { t } = useTranslation();
  const sessions = [...props.tasks].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  return (
    <section className="project-board" aria-label={t("projectBoard.title")}>
      <header className="project-board__header">
        <button type="button" className="project-board__text-button" onClick={props.onClose}>{t("projectBoard.back")}</button>
        <h1 className="project-board__title">{props.projectName}</h1>
        <button type="button" className="project-board__text-button" onClick={props.onToggleConfig}>
          {props.configOpen ? t("projectBoard.hideConfig") : t("projectBoard.config")}
        </button>
      </header>
      <div className="project-board__body">
        <div className="project-board__main">
          <div className="project-board__tabs" role="tablist">
            <button type="button" className={`project-board__tab${props.tab === "sessions" ? " is-active" : ""}`} onClick={() => props.onTab("sessions")}>{t("projectBoard.sessions")}</button>
            <button type="button" className={`project-board__tab${props.tab === "items" ? " is-active" : ""}`} onClick={() => props.onTab("items")}>{t("projectBoard.items")}</button>
          </div>
          {props.tab === "sessions" ? (
            <div className="project-board__list">
              {sessions.length === 0 ? <p className="project-board__empty">{t("projectBoard.emptySessions")}</p> : sessions.map((task) => (
                <SessionRow key={task.sessionKey} task={task} board={props.board} onOpen={props.onOpenTask} onCite={props.onCite} />
              ))}
            </div>
          ) : props.selectedTopic ? (
            <TopicDetail topic={props.selectedTopic} onBack={() => props.onSelectTopic("")} />
          ) : (
            <div className="project-board__list">
              {props.topics.length === 0 ? <p className="project-board__empty">{t("projectBoard.emptyItems")}</p> : props.topics.map((topic) => (
                <button key={topic.id} type="button" className="project-board__row" onClick={() => props.onSelectTopic(topic.id)}>
                  <span className="project-board__row-main">
                    <span className="project-board__row-title">{topic.name}</span>
                    <span className="project-board__meta">{topic.summary}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <form className="project-board__composer" onSubmit={(event) => {
            event.preventDefault();
            if (props.draft.trim()) props.onSend();
          }}>
            {props.match ? (
              <div className="project-topic-hint">
                <span>{t("projectBoard.related", { name: props.match.name })}</span>
                <button type="button" className="project-board__text-button" onClick={() => props.onSelectTopic(props.match!.id)}>{t("projectBoard.openDetail")}</button>
              </div>
            ) : null}
            <textarea
              value={props.draft}
              placeholder={t("projectBoard.composer")}
              rows={2}
              onChange={(event) => props.onDraft(event.target.value)}
            />
            <button type="submit" className="project-board__text-button">{t("home.send")}</button>
          </form>
        </div>
        {props.configOpen ? (
          <aside className="project-board__config">
            <div className="project-board__config-head">
              <strong>{t("projectBoard.config")}</strong>
              <button type="button" className="project-board__text-button" onClick={props.onSave}>{t("projectBoard.save")}</button>
            </div>
            {props.status === "saved" ? <p className="project-board__meta">{t("projectBoard.saved")}</p> : null}
            <label>
              {t("projectBoard.instruction")}
              <textarea
                value={props.board.instruction}
                onChange={(event) => props.onChangeBoard({ ...props.board, instruction: event.target.value })}
              />
            </label>
            <strong>{t("projectBoard.knowledge")}</strong>
            {props.knowledgeBases.map((base) => (
              <label key={base.id} className="project-board__check">
                <input
                  type="checkbox"
                  checked={props.board.knowledgeBaseIds.includes(base.id)}
                  onChange={() => props.onChangeBoard({
                    ...props.board,
                    knowledgeBaseIds: toggleId(props.board.knowledgeBaseIds, base.id)
                  })}
                />
                {base.name}
              </label>
            ))}
            <strong>{t("projectBoard.skills")}</strong>
            {props.skills.map((skill) => (
              <label key={skill.id} className="project-board__check">
                <input
                  type="checkbox"
                  checked={props.board.skillIds.includes(skill.id)}
                  onChange={() => props.onChangeBoard({
                    ...props.board,
                    skillIds: toggleId(props.board.skillIds, skill.id)
                  })}
                />
                {skill.name}
              </label>
            ))}
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function SessionRow(props: {
  task: AgentTaskView;
  board: ProjectBoard;
  onOpen: (task: AgentTaskView) => void;
  onCite: (task: AgentTaskView) => void;
}) {
  const { t } = useTranslation();
  const citedBy = props.board.citations.filter((item) => item.toSessionKey === props.task.sessionKey || item.fromSessionKey === props.task.sessionKey);
  return (
    <div className="project-board__row">
      <button type="button" className="project-board__row-main project-board__title-button" onClick={() => props.onOpen(props.task)}>
        <span className="project-board__row-title">{props.task.title}</span>
        <span className="project-board__meta">{props.task.preview}</span>
      </button>
      <button type="button" className="project-board__text-button" onClick={() => props.onCite(props.task)}>{t("projectBoard.cite")}</button>
      {citedBy.length > 0 ? <span className="project-board__meta">{t("projectBoard.citations", { count: citedBy.length })}</span> : null}
    </div>
  );
}

function TopicDetail(props: { topic: ProjectTopic; onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <article className="project-board__detail">
      <button type="button" className="project-board__text-button" onClick={props.onBack}>{t("projectBoard.back")}</button>
      <h2>{props.topic.name}</h2>
      <Section title={t("projectBoard.summary")} text={props.topic.summary} />
      <Section title={t("projectBoard.description")} text={props.topic.description} />
      <ListSection title={t("projectBoard.decisions")} items={props.topic.decisions.map((item) => item.text)} />
      <ListSection title={t("projectBoard.experiences")} items={props.topic.experiences.map((item) => item.text)} />
      <ListSection title={t("projectBoard.events")} items={props.topic.events.map((item) => item.text)} />
      <ListSection title={t("projectBoard.conflicts")} items={props.topic.conflicts.map((item) => item.text)} />
      <ListSection title={t("projectBoard.sources")} items={props.topic.sourceSessionIds} />
    </article>
  );
}

function Section(props: { title: string; text: string }) {
  if (!props.text.trim()) return null;
  return (
    <section>
      <h3>{props.title}</h3>
      <p>{props.text}</p>
    </section>
  );
}

function ListSection(props: { title: string; items: string[] }) {
  if (props.items.length === 0) return null;
  return (
    <section>
      <h3>{props.title}</h3>
      <ul>{props.items.map((item) => <li key={item}>{item}</li>)}</ul>
    </section>
  );
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
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
  return ids.map((id) => names.get(id) ?? id);
}

async function lookupSkillNames(
  clients: NonNullable<ReturnType<typeof useApiClients>["clients"]>,
  ids: string[]
): Promise<string[]> {
  if (ids.length === 0) return [];
  const page = await clients.memoryRuntime.listPanelItems({ layer: "Skill", page: 1 });
  const names = new Map(page.items.map((item) => [item.id, item.title]));
  return ids.map((id) => names.get(id) ?? id);
}

export function ProjectTopicHint(props: { project: MemmyAgentProject | null; draft: string }) {
  const { clients } = useApiClients();
  const { t } = useTranslation();
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
  return (
    <div className="project-topic-hint">
      <span>{t("projectBoard.related", { name: match.name })}</span>
      <button type="button" className="project-board__text-button" onClick={() => openProjectBoard(props.project!.id, match.id)}>{t("projectBoard.openDetail")}</button>
    </div>
  );
}

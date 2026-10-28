import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectTopic } from "@memmy/local-api-contracts";
import type { ProjectBoard } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { AgentTaskView } from "../../state/agent-chat-slice.js";
import {
  addMention,
  citationLinks,
  draftWithoutMentionQuery,
  latestTopicProgress,
  matchingProjectTopic,
  mentionChoices,
  mentionQuery,
  projectProgressSnapshot,
  ProjectBoardView,
  ProjectCitationPanelView,
  loadSkillChoices,
  projectRefs,
  shortDate,
  topicsForBoard,
  withSessionCitations,
  type BoardMention
} from "../project-board.js";

const board: ProjectBoard = {
  instruction: "先看事项",
  knowledgeBaseIds: ["kb-1"],
  skillIds: [],
  connectorIds: [],
  citations: []
};

describe("project board", () => {
  it("shows the empty session state above the injected home composer, and the config cards", () => {
    const empty = renderBoard({ tasks: [], topics: [], selectedTopic: null });
    expect(empty).toContain("项目中尚无会话");
    expect(empty).toContain("在下方输入框中发起任务。");
    expect(empty).toContain("data-testid=\"home-composer\"");
    expect(empty).toContain("先看事项");
    expect(empty).toContain("产品文档");
    expect(empty).toContain("尚未关联技能");
    expect(empty).not.toContain(">返回<");
  });

  it("marks mock sessions with their agent on the list, timeline and source row", () => {
    const cursor = {
      ...task(),
      sessionKey: "sess-cursor",
      title: "导出价格表",
      sourceAgent: "cursor",
      updatedAt: "2026-10-21T04:10:00.000Z"
    };
    const codex = {
      ...task(),
      sessionKey: "sess-codex",
      title: "导出改成 CSV",
      sourceAgent: "codex",
      updatedAt: "2026-10-21T08:20:00.000Z"
    };
    const item = {
      ...topic(),
      name: "价格导出",
      sourceSessionIds: ["sess-codex", "sess-cursor"],
      decisions: [{ id: "d-csv", text: "导出价格表写成 prices.csv", agent: "codex", time: "2026-10-21T08:20:00.000Z" }],
      events: [
        { id: "e-json", text: "价格表写成 prices.json", agent: "cursor", time: "2026-10-21T04:20:00.000Z" },
        { id: "e-csv", text: "导出改为 prices.csv", agent: "codex", time: "2026-10-21T08:20:00.000Z" }
      ]
    };
    const list = renderBoard({ tasks: [cursor, codex], topics: [item], selectedTopic: null, tab: "sessions" });
    expect(list).toContain("Cursor");
    expect(list).toContain("Codex");
    expect(list).toContain("10/21");
    const detail = renderBoard({ tasks: [cursor, codex], topics: [item], selectedTopic: item });
    expect(detail).toContain("Cursor");
    expect(detail).toContain("Codex");
    expect(detail).toContain("价格表写成 prices.json");
    expect(detail).toContain("导出改成 CSV");
    expect(detail).toContain("10/21");
  });

  it("derives evidence-based progress metrics and calendar events", () => {
    const snapshot = projectProgressSnapshot([topic()], [task()]);
    expect(snapshot.itemCount).toBe(1);
    expect(snapshot.agentCount).toBe(1);
    expect(snapshot.calendar).toEqual([expect.objectContaining({ topicId: "topic-1", date: "2026-10-19" })]);
    expect(snapshot.rows[0]?.firstTime).toBe("2026-10-19T08:00:00.000Z");
  });

  it("renders a topic detail with decisions, timeline and source sessions", () => {
    const detail = renderBoard({ tasks: [task()], topics: [topic()], selectedTopic: topic() });
    expect(detail).toContain("项目记忆");
    expect(detail).toContain("看板只读已有事项");
    expect(detail).toContain("演变轨迹");
    expect(detail).toContain("共享空间并入项目");
    expect(detail).toContain("来源会话");
    expect(detail).toContain("接入看板");
  });

  it("lists items with their latest progress and passes mention chips into the composer", () => {
    const listed = renderBoard({
      tasks: [task()],
      topics: [topic()],
      selectedTopic: null,
      tab: "items",
      draft: "@",
      mentions: [{ kind: "knowledge", id: "kb-1", label: "产品文档" }]
    });
    expect(listed).toContain("共享空间并入项目");
    expect(listed).toContain("接入看板");
    expect(listed).toContain("移除 产品文档");
  });

  it("shows the related-work hint with view and cite actions", () => {
    const hinted = renderBoard({ tasks: [task()], topics: [topic()], selectedTopic: null, match: topic() });
    expect(hinted).toContain("相关事项：");
    expect(hinted).toContain(">查看<");
    expect(hinted).toContain(">引用<");
  });

  it("builds project refs for the agent and matches a topic in the draft", () => {
    expect(projectRefs({
      knowledgeNames: ["产品文档", "产品文档"],
      skillNames: ["检索"],
      citedTitles: ["接入看板"]
    })).toEqual({ knowledge: ["产品文档"], skills: ["检索"], sessions: ["接入看板"] });
    expect(projectRefs({ knowledgeNames: [], skillNames: [] })).toBeNull();
    expect(matchingProjectTopic("请继续项目记忆", [topic()])?.id).toBe("topic-1");
    expect(matchingProjectTopic("只读事项还要补进展", [topic()])?.id).toBe("topic-1");
    expect(matchingProjectTopic("你好", [topic()])).toBeNull();
  });

  it("keeps the mention, citation and ordering helpers consistent", () => {
    expect(topicsForBoard([
      { ...topic(), id: "older", updatedAt: "2026-10-01T00:00:00.000Z" },
      topic()
    ])[0]?.id).toBe("topic-1");
    expect(latestTopicProgress(topic())).toBe("共享空间并入项目");
    expect(mentionQuery("@知识")).toBe("知识");
    expect(mentionQuery("邮箱 a@b")).toBeNull();
    expect(draftWithoutMentionQuery("继续 @知识")).toBe("继续");
    expect(mentionChoices({
      query: "看板",
      tasks: [task()],
      knowledgeBases: [{ id: "kb-1", name: "产品文档" }],
      skills: []
    }).sessions.map((item) => item.id)).toEqual(["sess-1"]);
    const mention: BoardMention = { kind: "session", id: "sess-2", label: "旧会话" };
    expect(addMention(addMention([], mention), mention)).toHaveLength(1);
    expect(citationLinks([
      { fromSessionKey: "sess-1", toSessionKey: "sess-2" },
      { fromSessionKey: "sess-3", toSessionKey: "sess-1" }
    ], "sess-1")).toEqual({ outgoing: ["sess-2"], incoming: ["sess-3"] });
    const cited = withSessionCitations(board, "sess-1", ["sess-2", "sess-2", "sess-1"]);
    expect(cited.citations).toEqual([{ fromSessionKey: "sess-1", toSessionKey: "sess-2" }]);
    expect(withSessionCitations(cited, "sess-1", ["sess-2"])).toBe(cited);
  });

  it("loads every activated skill page and labels same-named skills by source agent", async () => {
    const item = (id: string, title: string, source: string) => ({
      id, title, kind: "skill", memoryLayer: "Skill", status: "activated", summary: "", tags: [],
      metadata: { source }, createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z", version: 1
    });
    const listPanelItems = vi.fn(async (input: { page?: number }) => ({
      items: input.page === 1 ? [item("s-1", "tech-diagram", "codex")] : [item("s-2", "tech-diagram", "cursor")],
      page: input.page ?? 1, pageSize: 20 as const, total: 2, totalPages: 2,
      hasNext: input.page === 1, hasPrev: input.page !== 1, serverTime: "2026-10-27T00:00:00.000Z"
    }));
    const skills = await loadSkillChoices({ listPanelItems } as never);
    expect(listPanelItems).toHaveBeenCalledWith({ layer: "Skill", status: "activated", page: 2 });
    expect(skills).toEqual([
      { id: "s-1", name: "tech-diagram", detail: "Codex" },
      { id: "s-2", name: "tech-diagram", detail: "Cursor" }
    ]);
  });

  it("formats dates as time today, month/day this year, and with a year otherwise", () => {
    const now = new Date(2026, 9, 27, 18, 0);
    expect(shortDate(new Date(2026, 9, 27, 9, 5).toISOString(), now)).toBe("09:05");
    expect(shortDate(new Date(2026, 9, 19, 9, 5).toISOString(), now)).toBe("10/19");
    expect(shortDate(new Date(2025, 0, 2).toISOString(), now)).toBe("2025/01/02");
  });

  it("draws the citation lineage around the current session", () => {
    const panel = renderToString(
      <I18nProvider language="zh-CN">
        <ProjectCitationPanelView
          citations={[{ fromSessionKey: "sess-1", toSessionKey: "sess-2" }]}
          sessionKey="sess-1"
          tasks={[task(), { ...task(), sessionKey: "sess-2", chatId: "chat-2", title: "知识库分享 PRD" }]}
          onOpenSession={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nProvider>
    );
    expect(panel).toContain("本会话引用的会话");
    expect(panel).toContain("知识库分享 PRD");
    expect(panel).toContain("本会话");
    expect(panel).toContain("接入看板");
  });
});

function renderBoard(input: {
  tasks: AgentTaskView[];
  topics: ProjectTopic[];
  selectedTopic: ProjectTopic | null;
  tab?: "sessions" | "items";
  draft?: string;
  mentions?: BoardMention[];
  match?: ProjectTopic | null;
}): string {
  return renderToString(
    <I18nProvider language="zh-CN">
      <ProjectBoardView
        projectName="Memmy"
        tasks={input.tasks}
        topics={input.topics}
        board={board}
        knowledgeBases={[{ id: "kb-1", name: "产品文档" }]}
        skills={[]}
        tab={input.tab ?? (input.selectedTopic ? "items" : "sessions")}
        selectedTopic={input.selectedTopic}
        draft={input.draft ?? ""}
        mentions={input.mentions ?? []}
        match={input.match ?? null}
        configOpen={null}
        onTab={vi.fn()}
        onSelectTopic={vi.fn()}
        onOpenTask={vi.fn()}
        onInsertMention={vi.fn()}
        onRemoveMention={vi.fn()}
        onCloseMentions={vi.fn()}
        onCiteTopic={vi.fn()}
        onSaveBoard={vi.fn(async () => true)}
        onToggleConfig={vi.fn()}
        renderComposer={(chips) => <div data-testid="home-composer">{chips}</div>}
      />
    </I18nProvider>
  );
}

function task(): AgentTaskView {
  return {
    sessionKey: "sess-1",
    chatId: "chat-1",
    title: "接入看板",
    preview: "进行中",
    updatedAt: "2026-10-23T08:00:00.000Z",
    runStartedAt: null,
    completedUnseen: false,
    pinned: false,
    archived: false,
    tags: [],
    projectId: "project-1",
    groupProjectId: "project-1",
    cwd: "/tmp/memmy",
    missingProject: false
  };
}

function topic(): ProjectTopic {
  return {
    id: "topic-1",
    name: "项目记忆",
    updatedAt: "2026-10-23T08:00:00.000Z",
    summary: "只读事项",
    description: "从会话归纳",
    decisions: [{ id: "d1", text: "看板只读已有事项" }],
    experiences: [],
    events: [{ id: "e1", text: "共享空间并入项目", time: "2026-10-19T08:00:00.000Z" }],
    conflicts: [],
    sourceSessionIds: ["sess-1"]
  };
}

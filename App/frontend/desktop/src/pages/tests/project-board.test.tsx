import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectTopic } from "@memmy/local-api-contracts";
import type { ProjectBoard } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { AgentTaskView } from "../../state/agent-chat-slice.js";
import {
  matchingProjectTopic,
  ProjectBoardView,
  projectTaskContextPrefix
} from "../project-board.js";

const board: ProjectBoard = {
  instruction: "先看事项",
  knowledgeBaseIds: ["kb-1"],
  skillIds: [],
  citations: []
};

describe("project board", () => {
  it("shows an empty session list, a topic detail, and the saved instruction", () => {
    const empty = renderBoard({ tasks: [], topics: [], selectedTopic: null });
    expect(empty).toContain("项目中尚无会话");

    const detail = renderBoard({
      tasks: [task()],
      topics: [topic()],
      selectedTopic: topic()
    });
    expect(detail).toContain("项目记忆");
    expect(detail).toContain("看板只读已有事项");
    expect(detail).toContain("先看事项");
    expect(detail).toContain("保存");
  });

  it("builds the agent prefix and matches a topic in the draft", () => {
    expect(projectTaskContextPrefix({
      instruction: "先看事项",
      knowledgeNames: ["产品文档"],
      skillNames: ["检索"]
    })).toContain("项目知识库：产品文档");
    expect(matchingProjectTopic("请继续项目记忆", [topic()])?.id).toBe("topic-1");
    expect(matchingProjectTopic("你好", [topic()])).toBeNull();
  });
});

function renderBoard(input: {
  tasks: AgentTaskView[];
  topics: ProjectTopic[];
  selectedTopic: ProjectTopic | null;
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
        tab={input.selectedTopic ? "items" : "sessions"}
        selectedTopic={input.selectedTopic}
        draft=""
        match={null}
        configOpen
        status={null}
        onTab={vi.fn()}
        onClose={vi.fn()}
        onDraft={vi.fn()}
        onSelectTopic={vi.fn()}
        onOpenTask={vi.fn()}
        onCite={vi.fn()}
        onChangeBoard={vi.fn()}
        onSave={vi.fn()}
        onToggleConfig={vi.fn()}
        onSend={vi.fn()}
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
    events: [],
    conflicts: [],
    sourceSessionIds: ["sess-1"]
  };
}

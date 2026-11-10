---
id: PM-22-injection-templates
status: done
owner: reviewer
roadmap: PM-22
branch: dev-project-memory-add-search-dev
updated: 2026-11-10
---

# PM-22 注入模板与回写剥离

## 目标

渲染模板 1–3，工具结果不再包原始 JSON。闭合注入块不进入 M02。`degraded` 非空时模板和 search 技能里能看见固定提示。不提交。

## 范围

- 包含：`prompts/inject.ts`、`inject/render.ts`、`inject/strip.ts`、工具与 CLI 渲染、云端 `addMessage` 剥离、任务详情里的 `strippedBlocks`、两份宿主模板、Memmy agent 的 `hook.ts` 会话/每轮注入
- 不包含：提交与交接；检索排序；`user_memory` / `agent_memory` 改名；评测集与 history；Q-21 的状态；Claude / Codex / Cursor 宿主钩子；非项目记忆段落

## 规格出处

- 架构文档 §3.3、§3.4
- open-questions Q-21（状态不改）、Q-33、Q-34

## 验收标准

- [x] 提交给 M02 的内容里闭合注入块 = 0，并有单测
- [x] `degraded` 非空时，有命中和无命中都渲染固定提示，并有单测
- [ ] 交接（本轮不写 handoff，代码未提交）

## 相关工作项

PM-21

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-10 | in-progress | developer / Cursor | item.md |
| 2026-11-10 | ready-for-review | developer / Cursor | handoff-01.md（e980bf77） |
| 2026-11-10 | done | reviewer / Cursor | review-01.md（approved，0 MUST，3 SHOULD） |

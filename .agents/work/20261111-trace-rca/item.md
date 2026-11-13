---
id: 20261111-trace-rca
status: approved
owner: reviewer / Cursor
roadmap: 无
branch: dev-project-memory-add-search-dev
updated: 2026-11-11
---

# 实验全程追踪与错题归因

## 目标

补齐每次 add 的模型原文、记忆仓 diff、提问前快照和检索打分，重跑当前版本，并对评委判错的题先看 search、再看 add。

## 范围

- 包含：评测侧追踪、`scoreProjectTopics` 抽取、一次带追踪的 v2.1 端到端、逐题归因和文档。
- 不包含：按归因改产品抽取或检索门槛。

## 规格出处

- 评测卫生：AGENTS.md。追踪不进产品契约。
- ADR-0009。
- 错题里的抽取边界见 Q-36。

## 验收标准

- [x] 未设 `MEMMY_EVAL_TRACE_DB` 时回放行为与以前一致
- [x] 追踪文件不写请求头，不进 git
- [x] `scoreProjectTopics` 与产品排序一致
- [x] 重跑有逐题档案，错题有归因

## 相关工作项

- 20261111-closeout-eval

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-11 | approved | reviewer / Cursor | review-01.md |

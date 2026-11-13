---
id: 20261113-experiment-consolidation
status: in-progress
owner: developer / Codex / GPT-6
roadmap: 无（实验整理）
branch: codex/jev-superagent-consolidated
updated: 2026-11-13
---

# Jev / Super Agent 实验分支整理与交接

## 目标

统一两个实验的阅读与复现入口，接入指定开发分支最新提交和数据集，解释 Jev 现有用途，更新交接材料。

## 范围

- 包含：从 a32c5fd0 建独立 worktree；合入独立 router；保留旧 session-topic 固定快照；适配专项脚本 v2/v2.1；共享选择题定义、统一消融入口及输出；更新材料。
- 不包含：把旧 v0.1 算法移植到新流水线；改变默认产品开关；改金标；重跑付费评测；实现 PM-24～PM-27；删除或改写原实验分支。

## 规格出处

- v3 §2.2.7、§3.2.5、§6.1 #9；ADR-0006 默认关闭。
- standard SHA：架构 7add0a1ca6a1、SDK a4cb1a5137c9、PRD 1ae002441096，与快照相符。
- 旧 session-topic ADR 仅在旧快照内有效，不能覆盖现行规格。

## 验收标准

- [x] fetch 并记录远端最新指定开发分支；数据文件保持一致。
- [x] 整合分支包含两实验提交历史；明确区分实际代码合入与旧版隔离保留。
- [x] 新版项目记忆测试和独立 router 测试通过，类型检查实际结果及基座对照如实记录。
- [x] Jev 专项 v2/v2.1 离线自检通过；生成物不入库。
- [x] 更新实验 HTML、入口、材料与正式交接；不自评 approved。

## 相关工作项

20261106-jev-topic、20261106-superagent-session-topic（仅旧快照）、20261111-human-handoff-docs、20261112-project-memory-audit。原工作项和评审状态不修改。

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-13 | in-progress | developer / Codex | 从 origin/a32c5fd0 建隔离分支整理 |

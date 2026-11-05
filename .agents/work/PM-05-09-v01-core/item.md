---
id: PM-05-09-v01-core
status: changes-requested
owner: developer（待接手）
roadmap: PM-05, PM-06, PM-07, PM-08, PM-09
branch: dev-project-memory-add-search-dev
updated: 2026-11-05
---

# 项目记忆 v0.1：独立存储、异步整理、检索

## 目标

在 `Memory/src/service/project-memory/` 按 v3 模块重写项目记忆，替换旧实现（`memories` 表里的 work_memory 行），做出端到端可跑的 v0.1，用来暴露问题、修订文档。

## 范围

- 包含：schema v10 与 v3 §5.3 的表；`/api/openmem/v1/` 的 Space、domain、add/message、get/status、search/memory、get/memory、get/memory/{id}、delete/memory；按 Space 串行的异步整理任务；决策 / 经验 / 进展合并；ChangeSet 条件写与 OCC 重合并；project 一路检索（FTS5 + 向量，RRF + MMR + 时效）；删除旧实现。
- 不包含：三路召回（W47）、注入模板与渐进式披露（W47）、云端 Store（W48）、`split`、推迟内容回填（W46）。

## 规格出处

- 架构文档 v3 §1.6、§2.2.5–§2.2.11、§2.3、§3.2、§5.1、§5.1.5、§5.3
- open-questions Q-03（不实现 start_conversation）、Q-04（create_space 由 MemOS 生成 space_id）

## 验收标准

- [x] typecheck 通过；`tests/service/project-memory` 全部通过
- [x] 条件写：409 后库不变；同一幂等键重放不产生副本（store 层）
- [x] PRD「决策的维护」逐轮表 golden 通过（split 除外）
- [x] 同一 Space 串行；检索确定性
- [x] project 行不再进入普通 L1 召回（迁移层面）
- [ ] 评审 MUST 全部关闭（见 review-01）
- [ ] 数据集 v2 上跑出首批数（见 metrics.md）

## 相关工作项

- [PM-03-eval-dataset-v2](../PM-03-eval-dataset-v2/item.md)

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-05 | ready-for-review | developer / Claude Code（独立会话，交接由收尾会话补写） | handoff-01.md |
| 2026-11-05 | changes-requested | reviewer / Claude Code 子代理 | review-01.md |

---
id: PM-18-eval-scheme
status: in-progress
owner: developer / Cursor
roadmap: PM-18
branch: dev-project-memory-add-search-dev
updated: 2026-11-10
---

# 评测集方案

## 目标

按 PRD 待办 3 写出评测集方案：一份可跑数据集、大版本冻结、当前 v2.1 的范围，以及这次明确留下的部分。

## 范围

- 包含：`docs/project-memory/eval-set-scheme.md`；Roadmap 中 PM-18 改为 done，并加一行变更记录。
- 不包含：改 `eval/project-memory/gold-add-memory/dataset/` 与 `history/`；改 `Memory/src`；handoff；提交；推送或改写 `dev-project-memory-search-gold-baseline`；改 q17；复跑阅读上限；给 q40–q47 增加非 plain 题型；把 PM-17 标成 done。

## 规格出处

- PRD「待办」第 3 条（评测集、对照组与开源方式）
- ADR-0004 及 2026-11-10 补记
- `eval/project-memory/gold-add-memory/README.md`、`history/v2/README.md`

## 验收标准

- [x] 方案说明：评分只读 `dataset/`，大版本冻在 `history/<版本>/`，小改动不另存副本
- [x] 方案写明 v2.1（`e5f03e43`）：50 个主题、7 名成员、六个空间、随时间变化的要点、`submit_time` / `resubmitOf` / `deferredUntil` / `history_backfill`、`duplicateRate` 与 `wrongMergeRate`
- [x] 方案写明 q17 答案未改（Q-14）、阅读上限未复跑（E-04）、q40–q47 均为 plain
- [x] 方案写明校验命令。2026-11-10 在 `6f4801ff` 上 `load-eval-set`（errors []）、`selftest`（16/16）、`--oracle`（得分全 1、错误全 0）、`--empty`（得分全 0）均通过
- [ ] 交接评审（本次不写 handoff）

## 相关工作项

- PM-17 仍是 doing：数据集 v2.1 已入库，q17 与阅读上限未收口
- [PM-03-eval-dataset-v2](../PM-03-eval-dataset-v2/item.md)

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-10 | in-progress | developer / Cursor | 方案已写入 docs/project-memory/eval-set-scheme.md；Roadmap 的 PM-18 已标 done。按本次要求不写 handoff，工作项保持 in-progress |

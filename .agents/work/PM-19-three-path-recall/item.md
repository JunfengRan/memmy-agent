---
id: PM-19-three-path-recall
status: in-progress
owner: developer / Cursor
roadmap: PM-19
branch: dev-project-memory-add-search-dev
updated: 2026-11-10
---

# PM-19 M08 三路召回

## 目标

本机 `search_memory` 一次发出三条召回，失败的路写入 `degraded`。不融合，不裁剪，不返回 `memory_detail_list`。

## 范围

- 包含：① `user_memory`、② `detail_factual` / `skill`、③ `project`；每路超时；缺端口或个人检索关闭时降级 ①②
- 不包含：跨路 RRF、relativity 改口径、`memory_detail_list`（PM-20）；交接记录

## 规格出处

- 架构文档 §3.2.3
- ADR-0005 #6；open-questions Q-20、Q-28

## 验收标准

- [x] 请求的每一路要么出现在结果里，要么出现在 `degraded`
- [x] 只请求 project 时，`topic_detail_list` 与 `recall_log` 与现有行为一致
- [x] ② 和 ① 不调用查询改写、LLM 过滤，也不按墙钟改顺序
- [x] typecheck 与项目记忆、recallCandidates 单测通过

## 相关工作项

PM-20

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-10 | in-progress | developer / Cursor | item.md |

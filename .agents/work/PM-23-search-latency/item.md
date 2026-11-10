---
id: PM-23-search-latency
status: ready-for-review
owner: reviewer（待接手）
roadmap: PM-23
branch: dev-project-memory-add-search-dev
updated: 2026-11-10
---

# PM-23 检索延迟

## 目标

按 v3 §3.6 测量检索单路、总耗时和渲染 P95，并在金标灌库的库上计算 Recall@1/3/9。不改检索排序、超时和产品返回字段。

## 范围

- 包含：`eval/project-memory/latency/` 脚本与说明；metrics、对齐表、Q-35、Roadmap 状态
- 不包含：提交与交接；算法调参；缩小 `recallPathTimeoutMs`；改 `dataset/` 或 `history/`；把金标灌库 Recall 写进 metrics 索引的 Recall@3

## 规格出处

- 架构文档 §3.6（单路 P95、总 P95、渲染 P95）
- open-questions Q-35（语料规模，待回复）

## 验收标准

- [x] fixture S、stub embedder：第 3 路 P95 0.741 ms，总 P95 1.462 ms，渲染 P95 0.008 ms，超时 0
- [x] 同一检索输入两次 JSON 相同（`--self-check`，q03）
- [x] 金标灌库 Recall@1/3/9 为 0.581 / 0.968 / 0.968，写在 R-20261110-01 正文，不进索引 Recall@3
- 不写交接

## 相关工作项

PM-24（两种存储的 Recall 差）

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-10 | in-progress | developer / Cursor | item.md |
| 2026-11-10 | in-progress | developer / Cursor | S+stub 门槛通过，记录 R-20261110-01。不交接，不提交 |
| 2026-11-10 | ready-for-review | developer / Cursor | handoff-01.md（b5cb5822） |

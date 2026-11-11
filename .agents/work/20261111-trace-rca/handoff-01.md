---
item: 20261111-trace-rca
seq: 01
role: developer
app: Cursor
model: grok-4.7
date: 2026-11-11
branch: dev-project-memory-add-search-dev
base: 81008be7
head: 6a41fcb2
to: reviewer
status: ready-for-review
---

# 交接 01：评测全程追踪和一次带追踪的重跑

## 结论

回放在设置 `MEMMY_EVAL_TRACE_DB` 后会记下每次模型的 messages 和回复、每个任务的记忆 diff、每题提问前的 sqlite 快照，以及阅读输入。检索打分抽成 `scoreProjectTopics`，评测脚本对快照重算同一套名次。产品请求和响应没有新字段。

R-20261111-06 已评分。113 个任务都有 diff，31 题都有快照和打分。9 道错题的归因在 `docs/project-memory/rca/2026-11-11/`。没有按归因改抽取或门槛。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `harness/usage-proxy.mjs` | `--trace` 记 messages 和回复；`POST /__eval/context` 给调用打标签；不写请求头 | 错题要能看到 M02/M04/M05 的原文 | 评测卫生：不进产品契约 |
| `harness/live-trace.mjs`、`store-diff.mjs`、`run-memmy-live-eval.mjs` | 任务后 diff，提问前 backup，阅读 messages | 要看到记忆仓怎么变 | 同上 |
| `harness/explain-search.mjs`、`build-trace.mjs` | 快照上重算打分，合成逐题档案 | 先判断是检索没返回，还是库里没有 | v3 §3.2 的现有排序 |
| `retrieve/search.ts` | 抽出 `scoreProjectTopics` | 评测和产品用同一排序 | 行为不变 |
| `docs/project-memory/rca/2026-11-11/` | 9 道错题 | 本次要的分析 | Q-36 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `node selftest.mjs`（在 gold-add-memory） | 22/22 通过 |
| `npx vitest run tests/service/project-memory/score-project-topics.test.ts` | 3/3 通过 |
| `npm --prefix Memory run typecheck` | 通过 |

评测：R-20261111-06。`answers.llm` 0.710，`entries.f1` 0.828，Recall@3 0.903。entryHit 0.355，低于 R-20261111-01 的 0.387 和 0.419。5 个再次提交的任务没有挂上带原文的模型调用，进度和 diff 都在。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| 抽取把文件名和「已经删掉」整句丢掉，金标却要这些句子 | Q-36，待回复 |

## 评审回应

无上一轮 MUST。

## 留给下一步

- 不要把 R-20261111-06 并进总表均值。
- Q-36 回复前不要改 M02 的丢弃类别。

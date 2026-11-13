---
item: PM-15-restatement-filter
seq: 01
role: developer
app: Cursor
model: grok-4.7-xhigh-fast
date: 2026-11-10
branch: dev-project-memory-add-search-dev
base: e5f03e43
head: c966fc5c
to: reviewer
status: ready-for-review
---

# 交接 01：复述过滤接到整理任务

## 结论

抽取之后会用本会话的召回记录丢掉 Agent 复述。只等于某条 history 的迟交草稿不再写回 conflicts。同一 Space、同一 domain 集合里已经整理过的消息只作上下文。评测未跑，G-05 仍是 open。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `pipeline/organize-job.ts` | 抽取后调用 `filterRestatements` 一次 | 重试不能把丢掉的复述找回来 | v3 §2.2.5、§3.4 |
| `store/sqlite/local-state.ts` | `recalledIds` | 召回记录是复述的依据 | v3 §3.2.5 |
| `prompts/extract.ts` | 升到 `pm-extract-v0.2.2`，可标 `restates` | 模型的说法必须对得上召回 | v3 §2.2.5 |
| `merge/merge.ts` | 决策带 `pastContents` | 旧版不能再当当前或新分歧 | v3 §2.2.9、Q-26 |
| `local-state` / `organize-job` | 已完成任务覆盖过的消息不再抽取 | 重复提交不该再写一遍 | Q-27 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过，exit 0（交接前重跑） |
| `cd Memory && npx vitest run tests/service/project-memory` | 13 个文件、103 个测试通过、1 个既有 todo（Q-23） |

评测：未跑。提示词升了版本，数据集 v2.1 上的复测仍欠着。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| 经验和轨迹的召回只用主题上的当前内容，因为 recall_log 没有它们的 id | ADR-0005 2026-11-10 补记 |
| 非迟交且只等于 history、没有原因也没有裁决信号，按复述丢掉 | Q-26 |
| 已整理过的消息只作上下文 | Q-27 |
| 内容作者加入已有 conflict 仍可能挪空成员 | Q-23，未改 |

## 评审回应

无。

## 请 reviewer 重点看

1. `Memory/src/service/project-memory/pipeline/organize-job.ts:331` — 过滤只在抽取之后跑一次。
2. `Memory/src/service/project-memory/merge/merge.ts:214` — 只等于 history 的迟交不产生 op。
3. 用户消息即使文本和召回相同也不丢。
4. 推迟回填仍按原 task id 读原文。
5. 幂等键和失败重交没有被改掉。

---
item: 20261106-review-triage
seq: 01
role: developer
app: Cursor
model: Claude Opus
date: 2026-11-06
branch: dev-project-memory-add-search-dev
base: 64c5397c
head: dfd9c193
to: reviewer
status: ready-for-review
---

# 交接 01：评审意见分诊，修复 relativity 阈值

## 结论

用户转来的 17 条 add / search 意见已逐条给出结论和去向（见 `item.md` 分诊表）。代码只改了两处：relativity 阈值改为按每个主题自身相关度过滤，`recallQuery` 改用 `clampText`。其余意见并入 PM-12、PM-13、PM-16、PM-19～PM-22 的范围与验收，需要设计决定的写成 open-questions Q-15～Q-21。Add-3、Search-2、Search-5 与 v3 冲突，用户已确认按 v3 不改（Search-2 挂 Q-19）。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `retrieve/search.ts` | 抽出 `assignRelativity`：先按自身相关度（四位小数）过滤阈值，再取累计最小值作为显示的 relativity | 原实现对累计最小值过滤，MMR 排在前面的较弱主题会把后面更相关的主题压到阈值下被丢掉 | v3 §3.2.5（relativity 单调） |
| `pipeline/organize-job.ts` | `recallQuery` 改用 `clampText` | 评审 NIT；`clampText` 同样按码点截断，不切开代理对 | — |
| `tests/.../search.test.ts` | 新增 `assignRelativity` 单测 | 复现「弱主题在前、强主题在后、阈值 0.5」的情形 | v3 §3.2.5 |
| `ROADMAP.md` | PM-12、PM-13、PM-16、PM-19～PM-22 补范围与验收；变更记录一行 | 已排期的意见落到具体条目 | — |
| `open-questions.md` | 新增 Q-15～Q-21 | 需要 designer 决定的点 | — |
| `spec-alignment.md` | §2.2.10、§3.2.5 两行补现状 | 文档随代码 | — |
| `decisions/0005-v01-simplifications.md` | 末尾补记：#9 只覆盖 `session_start`，`via=tool` 由 PM-21 收回 | ADR 只追加 | v3 §3.3.5 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过（exit 0，在 head `dfd9c193` 上重跑） |
| `cd Memory && npx vitest run tests/service/project-memory` | 7 个文件、31 个用例全部通过 |
| 把 `assignRelativity` 临时改回「先累计再过滤」后跑 `search.test.ts` | 新用例失败（1 failed / 3 passed），恢复后 4 passed |

评测：未跑。relativity 只在调用方传阈值时生效，评测回放不传 `relativity`，排序与截断不变。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| relativity 仍用词法 / 向量相关度，不是融合分归一 | Q-01；PM-20 |
| recall_log 一律 `turn_start` | ADR-0005 补记；Q-17；PM-21 |
| 缺 `chat_time` 时任务批次键与 v3 去重口径不一致；失败批次无法重交 | Q-15、Q-16；PM-16 |

## 评审回应

无（第一轮）。来源意见不是 `review-NN.md`，逐条处理见 `item.md` 分诊表。

## 请 reviewer 重点看

1. `Memory/src/service/project-memory/retrieve/search.ts:112` — 阈值按四舍五入后的自身相关度比较，显示值是累计最小值；确认保留的每项显示值都不低于阈值，且列表单调。
2. `.agents/work/20261106-review-triage/item.md` 分诊表 — Add-1、Add-2 的判断（真正的偏差在批次键和失败重交，不在 `idempotency_key` 与共用预算）是否成立。
3. `docs/project-memory/open-questions.md` Q-15～Q-21 — 提议是否与 v3 一致，是否有该直接实现而被推给 designer 的。

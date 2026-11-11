---
item: 20261111-closeout-eval
seq: 01
role: reviewer
app: Cursor
model: grok-4.7
date: 2026-11-11
reviewed: handoff-01.md, handoff-02.md, handoff-03.md, handoff-04.md, handoff-05.md, handoff-06.md
range: 47355fa0..工作区
verdict: approved
---

# 评审 01：v2.1 收尾评测可以进总表

## 复核验证

没有重跑六次模型回放。对照了各份 `report.json` 和交接里的 answers.llm、entries.f1、Recall@3、费用。当前版本两次、旧实现、main、金标检索、阅读上限都对得上。展示页表里的主题数、B³ 精确率、召回、F1、条目 F1 与三份报告的原值一致（运行 B 精确率 0.894、召回 0.575）。

`node selftest.mjs` 在开销改动后为 19/19。展示脚本按交接里的命令可以重新生成页面。

| 命令 | 结果 |
| --- | --- |
| 对照 report.json 与交接中的主指标 | 一致 |
| 展示页表与三份 report 的 bcubed / entries.f1 / 主题数 | 一致 |

## 上一轮 MUST 的关闭情况

无。这是第一轮。

| 意见 | 结果（已关闭 / 未关闭 / 转裁决） | 说明 |
| --- | --- | --- |

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | NIT | `add-showcase.html` | 卡片没有逐主题标出拆开和误并 | 正文完全相等只对上 2 条，报告是 9 和 3。评委匹配不是逐字相等 | 保持不标。合计留在跷跷板一节，避免把对不上的标签画上去 | 页上写明 2 与 9/3 的差别 |

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| 被测与回答都是 deepseek-v4.1-flash-1017，裁判是 gpt-6-luna 且费用单列 | 是 | 五份 report 的 efficiency.judge 与 answer 分开 |
| Add / Search / 回答有调用数、缓存未命中、缓存命中、输出、费用；无调用记 0 | 是 | 金标检索的报告把 Search 写成 null，metrics 记 0 并注明原因 |
| 当前版本两次、旧实现、main、金标检索、阅读上限都有原始 JSON | 是 | `runs/2026-11-11T04-*` 与 `03-56` |
| 失败的格子不沿用旧数 | 是 | 向量失败的 main 回放和第一次当前版本回放都未评分 |

## 需要 designer / 用户裁决

无。经验 F1 仍为 0、重复主题率高于 2%，记在 Roadmap，不作为本工作项的 MUST。

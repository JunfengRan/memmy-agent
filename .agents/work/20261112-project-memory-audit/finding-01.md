---
item: 20261112-project-memory-audit
role: developer
app: Codex
model: GPT-6
date: 2026-11-12
---

# 在线冒烟追加发现：M05 缺少旧摘要和描述

首次两轮合成回放（原始输出 `eval/project-memory/runs/20261112-audit-smoke/`，不进 git）中，同一作者把重试次数从三次改为五次。决策与 history 正确，但旧描述仍写三次。判断模型返回 `topic_updates: []`。

`merge/judge.ts:buildJudgeMessages` 给模型的 topics 只有 domain、决策和经验，没有 `topic_summary`、`topic_description`，模型无法比对本来要改写的文字。v3 §2.2.7 与 ADR-0007 已规定此职责，不属于待裁决项。

追加修补项 D1（按 MUST 处理）：在判断输入中带上目标主题当前摘要与描述，提示词升至 pm-judge-v0.3.1，说明比对当前字段；先补输入回归，再重跑在线冒烟。保留 ADR-0007 的调用顺序差异，不新增模型调用点，不改变归属与合并规则。首轮结果只证明决策正确，不能宣称描述一致；后续结果分开登记，不覆盖首轮原始输出。

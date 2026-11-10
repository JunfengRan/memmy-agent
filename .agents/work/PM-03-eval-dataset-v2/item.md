---
id: PM-03-eval-dataset-v2
status: done
owner: —
roadmap: PM-02, PM-03, PM-04
branch: dev-project-memory-add-search-dev
updated: 2026-11-10
---

# 评测数据集与脚本 v2

## 目标

把 `eval/project-memory/gold-add-memory/` 改成与 v3 对齐的数据集 v2：一份数据、金标按规格重推、冲突按作者判定、runner 只调规格接口、指标按规格计数。

## 范围

- 包含：数据集去重与生成物移出 git；语料补成员、会话、chat_time、认可 / 已告知信号；金标重推；题目清理与接口检查；runner、scorer、judge、reader。
- 不包含：数据集 v2.1 扩充（PM-17，W46）。

## 规格出处

- 架构文档 v3 §2.2.5–§2.2.9、§3.2、§3.3.4
- ADR-0004；metrics.md「指标定义」

## 验收标准

- [x] `node load-eval-set.mjs` 无错误
- [x] `--oracle` 每项得分 1、每项错误 0；`--empty` 每项得分 0
- [x] 生成物不进 git
- [x] 报告覆盖 metrics.md「指标定义」的全部指标（R-20261105-02；费用因无单价为 null，附原因）
- [x] 评审 MUST 全部关闭（review-02 approved，R1-1～R1-3）

## 相关工作项

- [PM-05-09-v01-core](../PM-05-09-v01-core/item.md)

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-05 | ready-for-review | developer / Claude Code（独立会话，交接由收尾会话补写） | handoff-01.md |
| 2026-11-05 | changes-requested | reviewer / Claude Code 子代理 | review-01.md |
| 2026-11-05 | ready-for-review | developer / Claude Code（收尾会话） | handoff-02.md |
| 2026-11-10 | approved | reviewer / Cursor | review-02.md |
| 2026-11-10 | done | developer / Cursor | review-02.md 已通过；代码在 672919d5 |

---
id: PM-14-decision-split
status: done
owner: reviewer
roadmap: PM-14
branch: dev-project-memory-add-search-dev
updated: 2026-11-10
---

# 决策 split 与 informed golden

## 目标

补上决策 op `split`，并为已有的 conflict_update、resolve、informed 判定补 golden。informed 仍要求 recall_log 的 had_conflicts 与判断调用的 informed id 同时成立。

## 范围

- 包含：`split` 的契约、判断标签、确定性合并、条件写校验；decision golden；store 回滚用例；Q-23；ADR-0005 补记。
- 不包含：改 join 清空 content 成员的行为（Q-23 / G-06）、迟交挪成员（Q-09）、认可规则（Q-12）、把 `organize/restatement.ts` 接到任务上（PM-15 其余部分）、现场评测、交接记录、提交。

## 规格出处

- 架构文档 §2.2.9
- ADR / open-questions：ADR-0005 第 1 条（PM-14 收回）、Q-10、Q-23

## 验收标准

- [x] conflict_update：作者改自己的 conflict，content 不变，该项 content / time 更新，无 history
- [x] conflict_update 带加入者：加入者留在该项上
- [x] 已告知后 resolve pick "new" / "content"
- [x] 检索展示过分歧后 split 成两条；未检索则不 split，内容作者走 rewrite
- [x] had_conflicts 与 informed id 缺一则不 resolve；草稿文本等于 conflict 时仍是 resolve
- [x] 超长片、已有 id、缺保留 id、只有一片、无 conflict 的 split 整笔不写
- [ ] G-06 的 join 清空 content（Q-23，it.todo，不实现）
- [ ] 评测未跑

## 相关工作项

- PM-12-split-organize
- PM-13-deferred-backfill
- PM-15（复述过滤，本项不接线）

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-10 | in-progress | developer / Cursor | item.md |
| 2026-11-10 | ready-for-review | developer / Cursor | handoff-01.md（bb2f0a70） |
| 2026-11-10 | done | reviewer / Cursor | review-01.md（无 MUST，2 SHOULD） |

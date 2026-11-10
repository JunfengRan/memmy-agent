---
id: PM-20-rank-fusion
status: done
owner: reviewer
roadmap: PM-20
branch: dev-project-memory-add-search-dev
updated: 2026-11-10
---

# PM-20 跨路按名次融合

## 目标

M09 把三路候选只按名次做 RRF，用融合分归一 relativity，再做跨路 MMR 和统一截断。不提交。

## 范围

- 包含：`retrieve/fuse.ts`；project 路排序在融合前丢掉没有快照的主题；relativity 阈值在 MMR 之前按自身融合分过滤；`recall_log` 只记实际返回的主题，`via` 缺省 `turn_start`
- 不包含：提交与交接；PM-21 工具检索；PM-22；改列表名为 `memory_detail_list`（Q-29）；改过期向量整次退词法（Q-30，ADR-0005 #11）；评测集与 history

## 规格出处

- 架构文档 §3.2.5、§3.5
- ADR-0005 #6（融合部分收回）、#11（不收回）；open-questions Q-01、Q-29、Q-30

## 验收标准

- [x] 同一输入两次结果一致；返回列表的 relativity 单调
- [x] 不透传原始分数；名次相同按 user_memory、agent_memory、project
- [x] 只请求 project 时，第一名仍是原来的第一名
- [x] typecheck 与 `tests/service/project-memory`、`recall-candidates.test.ts` 通过（135 passed，1 todo；评审复核，不是 167）
- [ ] 交接（本轮不写 handoff，代码未提交）

## 相关工作项

PM-19、PM-21、PM-22

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-10 | in-progress | developer / Cursor | item.md |
| 2026-11-10 | ready-for-review | developer / Cursor | handoff-01.md（b78996ac） |
| 2026-11-10 | done | reviewer / Cursor | review-01.md（approved，0 MUST） |

---
id: PM-15-restatement-filter
status: done
owner: reviewer
roadmap: PM-15
branch: dev-project-memory-add-search-dev
updated: 2026-11-10
---

# 复述过滤、history 不回写、会话去重

## 目标

把 PM-15 接到整理路径：抽取后按本会话召回丢掉复述，合并时 history 不再当新结论写回，同一 Space、同一 domain 集合里已完成任务整理过的消息不再抽取。

## 范围

- 包含：`recalledIds`；`filterRestatements` 在 organize job 里调用一次；抽取提示词 `pm-extract-v0.2.2`；决策 `pastContents` 与 Q-26；会话去重 Q-27；ADR-0005 补记、对齐表、G-05、Q-26、Q-27
- 不包含：评测；交接；改 `split`、Q-23 的 join、PM-16 的批次重提与幂等键；`eval/`

## 规格出处

- 架构文档 §2.2.5、§2.2.9、§3.4
- ADR / open-questions：ADR-0005 第 3 条；Q-26、Q-27

## 验收标准

- [ ] 迟交且只等于 history 的草稿不写
- [ ] 非迟交、无原因、无裁决信号的 history 复述不改当前内容
- [ ] 助手复述他人 conflict 不 join；没有事先检索时同一草稿会合并
- [ ] `TOPIC_SET_CHANGED` 不把丢掉的复述找回来，抽取只跑一次
- [ ] 同一 Space、同一 domain 集合的已完成消息不再抽取；另一 Space、另一 domain 集合、失败任务仍然整理
- [ ] 评测未跑

## 相关工作项

- PM-12、PM-13、PM-14、PM-16 已完成，本项不改它们的交接记录

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-10 | in-progress | developer / Cursor | item.md |
| 2026-11-10 | ready-for-review | developer / Cursor | handoff-01.md（c966fc5c） |
| 2026-11-10 | done | reviewer / Cursor | review-01.md（approved，0 MUST） |

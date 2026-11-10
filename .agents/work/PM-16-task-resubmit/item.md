---
id: PM-16-task-resubmit
status: in-progress
owner: developer / Cursor
roadmap: PM-16
branch: dev-project-memory-add-search-dev
updated: 2026-11-10
---

# 任务重提与并发验收

## 目标

按 Q-15、Q-16 补齐批次键和失败重提，并把 v3 §2.3.1 的并发验收写进单测。

## 范围

- 包含：推断时间进入 `batchKey`；可重试失败新建任务并只重排队失败的 Space；冲突耗尽时把历次冲突类型写入 detail；并发与故障注入单测
- 不包含：C01 不变式校验（改到 PM-24）；毫秒级 `chat_time`；复述过滤；在线评测；交接

## 规格出处

- 架构文档 §2.2.2、§2.2.10、§2.2.11、§2.3.1
- ADR / open-questions：Q-15、Q-16、Q-24、Q-25；ADR-0005 第 10 条改到 PM-24

## 验收标准

- [x] 缺 `chat_time` 时，时钟前进两秒的两次同文提交各自整理；同一秒仍是一条任务
- [x] 同一 `chat_time` 在完成后重放返回原 task_id，不再抽取
- [x] `MODEL_CALL_FAILED` 与 `VERSION_CONFLICT_RETRY_EXHAUSTED` 可以重提为新任务；旧任务保持 failed
- [x] `SPACE_CLEARED` 以及任一 Space 不可重试时返回原任务
- [x] 冲突耗尽不落 deferred；重提成功后才写入
- [x] 并发：其他领域新建不触发围栏；拒绝的提交不留半写入；三人同时新建最终 1 个主题

## 相关工作项

- PM-12、PM-13、PM-14 已完成，本项不改它们的交接记录
- C01 见 PM-24

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-10 | in-progress | developer / Cursor | item.md |

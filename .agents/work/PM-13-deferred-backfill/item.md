---
id: PM-13-deferred-backfill
status: ready-for-review
owner: reviewer（待接手）
roadmap: PM-13
branch: dev-project-memory-add-search-dev
updated: 2026-11-10
---

# 推迟片段回填

## 目标

同一调用方会话、同一 Space 的下一次整理，把尚未解决的推迟片段和本批消息一起再判。认领后删除原行。`topic_unavailable` 与清空前受理的行不再进入抽取。

## 范围

- 包含：`pendingDeferred` / `settleDeferred` / `forgetDeferred`；M02 输入 `deferred_turns` 与 `deferred_segments`；草稿上的 `backfillOf` 穿过 M03、M04、M05 和合并；清空 Space 时丢掉推迟行；提示词升到 `pm-extract-v0.2.1`；Q-22 与 ADR-0005 补记。
- 不包含：表结构变更、新的 ADR、幂等键改写（PM-16）、现场评测、交接记录。

## 规格出处

- 架构文档 §2.2.7、§4.5
- ADR / open-questions：ADR-0005 第 4 条（PM-13 收回）、Q-22

## 验收标准

- [x] 同一会话的下一条消息能把推迟句写回，时间与作者取自原轮次，原行删除，本批 `deferred_count` 只计新推迟
- [x] 模型原样带回 ref 时保留同一行；之后可以认领
- [x] `topic_unavailable` 不回填；已删除主题不被这条路径重建
- [x] 清空 Space 后旧行消失，下一条消息不回填
- [x] 其他会话、匿名会话、其他 Space 看不到这批行
- [x] 模型调用失败时行还在，下一次任务可以重试
- [x] `VERSION_CONFLICT` 只写一次；`TOPIC_SET_CHANGED` 保留 `backfillOf`；提交后的重放删行且不复制条目
- [ ] 推迟内容回填 ≥90%（没有新的评测数字；阅读模型网关 2026-11-10 返回 503）

## 相关工作项

- PM-12-split-organize（M02 / M04 已拆开，本项在其上加回填）
- PM-16（幂等键仍不包含回填 id）

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-10 | in-progress | developer / Cursor | item.md |
| 2026-11-10 | ready-for-review | developer / Cursor | handoff-01.md（7bc8ca04） |

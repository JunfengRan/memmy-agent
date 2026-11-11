---
id: 20261106-superagent-session-topic
status: in-progress
owner: developer / Cursor
roadmap: 无
branch: feat/superagent-session-as-topic
updated: 2026-11-06
---

# 用 super agent 的 session 路由作为项目记忆 topic

## 目标

把 dsh-superagent 的 `orchestrator_route` 嵌进项目记忆。router 分配的 session 就是 topic。写入仍抽取并合并条目，但主题由 router 锁定。提问由同一个 router 从该 Space 已有 session 中选择，回答只使用这些 topic。评测看数据集 v2 的最终回答准确率。

## 范围

- 包含：`route/` 与 `prompts/route.ts`；`add/message` 组织前路由；`search/memory` 的 retrieve；组织提示词锁定 session；ADR-0006 与对齐表。
- 不包含：启动 DeepSeek Harness；用金标主题 id 重算归类准确率；持久关闭被 stop 的 session；多轮工具循环。

## 规格出处

- dsh-superagent `prompts/dispatch.md`（accept / attach / ignore / stop）
- v3 §2.2.7、§3.2.5、§6.1 #9
- ADR-0006

## 验收标准

- [x] 写入：accept 新建一个 topic，attach 写入已有 topic，ignore 不组织
- [x] 组织模型不能把条目放到另一个 topic
- [x] 提问：search 只返回 router 选出的 session，并带上 conflicts / history
- [x] 数据集 v2 跑出 `answers.llm`：0.652（15/23），记录 R-20261106-01

## 相关工作项

无

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-06 | in-progress | developer / Cursor | item.md |
| 2026-11-06 | in-progress | developer / Cursor | 评测 R-20261106-01 已写入 metrics.md |

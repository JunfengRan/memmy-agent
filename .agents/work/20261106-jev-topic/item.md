---
id: 20261106-jev-topic
status: in-progress
owner: developer / Cursor
roadmap: 无
branch: dev-project-memory-add-search-dev
updated: 2026-11-06
---

# Jev 主题归属实验（默认关闭）

## 目标

用 Jev 决策模型做两件实验：add 时判断 query 和回答属于哪个 topic，search 时选出对应 topic。召回单独评测。产品路径默认关闭，不挡住主开发。

## 范围

- 包含：SystemOne 客户端、add 收窄候选、search 把选中 topic 移到第一位、单独评测脚本、ADR-0006。
- 不包含：把 Jev 设为默认模型；改 M02/M04 提示词；重跑主 add/search 回放。

## 规格出处

- 架构文档 v3 §2.2.7、§3.2.5、§6.1 #9
- ADR-0006

## 验收标准

- [x] 未设置 `MEMMY_DECISION_TOPIC=1` 时 add/search 不调用决策模型
- [x] 设置后，add 按选择收窄候选，search 把选中 topic 放到第一位；失败或 `none` 不改变原路径
- [x] 单测覆盖 Decisions 请求体、收窄、提前和默认关闭
- [x] 单独评测写出 add 归属准确率和 search topic Recall@1/3/9，并记入 metrics.md（R-20261106-01）
- [x] 产品开关保持默认关闭

## 相关工作项

无。在线评测已经跑过，记为 metrics R-20261106-01。

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-06 | in-progress | developer / Cursor | item.md |
| 2026-11-06 | in-progress | developer / Cursor | 改为 OpenAI Decisions；`~/.openai.env` 不存在，在线评测未跑 |
| 2026-11-06 | in-progress | developer / Cursor | 在线评测已跑，见 metrics R-20261106-01；产品开关仍默认关闭 |

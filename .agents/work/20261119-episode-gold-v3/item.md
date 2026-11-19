---
id: 20261119-episode-gold-v3
status: ready-for-review
owner: developer / Codex
roadmap: 无
branch: codex/project-memory-gold-v3
updated: 2026-11-19
---

# 项目记忆数据集 v3

## 目标

按会话中可核对的工作目标重标语义 Episode 与 Topic，并给出可重放的内容可见时点。

## 范围

冻结 v2.1、新增 v3 标签与参考回放、更新生成和评分。验证使用离线金标和固定时钟。产品模型与提示词沿用各实现。

## 规格出处

- 用户确认的 v3 金标实施计划。
- `design-docs/review/Add开发文档.md` 的 Episode 关闭、Default Topic、Formation 与索引可见性条款。评审文档为单独分发资料。
- `eval/project-memory/gold-add-memory/README.md` 的数据版本与验证说明。

## 验收标准

- [x] 113 条轨迹中的 108 个原始 Turn 均有基于原文的唯一语义 Episode 标注。
- [x] 冻结的 v2.1 可按原口径重新生成、检查与评分。
- [x] v3 生成器、校验器与评分器覆盖开放、暂存、发布与旧结论时点。
- [ ] 独立评审。

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-19 | ready-for-review | developer / Codex | [handoff-01.md](handoff-01.md) |
| 2026-11-19 | changes-requested | reviewer / Codex | [review-01.md](review-01.md) |
| 2026-11-19 | ready-for-review | developer / Codex | [handoff-02.md](handoff-02.md) |

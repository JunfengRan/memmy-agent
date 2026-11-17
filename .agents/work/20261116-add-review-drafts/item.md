---
id: 20261116-add-review-drafts
status: ready-for-review
owner: designer / Claude Code
roadmap: 无（评审设计稿，不是实施条目）
branch: dev-project-memory-add-search
updated: 2026-11-16
---

# Add 评审设计稿三份：算法设计、任务队列与调度、会话线程即主题

## 目标

按研发计划「记忆写入（MemOS）」五项（事实存储、任务队列与调度、抽取、归类、摘要与描述，均要求 11/16 完成评审设计稿），以 `design-docs/standard/模块方案评审.md` 为模板，产出供 11/17 评审使用的设计稿；另出一份质疑现行架构的简化方案讨论稿。

角色：designer；应用：Claude Code；模型：Fable 5.2。

## 范围

- 包含：三份 Markdown（`design-docs/review/`，该目录不进 git）；为稿件准备的两组不调付费模型的实验（`eval/project-memory/runs/20261116-add-stage-timing/`、`eval/project-memory/runs/20261116-add-quality-baseline/`，目录已忽略）；`docs/project-memory/metrics.md` 追加 R-20261116-02、R-20261116-03。
- 不包含：产品代码、提示词、`design-docs/standard/`、ADR、Roadmap、`open-questions.md`、`spec-alignment.md` 的任何改动；付费评测；实施裁决。稿中发现的规格冲突与口径问题只写进各稿第 7 章，等评审或 designer 裁决。

## 规格出处

- 架构文档 V4（SHA 前缀 `1e2e0db92f92`）§2.1–§2.4、§4.12、§5.2–§5.4、§6.5；《代码组织、接口与接入设计》§2.2、§2.5、§2.6；研发计划第三节「记忆写入」。
- ADR / open-questions：ADR-0006、ADR-0007、ADR-0009、ADR-0013；`findings.md` §6。

## 验收标准

- [x] 稿一、稿二按评审模版 §0–§8 填写，无空节；稿三为裁剪后的短稿。
- [x] 研发计划五项指标逐项给出现状、能否达到、调整后的口径与风险。
- [x] 任务队列稿包含各步骤的依赖关系、实测耗时与调度方案对比。
- [x] 所有数字标明实测、模拟、目标或估计，并能在 `metrics.md` 或实验目录里找到出处；所有 Jev 相关数字标明不是原生 Jev 的实测。
- [x] 7 张 Mermaid 图经 mermaid.js 渲染通过并人工看过。
- [ ] Cursor 预览检查：未运行。`design-docs/.tools/cursor-mermaid-check.mjs` 依赖的 Cursor 内置文件在本机已不存在。
- [ ] 独立评审：未进行。本工作项的 ready-for-review 只表示稿件可读，不表示方案已被采纳。

## 相关工作项

- [20261116-jev-possibilities](../20261116-jev-possibilities/item.md)：Jev 判断点的研究稿，本次稿一 3.5 引用其 A01–A19 的划分与风险。

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-16 | ready-for-review | designer / Claude Code / Fable 5.2 | research-01.md |

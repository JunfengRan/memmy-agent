---
id: 20261111-closeout-eval
status: done
owner: dispatcher / Cursor
roadmap: PM-12, PM-13, PM-23, PM-27
branch: dev-project-memory-add-search-dev
updated: 2026-11-11
---

# v2.1 收尾评测与开销口径

## 目标

在数据集 v2.1 上，用统一口径补齐当前版本、旧实现和 main 的端到端结果，以及金标记忆上的只测检索和阅读上限。开销按 Add、Search、回答分开，裁判不计。

## 范围

- 包含：`pricing.json` 与 `efficiency()` 的开销统计；`harness/run-search-on-gold.mjs`；`build-add-showcase.mjs` 与 `docs/project-memory/add-showcase.html`；评测运行与 `metrics.md` 记录。
- 不包含：v0.1（`672919d5`）重跑；v2 数据集；产品检索排序或提示词改动；云端 PM-24 及以后。

## 规格出处

- 架构文档 §2.4、§3.6
- ADR-0009

## 验收标准

- [ ] 被测与回答都是 deepseek-v4.1-flash-1017，裁判是 gpt-6-luna 且费用单列
- [ ] Add / Search / 回答三段都有调用数、缓存未命中、缓存命中、输出、费用、P50、P95；无调用记 0
- [ ] 当前版本端到端两次、旧实现一次、main 一次、金标只测检索一次、阅读上限一次，原始 JSON 在 `eval/project-memory/runs/`
- [ ] 跑失败的格子写「未跑」和原因，不沿用 `47355fa0` 里的旧数

## 相关工作项

PM-12、PM-13、PM-17、PM-23 的「待复测」由这次结果关闭或保持。

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-11 | in-progress | dispatcher / Cursor | item.md |
| 2026-11-11 | done | reviewer / Cursor | review-01.md |

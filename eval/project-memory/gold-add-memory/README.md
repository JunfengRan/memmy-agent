# 项目记忆 Search Gold 基线

本目录从 `main` 分支创建的 `codex/project-memory-search-gold-baseline` 分支上构建。`dataset/` 是从 alpha 先行开发版本复制的输入，`generated/extracted-gold.json` 是按 `design-docs/standard` 的 `add_message` 三类条目规则做的可重复 mock 抽取结果。

## 生成与校验

```bash
node eval/project-memory/gold-add-memory/build-gold-baseline.mjs
node eval/project-memory/gold-add-memory/build-sessions.mjs
node eval/project-memory/gold-add-memory/load-eval-set.mjs
node eval/project-memory/gold-add-memory/build-report.mjs
```

期望输出分别包含 `16 entries`、`sessions written`，以及 `errors: []`。报告在 [report.html](./report.html)，展示 5 条时间线、30 道问题的证据/陷阱映射和 Memmy Search 评分方法。

## 来源与复核

- 原始文本、证据 ID、问题和 goldAnswer 均从 alpha 复制，未重新手工生成。
- `generated/review.json` 记录旧 `decisions.json` 中 4 条越界标签：`d_copy`、`d_price`、`d_export`、`d_csv` 改为 `experience`。
- mock 只重建结构和字段归类；真实 Memmy `add_message`、worker、embedding、云端任务状态仍需在 Search 联调时运行。

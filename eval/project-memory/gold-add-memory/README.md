# 项目记忆 Search Gold 基线

本目录从上一轮的 `codex/project-memory-search-gold-baseline` 复制到当前开发分支。`dataset/` 是从 alpha 先行开发版本复制的输入，`generated/extracted-gold.json` 是按 `design-docs/standard` 的 `add_message` 三类条目规则做的可重复 mock 抽取结果。

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

## SDK 接口实现

`Memory/src/client/openmem-cloud-client.ts` 已补齐 standard 所需的项目记忆字段：`space_ids`、`domains`、`allow_memory_view` / `include_memory_view`，并新增 `OpenMemCloudClient.searchMemory()`。当请求显式包含 `project` 时，客户端会在发出请求前校验 `user_id`、非空 `space_ids` / `domains`、20 个空间与群聊成员上限；`searchMemory()` 还校验 `memory_limit_number` 为 1–25 的整数。Local 的 `/api/v1/memory/add` 和 `/api/v1/memory/search` 也已接入 project 分支：写入调用已配置的 summary 模型抽取 decision / experience / evolution，检索按 `space_ids`、`domains` 硬过滤，并可由同一模型生成 `answer`。

## 三阶段评测门禁

`run-pipeline-eval.mjs` 把一次真实 Memmy 运行拆成三段：

1. **add**：比较写入链路生成的 `kind/topicId/sourceTraceIds`，输出 precision、recall、F1。
2. **search**：按每题的证据与陷阱 trace ID 计算 evidence recall、trap rate、scope leak rate。
3. **answer**：用 `mustInclude` / `mustNotInclude` 对最终模型回答计算准确率和陷阱率。

先用 oracle 验证评分器本身：

```bash
node eval/project-memory/gold-add-memory/run-pipeline-eval.mjs --oracle
```

真实 Memmy 运行需把三阶段采集结果写成 JSON，再运行：

```bash
node eval/project-memory/gold-add-memory/run-pipeline-eval.mjs path/to/memmy-run.json
```

真实运行建议至少重复 3 次，并同时保留每题证据、rank、延迟、token 与最终回答；oracle 的 1.0 结果只是评分器 smoke test，不代表产品效果。

本分支已用当前 Memmy 配置中的 `claude-haiku-5-5` 跑过真实 Local HTTP 回放：7 个项目会话经 project add 写入，25 个模型条目落入隔离 SQLite；30 道问题经 project search 检索并调用同一模型生成答案。当前结果记录在 `generated/live-report.json`：add 严格 topic 对齐 F1=0（模型生成的 topic_id 与 reviewed gold 不同，且抽取出 25 条）；search evidence recall=0.871、trap rate=0.704、scope leak=0；最终回答准确率=0.300、trap rate=0。该结果是真实模型结果，不能与 oracle 的 1.0 混用；同一配置重复运行会有模型输出和排序波动。

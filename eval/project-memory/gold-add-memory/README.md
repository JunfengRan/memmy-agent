# 项目记忆 add + search 评测

本目录从上一轮的 `codex/project-memory-search-gold-baseline` 复制而来。`dataset/` 是从 alpha 先行开发版本复制的输入。`generated/extracted-gold.json` 是按 `design-docs/standard` 的 `add_message` 三类条目规则复核后的金标，可重复生成。

## 生成与校验

```bash
node eval/project-memory/gold-add-memory/build-gold-baseline.mjs
node eval/project-memory/gold-add-memory/build-sessions.mjs
node eval/project-memory/gold-add-memory/load-eval-set.mjs
node eval/project-memory/gold-add-memory/run-pipeline-eval.mjs --oracle
node eval/project-memory/gold-add-memory/run-pipeline-eval.mjs --empty
node eval/project-memory/gold-add-memory/build-report.mjs
```

期望输出：

- `build-gold-baseline.mjs` 输出包含 `"entries":28` 和 `"topics":19`；
- `build-sessions.mjs` 输出 `sessions written`；
- `load-eval-set.mjs` 输出 `errors: []`；
- `--oracle` 的各项质量指标为 1（Recall@1 例外，见下文）；
- `--empty` 的各项质量指标为 0。

oracle 和 empty 不调用评委模型。完全等于 goldAnswer 的回答、空回答，以及文本与 gold 完全一致的条目，都由规则直接判定。报告在 [report.html](./report.html)。

## Reviewed gold

- 原始文本、证据 ID、问题和 goldAnswer 均从 alpha 复制，没有重新手写。
- `generated/review.json` 记录了以下复核：
  - 旧 `decisions.json` 中有 4 条越界标签，`d_copy`、`d_price`、`d_export`、`d_csv` 改为 `experience`；
  - 新补的 12 条当前状态事实（`addedEntries`）。以 `t_ledger_round`、`t_cat_tz`、`t_admin_claim` 为例，题目要问它们，但旧 gold 没有收录。
- 每条 entry 带以下字段：
  - `goldTopic`：按工作对象分成 19 组，说明见 `review.topicGroups`；
  - `asOf`：该状态成立的时间；
  - `staleTexts`：这条事实的旧版或被压过的说法，由 `trace.supersedes` 与 `conflicts.json` 的胜负推出。
- 被取代或被压过的轨迹（`t_verbose`、`t_copy`、`t_sample`、`t_write_*`、`t_silent`）不进当前状态 gold，只出现在 `staleTexts` 里。

## 真实回放

`run-memmy-live-eval.mjs` 按时间交错回放。题目按 `askedAt` 排序；每题提问前，只把 `at <= askedAt` 的轨迹按会话分块写入（`POST /api/v1/memory/add`），然后调用 `POST /api/v1/memory/search` 并设 `generate_answer: true`。q03（04:00）、q01（06:00）、q02（09:00）因此看到的是提问时的项目状态。

每个请求都记录延迟、HTTP 状态和服务端返回的 `usage`（model、llm_calls、input/output/cached tokens），整轮还记录 wallclock。search 结果按"topic 顺序 → entry 顺序"保留 rank。

服务端的 `usage` 字段只在 `dev-project-memory-add-search-dev` 分支的 Local 实现里有；`dev-project-memory-search-gold-baseline` 分支没有 project add/search 服务端，真实回放要在开发分支上跑。服务必须使用一个全新的 SQLite 文件，因为 project search 只按空间过滤，不按用户过滤。脚本开跑前会检查这一点，库不为空就退出。

```bash
cd Memory && MEMMY_MEMORY_PORT=18961 MEMMY_MEMORY_DB=/tmp/pm-eval/memory.sqlite npx tsx src/server/index.ts
node eval/project-memory/gold-add-memory/run-memmy-live-eval.mjs
node eval/project-memory/gold-add-memory/run-pipeline-eval.mjs eval/project-memory/gold-add-memory/generated/live-memmy-run.json --out eval/project-memory/gold-add-memory/generated/live-report.json
```

服务 token 默认读 `~/.memmy/config.yaml` 的 `memmyMemory.storage.token`，可以用 `MEMMY_EVAL_TOKEN` 覆盖。

## 指标

**add**（用全部 add 写入的最终条目与 28 条 gold 比较）

- **Entry F1**：一对一匹配，要求 kind 相同且评委判定内容是同一事实。不比较 topicId，因为每次运行模型给的 topic 名都不一样；也不比较 sourceTraceIds。
- **内容 F1**：与 Entry F1 相同，但不看 kind。另外报告：
  - kind 混淆矩阵（gold kind → 模型 kind）；
  - stale 条数（模型写的是旧版说法）；
  - 重复条数。
- **Topic 归纳**：只看内容已匹配上的条目，计算模型 topic 聚类与 `goldTopic` 之间的 B-cubed P/R/F1。这个指标与 topic 标签名无关：P 低说明不同事实被并进了同一个 topic，R 低说明同一工作对象被拆散了。同时报告模型 topic 数和 gold topic 数。
- **Source trace 覆盖率**：gold sourceTraceIds 的并集中，有多少出现在模型条目里。只看覆盖率，不参与 F1。

**search 与回答**

- **Recall@k**（k = 1、3、5、10，另加"全部上下文"）：按 rank 取前 k 条 entry 的 traceIds，计算证据轨迹的命中比例，按题宏平均，并按题型报告。q01 有两条证据，所以 oracle 的 Recall@1 是 0.983。
- **检索 trap rate**：上下文里出现陷阱轨迹的题目比例。旧的 scope leak rate 已删除，q20 照常计入其他指标。
- **LLM score**：评委对照题目、提问时间、goldAnswer 和旧说法示例判对错，按 plain、stale、overridden、cross-project、scope-leak 和总体报告。
- **Token F1**：回答与 goldAnswer 的词重合。中文按字切，英文和数字按词切。
- **短语 rubric 准确率**：沿用旧的 `mustInclude` / `mustNotInclude` 判法，只作参考。它会把语义正确但措辞不同的回答判错。

**效率**（add 与 search 分开统计；评委开销单独列出，不计入产品）

- wallclock、请求数、LLM 调用数；
- 平均输入 token（只统计 add，含缓存命中）、平均输出 token；
- 平均费用和总费用（USD）、延迟 P50/P95。

费用按 [pricing.json](./pricing.json) 中对应模型的单价计算，来源是 Anthropic 官方价格页（2026-11-03）。换模型时在这个文件里补单价；模型不在表里时，费用记为 null。

**评委**

- 默认使用 `~/.memmy/config.yaml` 当前 memorySummary 预设对应的 Anthropic 模型，现在是 claude-haiku-5-5，与被测模型相同，所以存在自评偏差。可以用 `MEMMY_EVAL_JUDGE_MODEL`、`MEMMY_EVAL_JUDGE_BASE_URL`、`MEMMY_EVAL_JUDGE_API_KEY` 换成别的评委。
- 结果按输入哈希缓存在 `generated/judge-cache.json`，重复评分同一份运行结果不再调用模型。缓存默认只增不删；提交前加 `--prune-judge-cache`，只保留这次评分用到的结论，让缓存与提交的报告对应。
- `--no-judge` 跳过所有评委指标。

**退出码**

- 默认只出报告，退出码为 0。
- 加 `--gate` 后，Entry F1、Recall@10、LLM score 任一项低于门槛（默认 0.85，可用 `--min-entry-f1`、`--min-recall-at-10`、`--min-llm-score` 调整）时返回 1。
- 输入错误返回 2。

## 当前真实结果

2026-11-03 用 claude-haiku-5-5 跑了一次交错回放，结果在 `generated/live-report.json`。这是单次真实模型结果，同一配置重复运行会有波动，不能与 oracle 的 1.0 混用。

| 阶段 | 指标 | 值 |
| --- | --- | --- |
| add | Entry F1（P / R） | 0.241（0.233 / 0.250） |
| add | 内容 F1 | 0.724 |
| add | Topic 归纳 B-cubed F1（P / R） | 0.950（1.000 / 0.905），模型 28 个 topic，gold 19 个 |
| add | Source trace 覆盖率 | 0.96（缺 `t_tell`） |
| search | Recall@1 / @3 / @5 / @10 | 0.667 / 0.850 / 0.867 / 0.867 |
| search | 检索 trap rate | 0.556 |
| 回答 | LLM score | 0.867 |
| 回答 | Token F1 | 0.300 |
| 效率 | wallclock | 193.6 s |
| 效率 | add：请求数，P50 / P95 | 12 次，7.19 s / 12.01 s |
| 效率 | add：平均输入 / 输出 token，平均费用 | 889 / 417，$0.00030 |
| 效率 | search：请求数，P50 / P95 | 30 次，3.84 s / 6.37 s |
| 效率 | search：平均输出 token，平均费用 | 260，$0.00018 |

LLM score 按题型：cross-project 0.833、overridden 1.0、plain 1.0、scope-leak 0、stale 0.889。

结果解读：

- Entry F1 与内容 F1 差距很大，主要原因是 kind：8 条 gold experience 被写成 decision，4 条 evolution 被写成 decision。抽取 prompt（`Memory/src/service/memory-service.ts` 的 `PROJECT_MEMORY_EXTRACTION_SYSTEM_PROMPT`）没有写 standard 的三类条目规则。
- 9 条 stale 条目说明，后来的 add 没有取代早先写入的旧状态。
- q20 的空回答来自环境问题：本地 embedding 模型下载失败，L1 那条 global 轨迹没有建好向量。这不是评分器的问题。
- 评委与被测是同一个模型，复查时看到个别题判得偏严（例如 q23），单题判定可能有 ±1 的波动。

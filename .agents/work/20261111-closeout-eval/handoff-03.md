---
item: 20261111-closeout-eval
seq: 03
role: developer
app: Cursor
model: grok-4.7-high-fast
date: 2026-11-11
branch: dev-project-memory-add-search-dev
base: 47355fa0
head: 47355fa0
to: reviewer
status: ready-for-review
---

# 交接 03：旧实现 9aabf84b 在数据集 v2.1 上重跑一次

harness commit：`47355fa0`。legacy ref：`9aabf84b`。本次没有提交。`item.md` 按本切片要求没有改。

## 结论

旧实现 `9aabf84b` 用当前评分协议在数据集 v2.1 上跑完一次。服务没有中途退出，没有重试，也没有从 partial 续跑。当前 `harness/run-control-legacy.mjs` 能驱动 v2.1，没有把脚本复制到 `/tmp` 再改。

可直接粘进 `metrics.md` 的一行：

`legacy 9aabf84b | harness 47355fa0 | dataset v2.1 | SUT/reader deepseek-v4.1-flash-1017 | judge gpt-6-luna | answers.llm 0.7096774193548387（conflict 1 / cross-project 0.8 / plain 0.8461538461538461 / stale 0）| rubric 0.7419354838709677 | tokenF1 0.5456724749130485（conflict 0.49685303773608464 / cross-project 0.6390966538632595 / plain 0.5667772451834434 / stale 0.33324337661577913）| recall@1/3/9 0.41935483870967744 / 0.5806451612903226 / 0.5806451612903226 | entryHit 0.8709677419354839 | entries P/R/F1 0.7073170731707317 / 0.3717948717948718 / 0.48739495798319327 | stateExact 0 | topics bcubed f1 0.40710584752035534 | topics 30/50 | duplicateTopics 1 | wrongMerges 2 | add/search/answer/judge cost USD 0.017975891999999997 / 0 / 0.013708799999999998 / 0.012017600000000002 | replay wallclockMs 222820.927875 | score elapsed_ms 244554`

原始文件：

- `eval/project-memory/runs/2026-11-11T03-56-46-995Z/live-run.json`
- `eval/project-memory/runs/2026-11-11T03-56-46-995Z/report.json`

用量与缓存在 `/tmp/pm-eval/legacy-v21/`（`sut-usage.jsonl`、`reader-cache.json`、`judge-cache.json`）。`runs/` 已被 gitignore，没有提交。

## 改动

没有改被测代码，也没有改仓库里的评分脚本或 `harness/run-control-legacy.mjs`。只新增本交接。

工作区里 `run-control-legacy.mjs` 相对 `47355fa0` 已有一行未提交差异：阅读缓存路径改为 `process.env.MEMMY_EVAL_READER_CACHE ?? join(RUNS_DIR, "reader-cache.json")`。回放开始前文件里就是这一行。这次没有动它。v2.1 的 113 条轨迹和 31 道题都跑完了，所以没有把脚本拷到 `/tmp/pm-eval/legacy-v21/` 再打补丁。

## 验证

| 命令 | 结果 |
| --- | --- |
| `node eval/project-memory/gold-add-memory/load-eval-set.mjs` | 退出码 0。`errors: []`，`datasetVersion: 2.1`，traces 113，questions 31（conflict 3，cross-project 10，plain 13，stale 5），topics 50，apiChecks 4 |
| `WORK_DIR=/tmp/pm-eval/legacy-v21 PORT=18983 PROXY_PORT=18993 LEGACY_REF=9aabf84b SUT_ENV_FILE=$HOME/.deepseek.env JUDGE_ENV_FILE=/tmp/pm-eval/legacy-v21/judge.env bash eval/project-memory/gold-add-memory/harness/run-legacy-eval.sh` | 退出码 0。`MEMMY_DECISION_TOPIC` 未设置。没有 `--gate`。stdout：`{"out":".../2026-11-11T03-56-46-995Z/live-run.json","questions":31}`。进程耗时 225211 ms（2026-11-11T03:56:44Z–04:00:29Z） |
| `MEMMY_EVAL_SUT_MODEL=deepseek-v4.1-flash-1017 node run-pipeline-eval.mjs <live-run.json> --sut-usage /tmp/pm-eval/legacy-v21/sut-usage.jsonl --out <run dir>/report.json` | 退出码 0。`failures` 为空。进程耗时 244554 ms（04:00:58Z–04:05:02Z） |

`~/.deepseek.env` 的 `MODEL` 是 `deepseek-v4.1-flash-1017`。`~/.openai.env` 的 `MODEL` 是 `gpt-6-luna`。评委环境文件在 `/tmp/pm-eval/legacy-v21/judge.env`，权限 600，只含 `MEMMY_EVAL_JUDGE_*` 与 `MEMMY_EVAL_READER_*`。阅读模型与被测模型同名，阅读和评委的 base URL 都是 `https://api-int.memtensor.cn/v1`。密钥没有写入仓库。

请求的模型名 113 次都是 `deepseek-v4.1-flash-1017`。网关回包里的 `model` 有 29 次是这个名字，84 次是 `deepseek-v4-1-flash-261017`。`pricing.json` 的 aliases 已指向 `deepseek-flash`，费用不是 null。113 次 add 的 operation 都是 `other`：旧提示词没有 `pm-extract-` / `pm-assign-` / `pm-judge-`。这不是故障。`9aabf84b` 的抽取提示词是 `memory-service.ts` 里的内联字符串，没有这些版本号。

回放请求：add 113，search 31，final 42。`live-run.json` 的 `error` 为空。六个空间的最终条目都没有 `history` 或 `conflicts`。没有重试。脚本的 EXIT trap 在回放进程结束时停掉了本机的 18983 和 18993。评分之后这两个端口仍空闲，没有动其他端口。

## 分数

全部抄自 `report.json`，没有重算。

| 指标 | 值 |
| --- | --- |
| answers.llm | 0.7096774193548387 |
| answers.llm.conflict | 1 |
| answers.llm.cross-project | 0.8 |
| answers.llm.plain | 0.8461538461538461 |
| answers.llm.stale | 0 |
| answers.rubric | 0.7419354838709677 |
| answers.tokenF1 | 0.5456724749130485 |
| answers.tokenF1.conflict | 0.49685303773608464 |
| answers.tokenF1.cross-project | 0.6390966538632595 |
| answers.tokenF1.plain | 0.5667772451834434 |
| answers.tokenF1.stale | 0.33324337661577913 |
| search.recall@1 | 0.41935483870967744 |
| search.recall@3 | 0.5806451612903226 |
| search.recall@9 | 0.5806451612903226 |
| search.entryHit | 0.8709677419354839 |
| entries.precision | 0.7073170731707317 |
| entries.recall | 0.3717948717948718 |
| entries.f1 | 0.48739495798319327 |
| decisions.stateExact | 0 |
| topics.bcubed.f1 | 0.40710584752035534 |
| detail.counts.actualTopics / goldTopics | 30 / 50 |
| errors.topics.duplicateTopics | 1 |
| errors.topics.wrongMerges | 2 |

`efficiency.wallclockMs` 是 222820.927875。`cacheWriteTokens` 在计价函数里是未命中输入，`cacheReadTokens` 是缓存命中。费用都不是 null。

| 段 | 调用 | cacheWriteTokens | cacheReadTokens | outputTokens | 费用 USD | latency p50 | latency p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| add | 113 | 22182 | 67456 | 10326 | 0.017975891999999997 | 1387 | 1910.7999999999997 |
| search | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| answer | 31 | 25109 | 1664 | 5335 | 0.013708799999999998 | null | null |
| judge | 137 | 67961 | 0 | 10443 | 0.012017600000000002 | 1937.0263330000162 | 4621.848525199998 |

add 的 HTTP `requestLatencyMs`：n 113，p50 1395.3157920000012，p95 1919.5034669999866。search 的模型调用是 0，上面的 latency 因此是 0；HTTP `requestLatencyMs`：n 31，p50 3.769457999995211，p95 5.571270500004175。answer 的 latency 为 null，`reasons.latencyMs` 是 `no per-call latency recorded`。

任务 p95 不存在。`efficiency.add.task` 是 null，`reasons.task` 是 `no add tasks`。旧 add 同步返回，回放没有 `task_id` / `completedMs`。

add 的 113 次调用全部记在 `efficiency.add.other`（费用与 add 合计相同）。`extract`、`assign`、`judge`（M05）三段都是 0 次调用、费用 0。

## 与规格的偏离和简化

| 内容 | 说明 |
| --- | --- |
| 没有 history / conflicts | 旧服务的项目记忆响应不带这两段。`live-run.json` 里最终条目的 history、conflicts 都是 0 条。`decisions.history`、`decisions.conflicts`、`stateExact` 不能和现行实现比 |
| api.passRate 为 0 | 回放的 `apiChecks` 是空数组。金标有 4 项接口检查，脚本不发这些请求。`scores.api.passRate` 是 0，按构造不可比 |
| 最终状态是检索并集 | 脚本用每道题的返回，再加每个空间 7 条探测查询，拼出 `final`。旧接口没有 `get_memory` |
| 提示词落在 other | 见上。不是漏记 |

## 评审回应

无。上一份是 `handoff-01.md`，还没有针对这次回放的 review。

## 请 reviewer 重点看

1. `report.json` 的 `scores` 与 `efficiency` — 上表是原样抄出的。
2. `api.passRate` 与 history / conflicts — 不可与现行实现横比。
3. 网关回包模型名 `deepseek-v4-1-flash-261017` — 请求名仍是 `deepseek-v4.1-flash-1017`，费用已算出。

## 交给下一个 developer

本份交给 reviewer。若要把这一行写入 `metrics.md`，用上面的原数，不要重算。`item.md` 仍是 `in-progress`。

- [ ] 不重跑 v0.1（`672919d5`）
- 如何继续：原始 JSON 已在上面的 run 目录；`/tmp/pm-eval/legacy-v21/` 里有用量和缓存
- 已知的坑：工作区不干净，但这次没有改那些文件。阅读缓存走的是工作区里那一行未提交的 `MEMMY_EVAL_READER_CACHE`，不是 HEAD 上写死的 `runs/reader-cache.json`

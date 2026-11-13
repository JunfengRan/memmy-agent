---
item: 20261111-closeout-eval
seq: 02
role: developer
app: Cursor
model: grok-4.7-high-fast
date: 2026-11-11
branch: dev-project-memory-add-search-dev
base: 47355fa0
head: 未提交
to: developer
status: ready-for-review
---

# 交接 02：当前构建在数据集 v2.1 上的两次端到端

## 结论

基线 `47355fa0`，没有交付提交。数据集是 `eval/project-memory/gold-add-memory/dataset` 的 v2.1（`node load-eval-set.mjs` 的 `errors` 为 `[]`，113 条轨迹、50 个金标主题、31 道计分题）。被测和阅读模型都是 `deepseek-v4.1-flash-1017`，裁判是 `gpt-6-luna`（报告里温度 `null`）。没有传 `--gate`。`item.md` 按本轮要求没有改。

`MEMMY_SUMMARY_PROVIDER=openai` 被配置层丢掉，健康检查里 provider 为空、`configured=false`。两次都改用 `openai_compatible` 后健康检查通过，模型名仍是 `deepseek-v4.1-flash-1017`。服务进程带了 `MEMMY_EMBEDDING_MODEL_ROOT=$HOME/.memmy/memory-service/embedding-models`。回放继续之前，第一条完成的向量日志都是 `Embedding request succeeded`（本地 `Xenova/all-MiniLM-L6-v2`）。更早一次 18981 上的回放因为 `fetch failed` 已停掉，目录 `/tmp/pm-eval/current-a` 已丢掉，没有评分。

两次方向一致，但不能当成同一次：rubric 相同，token F1 只差 0.001，answers.llm 差 0.097，stateExact 差 0.078，实际主题数 65 对 58。合成一行时要写范围。

## 运行 A

- live-run：`/Users/junfengran/repos/memmy-agent/eval/project-memory/runs/2026-11-11T04-08-59-655Z/live-run.json`
- report：`/Users/junfengran/repos/memmy-agent/eval/project-memory/runs/2026-11-11T04-08-59-655Z/report.json`
- 端口 18981 / 代理 18991，provider `openai_compatible`，整段 722 秒（含起服务、回放、评分）

| 指标 | 值 |
| --- | --- |
| answers.llm | 0.6451612903225806 |
| answers.llm.conflict / cross-project / plain / stale | 0.6666666666666666 / 0.9 / 0.6923076923076923 / 0 |
| answers.rubric | 0.6774193548387096 |
| answers.tokenF1 | 0.3872352110252312 |
| answers.tokenF1.conflict / cross-project / plain / stale | 0.4939087389443328 / 0.3653260981163171 / 0.39397991633458435 / 0.34951308628727984 |
| search.recall@1 / @3 / @9 | 0.7096774193548387 / 0.8709677419354839 / 0.967741935483871 |
| search.entryHit | 0.3870967741935484 |
| entries.f1（P / R） | 0.8163265306122449（0.8695652173913043 / 0.7692307692307693） |
| decisions.stateExact | 0.703125 |
| topics.bcubed.f1 | 0.6757096603181696 |
| 主题数 actual / gold | 65 / 50 |
| topics.duplicateTopics | 10 |
| topics.wrongMerges | 1 |

开销字段取自 `efficiency.*.latencyMs`，费用都不是 null。回答的 P50 / P95 为 null，原因是 `no per-call latency recorded`。

| 段 | 调用 | 缓存写 / 缓存读 / 输出 | 费用 USD | P50 / P95 ms |
| --- | --- | --- | --- | --- |
| add | 201 | 190696 / 122240 / 21869 | 0.04209252 | 1491 / 2358 |
| add 任务 | 113/113 | — | — | 3430.7479170000297 / 5436.322483799988 |
| add extract | 108 | 128808 / 71936 / 9635 | 0.025318008000000003 | 1308 / 1846.35 |
| add assign | 78 | 47724 / 45184 / 11002 | 0.013895352000000007 | 1803 / 2586.85 |
| add judge | 15 | 14164 / 5120 / 1232 | 0.00287916 | 1228 / 1578.8999999999996 |
| search | 0 | 0 / 0 / 0 | 0 | 0 / 0 |
| answer | 31 | 32039 / 2688 / 3885 | 0.0071449140000000005 | null / null |
| judge | 209 | 94416 / 0 / 12019 | 0.015451100000000004 | 1662.0332500000004 / 3168.7101834000096 |

## 运行 B

- live-run：`/Users/junfengran/repos/memmy-agent/eval/project-memory/runs/2026-11-11T04-21-01-504Z/live-run.json`
- report：`/Users/junfengran/repos/memmy-agent/eval/project-memory/runs/2026-11-11T04-21-01-504Z/report.json`
- 端口 18982 / 代理 18992，provider `openai_compatible`，整段 704 秒

| 指标 | 值 |
| --- | --- |
| answers.llm | 0.7419354838709677 |
| answers.llm.conflict / cross-project / plain / stale | 0.6666666666666666 / 0.9 / 0.7692307692307693 / 0.4 |
| answers.rubric | 0.6774193548387096 |
| answers.tokenF1 | 0.38851785466924765 |
| answers.tokenF1.conflict / cross-project / plain / stale | 0.5123609127445445 / 0.38820495291400114 / 0.3694201558418965 / 0.3644918402856753 |
| search.recall@1 / @3 / @9 | 0.7419354838709677 / 0.9032258064516129 / 0.9354838709677419 |
| search.entryHit | 0.41935483870967744 |
| entries.f1（P / R） | 0.8611111111111112（0.9393939393939394 / 0.7948717948717948） |
| decisions.stateExact | 0.78125 |
| topics.bcubed.f1 | 0.7000035258444398 |
| 主题数 actual / gold | 58 / 50 |
| topics.duplicateTopics | 9 |
| topics.wrongMerges | 3 |

| 段 | 调用 | 缓存写 / 缓存读 / 输出 | 费用 USD | P50 / P95 ms |
| --- | --- | --- | --- | --- |
| add | 203 | 136476 / 180224 / 22309 | 0.03439747199999997 | 1409 / 2274.4999999999995 |
| add 任务 | 113/113 | — | — | 3431.407749999955 / 4841.239349999992 |
| add extract | 108 | 81392 / 120448 / 10217 | 0.018700343999999997 | 1289.5 / 2017.9999999999998 |
| add assign | 76 | 37870 / 52608 / 10605 | 0.012201324000000001 | 1714 / 2371.75 |
| add judge | 19 | 17214 / 7168 / 1487 | 0.003495804000000001 | 1186 / 1545.3999999999999 |
| search | 0 | 0 / 0 / 0 | 0 | 0 / 0 |
| answer | 31 | 32938 / 2816 / 3793 | 0.007224947999999999 | null / null |
| judge | 212 | 84322 / 10511 / 12508 | 0.014791309999999995 | 1604.4947079999993 / 3494.311355950005 |

回答 P50 / P95 同样为 null，原因同样是 `no per-call latency recorded`。

## 改动

无产品改动。只新增本交接。评测生成物在 `eval/project-memory/runs/`，不提交。

## 验证

| 命令 | 结果 |
| --- | --- |
| `node load-eval-set.mjs` | 退出码 0，`errors: []`，datasetVersion 2.1 |
| 运行 A `run-memmy-live-eval.mjs` | 退出码 0 |
| 运行 A `run-pipeline-eval.mjs`（无 `--gate`） | 退出码 0 |
| 运行 B 回放 | 退出码 0 |
| 运行 B 评分 | 退出码 0 |

第一次 18981 回放在向量 `fetch failed` 后已杀掉，未评分。重启后 A、B 的第一条向量结果都是 succeeded。`eval-config.yaml` 的内容哈希与启动前一致。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| 服务不接受 provider `openai`，实际用 `openai_compatible` 调 DeepSeek | ADR-0009 第 2 条。模型 id 仍是 deepseek-v4.1-flash-1017 |
| 回答没有逐次延迟，P50 / P95 为 null | 报告 `efficiency.answer.reasons.latencyMs` |

## 评审回应

无。上一份 `handoff-01.md` 是开销计价，不是对这次实机回放的评审。

## 请 reviewer 重点看

1. 两次 answers.llm、stateExact 和主题数的差距，写 metrics 时要保留范围。
2. 回答延迟原因是 `no per-call latency recorded`，费用不是 null。

## 交给下一个 developer

- [ ] 把上面两份 `report.json` 的数写进 `docs/project-memory/metrics.md`。本交接没有改那份文档。
- 如何继续：原始文件路径见运行 A、B。被丢掉的那次 `fetch failed` 不要记成结果。
- 已知的坑：`MEMMY_SUMMARY_PROVIDER=openai` 会被配置层丢弃；本地向量要设 `MEMMY_EMBEDDING_MODEL_ROOT`，否则 `Xenova/all-MiniLM-L6-v2` 会 `fetch failed`。

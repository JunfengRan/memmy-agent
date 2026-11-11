---
item: 20261111-closeout-eval
seq: 04
role: developer
app: Cursor
model: grok-4.7-high-fast
date: 2026-11-11
branch: origin/main（detached worktree，跑完已删除）
base: 8cd095c7
head: 8cd095c7
to: reviewer
status: in-progress
---

# 交接 04：origin/main 对照组（无项目记忆）在数据集 v2.1 上的一次结果

## 结论

origin/main `8cd095c7` 没有项目记忆。这次用通用 `/api/v1/memory/add` 与 `/api/v1/memory/search` 回放数据集 v2.1，再用同一个阅读模型和同一个评分脚本打分。写入和决策分按定义为 0，没有改评分。

`entries.f1` 是 0。这不是项目记忆的 add 分数。对照组不产生项目记忆条目（报告里 `actualEntries` 为 0、`actualTopics` 为 0），这个数不能拿来和项目记忆的写入质量比较。

被测与回答模型都是 `deepseek-v4.1-flash-1017`。裁判是 `gpt-6-luna`，温度记为 null（该模型不接受温度 0）。没有传 `--gate`。没有改仓库里的回放脚本或评分逻辑，也没有提交。`item.md` 按本次要求没有改，工作项状态仍是 in-progress。

## 产物

| 文件 | 路径 |
| --- | --- |
| live-run.json | `eval/project-memory/runs/2026-11-11T04-01-23-816Z/live-run.json` |
| report.json | `eval/project-memory/runs/2026-11-11T04-01-23-816Z/report.json` |

数据集校验：`node load-eval-set.mjs` 退出码 0，`errors` 为 []，`datasetVersion` 2.1，113 条轨迹，31 道计入的题（conflict 3、cross-project 10、plain 13、stale 5）。

作废的第一次回放（没有评分）在 `eval/project-memory/runs/2026-11-11T03-57-45-424Z/live-run.json`。当时 Hugging Face 超时，本地 embedding 模型没有载入，检索只有关键词。下面的数都来自第二次、embedding 成功的那次。

## 指标（从 report.json 原样抄出）

回答 `answers.llm` 总体 **0.1935483870967742**。

| 题型 | n | answers.llm | token F1 | entryHit |
| --- | --- | --- | --- | --- |
| conflict | 3 | 0 | 0.22138899304253634 | 0 |
| cross-project | 10 | 0.4 | 0.24620443535889286 | 0.4 |
| plain | 13 | 0.15384615384615385 | 0.19369969453143004 | 0.23076923076923078 |
| stale | 5 | 0 | 0.28476308693026964 | 0.6 |

- rubric `answers.rubric`：**0.3548387096774194**
- token F1 `answers.tokenF1`：**0.22800396117020885**
- recall@1 / @3 / @9：**0 / 0 / 0**
- entryHit `search.entryHit`：**0.3225806451612903**
- `entries.f1`：**0**（不是项目记忆 add 分）

写入类和决策类分数都是 0（`entries.*`、`decisions.*`、`topics.*`）。`failures` 为空。`api.passRate` 为 0（对照组没有跑项目记忆接口检查）。

## 开销

费用都不是 null，没有缺单价的原因。回答的 p50 / p95 是 null，原因是 `no per-call latency recorded`（回放脚本写入 `usage.reader` 时去掉了逐次延迟）。

| 段 | 调用 | 缓存未命中 | 缓存命中 | 输出 | 费用 USD | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| add | 57 | 30621 | 7808 | 1868 | 0.0057373740000000025 | 1103 | 1532.7999999999984 |
| search | 62 | 25653 | 23168 | 2274 | 0.005281854000000001 | 1063 | 1746.0499999999995 |
| answer | 26 | 19340 | 1792 | 3699 | 0.005125776000000001 | null | null |
| judge | 56 | 23091 | 0 | 4512 | 0.004565100000000001 | 1960.0102709999992 | 5101.199677249997 |

裁判说明仍是 `judge is not part of add, search, or answer`。add 另有 `reasons.task = no add tasks`（对照组没有 add/message 任务计时）。

用量代理 134 行，全部 HTTP 200，operation 都是 `other`。请求的模型 id 是 `deepseek-v4.1-flash-1017`，网关返回的模型 id 是 `deepseek-v4-1-flash-261017`。费用能算出数。search 的 62 次是落在 search 请求时间窗里的 chat 调用，不是检索重排；配置里 `llmFilterEnabled` 为 false。

## 改动

没有改产品代码，也没有改评测脚本。唯一新增的仓库文件是本交接。生成物在已被 gitignore 的 `eval/project-memory/runs/`。

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| 无代码改动 | origin/main 对照回放与评分 | 收尾评测要 main 在 v2.1 上的一行 | ADR-0009 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `node load-eval-set.mjs` | 退出码 0，`errors: []`，datasetVersion 2.1 |
| `git -C /tmp/pm-eval/main-wt rev-parse --short HEAD` | `8cd095c7` |
| 服务 `GET /api/v1/health` | 200，serviceVersion 2.1.6，summary/evolution 为 `deepseek-v4.1-flash-1017` |
| `node harness/run-control-main.mjs` | 退出码 0，31 题，墙钟 75115.836083 ms。脚本能读 v2.1，没有改仓库副本 |
| `node run-pipeline-eval.mjs … --sut-usage …`（无 `--gate`） | 退出码 0，耗时 135115 ms，写出 report.json |

评测：本文件上面的指标。没有写入 `metrics.md`。

耗时：回放约 75.1 秒，裁判约 135.1 秒。

## 运行条件

- 被测服务从临时 worktree `/tmp/pm-eval/main-wt` 的 `Memory/` 启动，端口 18984，数据库 `/tmp/pm-eval/main-ctl/memory.sqlite`。worktree 已 `git worktree remove --force`，没有动另外两个 superagent worktree。
- `harness/eval-config.yaml` 拷到 worktree 根目录后被 origin/main 接受，没有退回默认配置。`roleRouting` 为 fixed，embedding 为 local。
- origin/main 的 provider 枚举没有字面量 `openai`，设成 `openai` 会落成空字符串。summary / evolution 用的是 `openai_compatible`，vendor `deepseek`，端点指向本机用量代理 `127.0.0.1:18994`。阅读模型的 provider 按评测客户端要求设为 `openai`。
- 第一次回放时 Hugging Face 连接超时，`~/.memmy/memory-service/model-cache` 不存在，embedding 报 `fetch failed`。第二次把 `MEMMY_EMBEDDING_MODEL_ROOT` 指到已有的 `~/.memmy/memory-service/embedding-models`（`Xenova/all-MiniLM-L6-v2`），embedding 请求成功。空库重跑了一次。用量日志在正式回放前清空。
- 已停掉本次的 18984 服务和 18994 代理，没有动其他端口。`MEMMY_DECISION_TOPIC` 已 unset。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| 对照组没有项目记忆状态，写入分和决策分按定义为 0；`entries.f1` 不是 add 分 | 本工作项；评分脚本对空最终状态的定义 |
| 裁判温度 null | ADR-0009 第 3 条 |

## 评审回应

无。这是 main 对照组的结果交接，不是对 handoff-01 代码的修订。

## 请 reviewer 重点看

1. `eval/project-memory/runs/2026-11-11T04-01-23-816Z/report.json` — 分数和四段开销都从这里抄。`entries.f1 = 0` 不要当成项目记忆 add 退步。
2. recall@1/3/9 为 0，同时 entryHit 为 0.3225806451612903。主题 id 召回和条目文本命中不是同一个数。
3. 作废的第一次 live-run 没有 report，不要把它写进 metrics。

## 交给下一个 developer

本份把 main 这一格的数交出去。`item.md` 没有改。

- [ ] 把这一行写入 `docs/project-memory/metrics.md`（本次按要求没有写）
- 如何继续：用上面的 report.json，不要用 `2026-11-11T03-57-45-424Z` 那次
- 已知的坑：回答延迟没有逐次记录，所以 answer 的 p50/p95 为 null；search 的调用数是时间窗归类，不是检索模型重排

---
item: 20261111-closeout-eval
seq: 05
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

# 交接 05：金标记忆上的检索与阅读上限

无交付提交。`git rev-parse --short HEAD` 是 `47355fa0`。`item.md` 按本切片要求没有改。

## 结论

在数据集 v2.1 上跑了两件都不使用产品 add 输出的测量。检索脚本对每个计分题的 `askedAt` 新建临时 sqlite，把该时刻可见的金标项目状态经 `ProjectMemoryStore.commitChangeSet` 写入，再调用产品 `search/memory` 背后的 `MemoryService.handleProjectMemoryRequest`。阅读上限沿用现有 `harness/run-reader-ceiling.mjs`，金标 `topic_detail_list` 直接交给同一个 DeepSeek 阅读模型。两份 run 都由 `gpt-6-luna` 评分，没有 `--gate`，也没有 `--sut-usage`。

`search-on-gold` 的 `entries.f1` 是 0。`final` 是空对象，这个分数不是产品 add 的成绩。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `eval/project-memory/gold-add-memory/harness/run-search-on-gold.mjs` | 新增。按 `askedAt` 提交金标状态并走产品检索，再交给 DeepSeek 阅读模型 | 只测检索，不使用产品 add 的输出 | ADR-0009 第 1、2 条 |

金标状态这样建成：对每个计分题的 `askedAt`，用 `replay` 放到该时刻，只保留非 optional 条目，摘要和说明只用当时仍然有效的要点（`activePointTexts`）。这和 `oracleTopics` 在该 `askedAt` 的 `topic_detail_list` 一致，脚本会先对一下再提交。空间用数据集里的 `space_id` 创建，`spaceMap` 是恒等映射，返回的主题也带数据集空间 id。检索请求是 `POST /api/openmem/v1/search/memory`，`memory_limit_number` 为 9，`include_memory_view` 含 `project`。嵌入器用 `harness/eval-config.yaml` 解析出的本地 `Xenova/all-MiniLM-L6-v2`（384 维），权重来自本机已安装的 `MEMMY_EMBEDDING_MODEL_ROOT`，不是 hash stub。检索路径上的聊天客户端直接拒绝调用。`final` 保持 `{}`。

每个计分题有一条 `phase: "search"` 的请求记录，`at` 和 `ms` 都是数字。阅读模型是 `deepseek-v4.1-flash-1017`，provider `openai`，缓存 `/tmp/pm-eval/search-gold/reader-cache.json`。`usage.reader` 带每次调用的 `at`。

阅读上限没有产品检索，也没有起服务。阅读缓存是 `/tmp/pm-eval/reader-ceiling/reader-cache.json`，裁判缓存是 `/tmp/pm-eval/reader-ceiling/judge-cache.json`。检索那次的裁判缓存是 `/tmp/pm-eval/search-gold/judge-cache.json`。

## 路径

| 测量 | live run | report |
| --- | --- | --- |
| 金标上检索 | `eval/project-memory/runs/2026-11-11T04-04-03-706Z/live-run.json` | `eval/project-memory/runs/2026-11-11T04-04-03-706Z/report.json` |
| 阅读上限 | `eval/project-memory/runs/2026-11-11T04-05-19-756Z/live-run.json` | `eval/project-memory/runs/2026-11-11T04-05-19-756Z/report.json` |

## 分数

金标上检索。`answers.llm` 0.6452；按题型 conflict 0.6667、cross-project 0.7000、plain 0.6923、stale 0.4000。rubric 0.6774。token F1 0.4559。recall@1/3/9 为 0.5161 / 0.6774 / 0.6774。entryHit 0.6129。

阅读上限。`answers.llm` 1；conflict、cross-project、plain、stale 都是 1。rubric 0.9355。token F1 0.6351。recall@1/3/9 都是 1。entryHit 1。这份 run 的 `entries.f1` 是 1，因为阅读上限脚本把金标终态写进了 `final`，同样不是产品 add。

## 开销

数字来自两份 `report.json` 的 `efficiency`。调用数、缓存写入、缓存读、输出、费用、p50、p95 按这个顺序。

金标上检索：

| 段 | calls | cache write | cache read | output | cost | p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| search 的 chat | null | null | null | null | null | null | null |
| answer | 31 | 16377 | 256 | 3937 | 0.004819518 | 1460.566 ms | 2795.119 ms |
| judge | 31 | 9929 | 0 | 1892 | 0.0019389 | 2014.955 ms | 5477.448 ms |

search 的 HTTP 请求有 31 条。请求耗时 p50 2.094 ms、p95 3.827 ms。chat 费用是 null，不是 0。请求日志已经是 `phase: "search"`，并且 `at`、`ms` 都是数字；计分器在没有 SUT usage 文件时仍把 search 的 chat 记为 null，原因是 `no SUT usage file`。按要求没有传 `--sut-usage`，也没有改 `run-pipeline-eval.mjs`。检索里没有聊天调用：聊天客户端会抛错，31 次检索也都没有 vector/project degraded。

阅读上限：

| 段 | calls | cache write | cache read | output | cost | p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| search 的 chat | null | null | null | null | null | null | null |
| answer | 31 | 26994 | 1920 | 3366 | 0.00607446 | null | null |
| judge | 31 | 10009 | 0 | 1388 | 0.0016949 | 1962.761 ms | 3539.502 ms |

阅读上限没有检索请求，search 的 requests 是 0。answer 的 p50/p95 是 null，因为现有 `run-reader-ceiling.mjs` 写出 usage 时丢掉了 `latencyMs`；`perCall` 里仍有每次调用的 `at`。这次没有改那个脚本。

## 验证

| 命令 | 结果 |
| --- | --- |
| `node eval/project-memory/gold-add-memory/load-eval-set.mjs` | 通过。`errors` 为空，`datasetVersion` 2.1，计分题 31 |
| `npx tsx harness/run-search-on-gold.mjs` | 写出 31 题的 live run。嵌入器 `local/Xenova/all-MiniLM-L6-v2`，阅读调用 31，缓存命中 0。进程在写完文件后的退出阶段 abort（exit 134，onnx 互斥锁），JSON 已完整并完成评分 |
| `node run-pipeline-eval.mjs <search-on-gold live-run.json> --out report.json` | 通过，exit 0。裁判 `gpt-6-luna`，温度 null |
| `node harness/run-reader-ceiling.mjs` | 写出 31 题的 live run，exit 0 |
| `node run-pipeline-eval.mjs <reader-ceiling live-run.json> --out report.json` | 通过，exit 0 |

`~/.deepseek.env` 的 `MODEL` 是 `deepseek-v4.1-flash-1017`，`~/.openai.env` 的 `MODEL` 是 `gpt-6-luna`。没有打印密钥。没有改产品代码，所以没有跑 Memory typecheck。没有起 18981–18984、18991–18994 上的服务，也没有占用 18985。

评测：上面两份 report。没有写入 `metrics.md`。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| 检索的 chat 费用是 null 而不是 0。计分器把「没有 usage 文件」当成测不到；空的 chat 调用只有在提供 usage 文件时才记 0 | ADR-0009 第 6 条。本次按要求不改计分器、不传 `--sut-usage` |
| 阅读上限的回答延迟 p50/p95 是 null。现有上限脚本不保留 `usage.latencyMs` | ADR-0009 第 2 条。脚本未改 |
| `eval-config.yaml` 只写了 local provider。本地权重用已安装的 `MEMMY_EMBEDDING_MODEL_ROOT`，模型 id 仍是 Xenova/all-MiniLM-L6-v2 | ADR-0009 第 1 条 |

## 评审回应

无。这是本切片的交接。`handoff-01.md` 是开销口径，不是对本脚本的 review。目录里还没有 review 文件。

## 请 reviewer 重点看

1. `eval/project-memory/gold-add-memory/harness/run-search-on-gold.mjs` — 金标状态是否就是该 `askedAt` 的 `oracleTopics`，检索是否走 `handleProjectMemoryRequest`，`final` 是否保持为空。
2. `eval/project-memory/runs/2026-11-11T04-04-03-706Z/report.json` — search 的 chat 费用为 null 的原因，以及 `entries.f1` 为 0 不能当成 add 分数。
3. `eval/project-memory/runs/2026-11-11T04-05-19-756Z/report.json` — 阅读上限的 `answers.llm` 为 1，回答延迟没有 p50/p95。

## 交给下一个 developer

本份交给 reviewer。

- [ ] `item.md` 状态未改，仍是 in-progress
- 已知的坑：没有 SUT usage 文件时，search 的 chat 费用不会因为请求日志而变成 0。

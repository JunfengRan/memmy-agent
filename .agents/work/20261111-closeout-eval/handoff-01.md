---
item: 20261111-closeout-eval
seq: 01
role: developer
app: Cursor
model: grok-4.7-high-fast
date: 2026-11-11
branch: dev-project-memory-add-search-dev
base: 47355fa0
head: 未提交
to: reviewer
status: ready-for-review
---

# 交接 01：评测开销按 Add / Search / 回答 / 裁判四段计价

## 结论

`efficiency()` 现在输出 add、search、answer、judge。Add 按提示词版本拆成 extract / assign / judge（M05）/ other。Search 只计入落在 search/memory 请求时间窗里的 chat 调用，没有这样的调用时数值为 0。回答用 `run.usage.reader` 单独计价，算产品开销。裁判单独计价，说明里写明不计入 add、search、answer。

单价已写入 `pricing.json`。官方页上的 Flash 模型 id 是 `deepseek-flash`（版本 DeepSeek-V4.1-Flash-1017），不是 `deepseek-v4.1-flash-1017`。`gpt-6-luna` 有官方价，裁判费用可以算出数，不再因为缺单价而为 null。没有交付提交。`item.md` 按本切片的要求没有改。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `eval/project-memory/gold-add-memory/pricing.json` | 写入 `deepseek-flash` 的峰谷价和 `gpt-6-luna` 的官方价；Claude 条目保留。`deepseek-v4.1-flash-1017` 以及页面写明按 Flash 计费的旧名走 aliases | 被测和回答要能按官方价换算；页面没有单独列出 `deepseek-v4.1-flash-1017` 这个 id | ADR-0009 第 5 条 |
| `eval/project-memory/gold-add-memory/metrics.mjs` | `tokenBuckets`、`classifyOperation`；`costUsd` 按调用时间选 DeepSeek 峰谷，长上下文仍按次判断；`cacheCreationTokens` 用 `cacheWrite` 单价 | 三档 token 和峰谷价要在计价函数里落地 | ADR-0009 第 5、6 条 |
| `eval/project-memory/gold-add-memory/harness/usage-proxy.mjs` | chat/completions 只记 operation 标签；JSONL 保留原始 `usage`，并写出 cache read / cache write / output | Add 要能按 M02 / M04 / M05 拆开，且不能把提示词正文落盘 | ADR-0009 第 6 条 |
| `eval/project-memory/gold-add-memory/llm.mjs` | 裁判和阅读客户端每次调用记下同样三档 token，并带上 `at`。gpt-6 不传 temperature、改用 `max_completion_tokens` 的行为保留 | 回答和裁判要能按同样的桶计价 | ADR-0009 第 2、3、4 条 |
| `eval/project-memory/gold-add-memory/run-pipeline-eval.mjs` `efficiency()` | 四段开销。Search 时间窗内的 chat 调用不再全部归到 add；窗内没有调用时记 0。没有 `--sut-usage`、模型没有单价、或 DeepSeek 调用没有时间戳时才 null，并写 reason | 产品开销是 add + search + answer，裁判单列 | ADR-0009 第 4、6 条 |
| `eval/project-memory/gold-add-memory/selftest.mjs` | 断言改成新字段，并覆盖操作拆分、检索时间窗、峰谷价 | 形状变了，旧的 avgInputTokens / reader 断言会失效 | 本工作项验收 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `cd eval/project-memory/gold-add-memory && node selftest.mjs` | 19/19 通过 |
| `node run-pipeline-eval.mjs --oracle` | 分数全是 1，errors 全是 0，`failures` 为空。报告写到 `eval/project-memory/runs/oracle-report.json` |
| `node run-pipeline-eval.mjs --empty` | 分数全是 0，`failures` 为空。报告写到 `eval/project-memory/runs/empty-report.json` |

评测：未跑实机回放。本切片要求不起记忆服务、不跑 live replay。

## 单价

来源页：<https://api-docs.deepseek.com/quick_start/pricing> ，`fetchedAt` 2026-11-11。页面模型 id 是 `deepseek-flash`，模型版本是 DeepSeek-V4.1-Flash-1017。单位是 USD / 1M tokens。闲时是高峰的一半。高峰为周一到周五 UTC 01:00–04:00 和 06:00–10:00，不含中国法定节假日；其余时间（含周末和节假日全天）是闲时。

| 档 | 缓存未命中输入 | 缓存命中输入 | 输出 |
| --- | --- | --- | --- |
| 闲时（写入 `input` / `cachedInput` / `output`） | 0.15 | 0.003 | 0.6 |
| 高峰（`peak`） | 0.3 | 0.006 | 1.2 |

`gpt-6-luna` 来源：<https://developers.openai.com/api/docs/models/gpt-6-luna> ，同一天抓取。短上下文：未缓存输入 0.1，缓存命中 0.01，显式 cache write 0.125，输出 0.5。输入超过 272K 时输入和缓存按 2 倍、输出按 1.5 倍（0.2 / 0.02 / cache write 0.25 / 输出 0.75）。

Claude 三档单价和原来的 Anthropic 来源没有改。

## 没能按官方价直接落地的部分

- 页面没有 `deepseek-v4.1-flash-1017` 这个模型 id。aliases 把它，以及页面写明仍按 Flash 计费的 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`，指到 `deepseek-flash`。别的 DeepSeek 名字没有单价，费用为 null。
- 中国法定节假日没有编进日历。落在周一到周五高峰窗口里的节假日会被按高峰计价，官方当天应是闲时。
- 高峰窗口按左闭右开实现：04:00 和 10:00 整分算闲时。
- `gpt-6-luna` 的 0.125 cache-write 单价只用于响应里同时有 miss 和 `cache_creation_input_tokens` 时的 `cacheCreationTokens`。chat completions 通常只给 `prompt_tokens` 和 `cached_tokens`，未缓存部分按输入价 0.1，不按 0.125。
- Embedding / rerank 路径不计入 chat，也不另造单价。
- 没有 `--sut-usage` 时，add 和 search 的 token 与费用为 null。旧 runner 没有检索请求时间戳时，两边都为 null，不再把全部调用算进 add。
- 回答如果只有合计、没有每次调用的 `at`，DeepSeek 费用为 null，原因是分不出峰谷。`llm.mjs` 新调用会写 `at`。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| 官方价按页面原样写入，含峰谷两档；节假日日历没有编码 | ADR-0009 第 5 条。ADR 不抄单价 |
| `deepseek-v4.1-flash-1017` 用 aliases 指向页面上的 `deepseek-flash` | ADR-0009 第 2、5 条 |
| 评委温度对 gpt-6 记 null，请求不传 temperature | ADR-0009 第 3 条，收回 ADR-0004 对 gpt-6 的温度 0 |

## 评审回应

无。这是本工作项第一份 developer 交接。`audit-01.md` 是文档审计，不是对这次代码的 review。

## 请 reviewer 重点看

1. `eval/project-memory/gold-add-memory/pricing.json:13` — 计价的模型 id 是页面上的 `deepseek-flash`，版本 DeepSeek-V4.1-Flash-1017；aliases 是否接受。
2. `eval/project-memory/gold-add-memory/metrics.mjs:157` — 有 `at` 才选峰谷；没有时间戳则费用 null。节假日未扣除。
3. `eval/project-memory/gold-add-memory/run-pipeline-eval.mjs:438` — 检索时间窗内的 chat 调用进 search，其余进 add；add 再按 operation 拆。零调用是 0，测不到才 null。
4. `eval/project-memory/gold-add-memory/harness/usage-proxy.mjs:38` — operation 只留 extract / assign / judge / other，不落提示词正文；原始 `usage` 仍在。

## 交给下一个 developer

本份交给 reviewer。若评审通过后再跑实机，不要在本文件上改，另写交接。

- [ ] `item.md` 状态未改，仍是 in-progress
- 已知的坑：`eval/project-memory/gold-add-memory/README.md` 里效率字段的说明还是旧的 `reader` / `avgInputTokens`，这次没有改。同目录 README 另有一行与本切片无关的未提交修改，没有动它。

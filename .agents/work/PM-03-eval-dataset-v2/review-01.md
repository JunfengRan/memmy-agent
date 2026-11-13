---
item: PM-03-eval-dataset-v2
seq: 01
role: reviewer
app: Claude Code（子代理，只读）
model: claude-opus-5-5
date: 2026-11-05
reviewed: handoff-01.md
range: 459a2972..9aabf84b
verdict: changes-requested
---

# 评审 01：数据集与金标基本到位，3 项 MUST 需修复

## 复核验证

| 命令 | 结果 |
| --- | --- |
| `node load-eval-set.mjs` | `errors: []` |
| `--oracle` / `--empty` | 1 / 0，只写入已忽略的 `runs/` |

没有发现金标泄漏到被测系统：标注、轨迹 id、`generate_answer` 都不进请求；阅读模型只看渲染结果和题目。

## 上一轮 MUST 的关闭情况

无（第一轮）。

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | MUST | `run-memmy-live-eval.mjs` `apiChecks()` | `search_requires_space_ids`、`add_requires_space_ids` 用 `!r.ok` 判通过，404、500、连接失败都算「被拒」；`search_space_isolation` 在返回空列表时也通过 | 会静默通过 | 要求 `code === 40001`；隔离检查加正对照（同样的问题在 ledger 空间必须返回 ledger 主题） | `MEMMY_EVAL_BASE` 指向不存在的路径，`api.passRate` 应为 0（现在是 0.5） |
| R1-2 | MUST | `run-pipeline-eval.mjs` 一对一匹配的候选排序 | 候选只按「主 id 是否等于金标」排序，不看 kind，进展条目可能抢走必写决策的匹配；已在内存里复现：`dec_tz` 被判 content/userIds/time 全错，决策召回降到 0.933 | 指标错误 | 先按 kind 相同、再按主 id 排序，或先在同 kind 边上做匹配 | 复现用例中 `dec_tz` 保持完全匹配 |
| R1-3 | MUST | `run-pipeline-eval.mjs` `efficiency()`、runner 请求记录 | 缺被测系统的平均输入 / 输出 token、费用、LLM 调用数；没有 add / search 分别的 wallclock；异步 add 的 P50/P95 只量到入队；请求数被 `get/status` 轮询放大 | metrics.md「指标定义」要求每条记录收录全部指标 | 记录每个任务 受理→完成 的耗时与分阶段 wallclock；从评测库的 `token_usage_outbox` 读服务端用量（不进产品契约）；输出 `efficiency.add/search.{requests, llmCalls, avgInputTokens, avgOutputTokens, avgCostUsd, totalCostUsd, p50, p95}`，取不到写 null 并注明原因 | 真实回放的 `report.json` 覆盖 metrics.md 效率表每一行 |
| R1-4 | SHOULD | `run-pipeline-eval.mjs` `byQuestionKind` | Token F1 没有按题型；LLM 分按题型只在 detail 里 | 用户要求按题型报 | 两者提升到 scores | |
| R1-5 | SHOULD | scorer 输入 | 接受 `live-run.partial.json` | | 有 `run.error` 时拒绝，或把 `questions.missing` 纳入 gate | |
| R1-6 | SHOULD | `search.foreignTopics` | 缺 `space_id` 的主题被忽略，会掩盖泄漏 | §3.2.5 要求该字段 | 视为契约错误 | |
| R1-7 | SHOULD | `judge.mjs` `align` | 跨空间陷阱与期望内容在同一候选池按文本对齐 | | 跨空间泄漏按 `space_id` 判 | |
| R1-8 | SHOULD | `dataset/labels.json`、README | 必写 / 可选进展的划分标准没写明；`tp_ledger_repo` 等主题分组、`t_write_main` / `t_write_secret` 是否为约定、`dec_cat_sku` / `dec_cat_dup` 是否属局部实现，都有争议，B-cubed 与决策 gate 依赖它们 | v3 §2.2.7 同一工作规则 | 写入 README「规格含糊处」并登记 open-questions | |
| R1-9 | SHOULD | `dropReasons` | 定义了 `local_implementation` 但没有任何负例 | | 加负例 | |
| R1-10 | SHOULD | 评委路径 | oracle 只覆盖文本完全一致的规则判定，`attribute` / `align` / `reasonSupported` / `answer` 未测 | | 用桩 LLM 加改写样例 | |
| R1-11 | SHOULD | `docs/project-memory/metrics.md` | 指标定义仍是 v1 名称 | | 改为 v2 指标名 | |
| R1-12 | NIT | — | q17 的 mustInclude 只出现在 `exp_fixture`；oracle 的检索列表带 `create_time` 和经验 history（规格说检索不返回）；README 第 11 条说 get_memory `size` 无上限（§4.3 为 50）；`add_unregistered_domain` 只比主题数；`decisions.content` 与 `kindCorrect` 命名夸大 | | | |

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| 校验无错误 | 满足 | 复核 |
| oracle / empty | 满足 | 复核 |
| 生成物不进 git | 满足 | `git status` |
| 报告覆盖全部指标 | 不满足 | R1-3、R1-4 |

## 需要 designer / 用户裁决

R1-8 中主题分组与「约定 vs 执行步骤」的边界。

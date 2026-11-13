---
item: PM-03-eval-dataset-v2
seq: 02
role: developer
app: Claude Code（收尾会话；修改由其子代理完成，收尾会话复核并补做真实回放）
model: claude-opus-5-5
date: 2026-11-05
branch: dev-project-memory-add-search-dev
base: 9aabf84b
head: 672919d5
to: reviewer
status: ready-for-review
---

# 交接 02：关闭 review-01 的 3 项 MUST 与 R1-4

## 结论

接口检查、一对一匹配和效率指标三项 MUST 已修复，R1-4（按题型的 LLM 分与 Token F1）也已加入。用修复后的 runner 对修复后的服务跑了一次真实回放，报告覆盖 metrics.md 效率表的每一行（R-20261105-02）。被测系统费用仍为 null，因为 `pricing.json` 没有 deepseek 单价。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `api-checks.mjs`（新）、`run-memmy-live-eval.mjs` | 接口检查独立成文件：space_ids 检查要求 `code === 40001`；隔离检查先在 ledger 空间提问作正对照，再在 catalog 空间确认无 ledger 主题；未登记 domain 要求 DOMAIN_INVALID；每项单独捕获异常；新增 `--api-checks-only <live-run.json>` | R1-1 | v3 §5.1.5 |
| `run-pipeline-eval.mjs` | 候选按「同 kind → 主 id → 写入顺序」排序；四轮匹配（必写同 kind、必写任意、可选同 kind、可选任意）；已按 kind 匹配的金标只能换给同 kind 的写入 | R1-2 | — |
| `run-memmy-live-eval.mjs`、`run-pipeline-eval.mjs`、`metrics.mjs`、`llm.mjs` | 每个请求记 phase / poll；每个任务记受理→完成耗时；分阶段 wallclock；`--sut-usage <file>`（或 `MEMMY_EVAL_SUT_USAGE`）读取用量代理日志；`efficiency.add/search` 输出全部效率字段，取不到的写 null 并附 `reasons`；阅读模型与评委分别计价；修复阅读模型计价把缓存 token 重复计费的问题 | R1-3 | metrics.md 指标定义 |
| `run-pipeline-eval.mjs` | `scores` 增加 `answers.llm.<题型>`、`answers.tokenF1.<题型>` | R1-4 | — |
| `run-memmy-live-eval.mjs` | `create/space` 只发 `space_name`，用返回的 `space_id` | 跟随产品契约（PM-05-09 R1-5） | Q-04 |
| `selftest.mjs`（新） | 12 个不需要评委的用例，覆盖 R1-1～R1-4 | 回归 | — |
| `harness/run-control-main.mjs` | 请求带 phase，对照组也能分阶段统计 | R1-3 | — |
| `README.md` | 新参数、检查规则、匹配规则、效率字段表 | | |

## 验证

| 命令 | 结果 |
| --- | --- |
| `node load-eval-set.mjs` | `errors: []` |
| `node run-pipeline-eval.mjs --oracle` | 43 项得分全为 1，错误全为 0 |
| `node run-pipeline-eval.mjs --empty` | 43 项得分全为 0 |
| `node selftest.mjs` | `12/12 passed`；R1-2 探针在旧版评分器上失败（子代理在 /tmp 副本中验证） |
| `MEMMY_EVAL_BASE=http://127.0.0.1:1/api/openmem/v1 node run-memmy-live-eval.mjs --api-checks-only <旧回放>` | `passRate: 0`，退出码 1（修复前为 0.5） |
| 真实回放 + 评分（服务 `59547700` 起，被测 deepseek，评委与阅读 haiku-5.5） | 23 题、36 个任务全部完成；4 项新规则接口检查全过；报告见 metrics.md R-20261105-02 |

## 与规格的偏离和简化

- `get/status` 轮询间隔上限从 3 s 改为 1 s，任务耗时更准，轮询请求更多（不计入请求数，单独报告）。
- search 的被测模型调用数报「0（实测）」：v0.1 检索不调模型，用量日志里的调用全部归入 add。

## 评审回应

| 意见 | 级别 | 处理 | commit / 理由 |
| --- | --- | --- | --- |
| R1-1 | MUST | 已修复 | 672919d5 |
| R1-2 | MUST | 已修复 | 672919d5；`selftest.mjs` 的 dec_tz 探针 |
| R1-3 | MUST | 已修复 | 672919d5；真实回放报告覆盖效率表全部行 |
| R1-4 | SHOULD | 已修复 | 672919d5 |
| R1-5～R1-11 | SHOULD | 未处理 | 留给下一轮；R1-8 已登记 open-questions Q-11 |
| R1-12 | NIT | 未处理 | |

## 请 reviewer 重点看

1. `run-pipeline-eval.mjs` 第 88–118 行的四轮匹配 — 是否还存在跨 kind 抢占
2. `api-checks.mjs` — 正对照在服务确实没有 ledger 主题时会让检查失败，是否符合预期
3. `run-pipeline-eval.mjs` `loadSutUsage` — 按回放时间窗过滤用量日志，同一代理被多次回放共用时的边界

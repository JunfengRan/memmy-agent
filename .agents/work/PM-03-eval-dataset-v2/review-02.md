---
item: PM-03-eval-dataset-v2
seq: 02
role: reviewer
app: Cursor
model: grok-4.7-high-fast
date: 2026-11-10
reviewed: handoff-02.md
range: 9aabf84b..672919d5
verdict: approved
---

# 评审 02：三项 MUST 与 R1-4 已关闭，可以通过

复核在独立 worktree `/tmp/pm-review-w46`（`3fe76c95`）的 `eval/project-memory/gold-add-memory/` 里进行。没有启动真实模型回放。

## 复核验证

| 命令 | 结果 |
| --- | --- |
| `node selftest.mjs` | `12/12 passed`，exit 0。含 dec_tz 不被进展抢走、拒连 / 404 / 500 / 空检索时 `passRate` 为 0、非 40001 不算通过、效率字段、按题型得分 |
| `node load-eval-set.mjs` | `errors: []`，exit 0。35 条轨迹、23 题、4 项接口检查 |
| `node run-pipeline-eval.mjs --oracle` | exit 0。43 个得分全是 1，14 个错误全是 0，`failures: []`。报告写在已忽略的 `eval/project-memory/runs/oracle-report.json` |
| `node run-pipeline-eval.mjs --empty` | exit 0。43 个得分全是 0，`failures: []`。报告写在已忽略的 `runs/empty-report.json` |

`docs/project-memory/metrics.md` 的 R-20261105-02 在。效率表有 wallclock、请求数（轮询另计）、被测 LLM 调用数、平均输入 / 输出 token、费用、请求延迟 P50/P95、任务受理到完成、模型延迟，评委和阅读模型单独列。add 费用是 null，原因是 `pricing.json` 没有 deepseek 单价，按交接和指标定义接受，不记 MUST。search 调用数写的是 0（实测）。本轮没有重跑那次回放。

交接点名的三处：四轮匹配在 selftest 的 dec_tz 探针上，进展写在决策前面也配不走 `dec_tz`（`run-pipeline-eval.mjs:89`）。隔离检查的正对照为空会失败，这就是 R1-1 要的正面证据（`api-checks.mjs:50`）。`loadSutUsage` 按 `startedAt` 到 `wallclockMs` 开窗，代理写的是 ISO 时间（`usage-proxy.mjs:25`），selftest 断言窗口外的一行不计入（`outsideRun === 1`）。

## 上一轮 MUST 的关闭情况

| 意见 | 结果（已关闭 / 未关闭 / 转裁决） | 说明 |
| --- | --- | --- |
| R1-1 | 已关闭 | `search_requires_space_ids`、`add_requires_space_ids` 要求 `code === 40001`（`api-checks.mjs:18`、`api-checks.mjs:25`）。隔离检查先在 ledger 空间要到至少 1 个 ledger 主题，再查 catalog（`api-checks.mjs:38`）。拒连、404、500、空结果在 selftest 里 `passRate` 为 0 |
| R1-2 | 已关闭 | 候选按同 kind、主 id、写入顺序排（`run-pipeline-eval.mjs:98`）。四轮里，已经配上同 kind 写入的金标只能再换到同 kind 写入（`run-pipeline-eval.mjs:102`）。selftest 把带 `dec_tz` 原文的进展插到最前，决策的 content / userIds / time 仍全对 |
| R1-3 | 已关闭 | `efficiency()` 输出 add / search 的请求数、轮询、wallclock、LLM 调用、token、费用、延迟和 add 的任务耗时；没有用量文件或没有单价时字段为 null 并写 `reasons`（`run-pipeline-eval.mjs:371`）。R-20261105-02 的效率表覆盖指标定义里的这些行 |
| R1-4 | 已关闭 | 上一轮是 SHOULD。`scores` 有 `answers.llm.<题型>` 和 `answers.tokenF1.<题型>`（`run-pipeline-eval.mjs:314`）。oracle 上 selftest 要求每个题型都是 1。R-20261105-02 写了四类题的 LLM 分和 Token F1 |

上一轮 SHOULD（R1-5～R1-11）和 NIT（R1-12）未在本轮复核范围。R1-8 仍登记为 Q-11。

## 意见

无新意见。

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| `node load-eval-set.mjs` 无错误 | 满足 | `errors: []` |
| `--oracle` 每项得分 1、每项错误 0；`--empty` 每项得分 0 | 满足 | 43 个得分；oracle 的 14 个错误键全是 0；empty 的 43 个得分全是 0 |
| 生成物不进 git | 满足 | 两份报告命中 `.gitignore` 的 `/eval/project-memory/runs/`；worktree 里没有已跟踪文件被改 |
| 报告覆盖 metrics.md「指标定义」的全部指标（R-20261105-02；费用因无单价为 null，附原因） | 满足 | R-20261105-02 的写入、检索、回答、效率四张表。费用 null 附了无 deepseek 单价 |
| 评审 MUST 全部关闭 | 满足 | R1-1～R1-3 已关闭，本轮没有新的 MUST |

## 需要 designer / 用户裁决

无。

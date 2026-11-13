# 旧 session-as-topic 实验记录摘录

原样摘自 `65e61c7e` 的 `docs/project-memory/metrics.md`。这是 v2、v0.1 的历史记录，不是整合后 v2.1 的新结果；记录 ID 仅在原分支内唯一。

### R-20261106-01

**元数据**

| 项 | 值 |
| --- | --- |
| 被测实现 | `feat/superagent-session-as-topic`，HEAD `25ff3fff`，服务跑的是未提交的工作区（router、锁定 topic 的组织、retrieve 检索）。回放时工作区不干净 |
| 回放脚本 | `run-memmy-live-eval.mjs`（runnerRevision 2）；用量经 `harness/usage-proxy.mjs`，评分加 `--sut-usage`。阅读模型走 OpenAI 兼容接口时，Claude 5 不再传 `temperature`（`llm.mjs`，与 Anthropic 接口同一规则） |
| 评测配置 | 复制的 `harness/eval-config.yaml`：token 限流关闭、检索 LLM 过滤关闭、不扫描本机 Agent 会话。本机向量模型 `Xenova/all-MiniLM-L6-v2` 下载失败，写入时的向量索引和召回都退回，检索选主题不依赖向量 |
| 数据集 | v2：35 轮、5 主题、23 必写 + 12 可选条目、10 条负例、23 题、4 项接口检查。`load-eval-set` errors 为 [] |
| 提示词版本 | `pm-route-v0.1.0`、`pm-organize-v0.1.1` |
| 被测模型 | deepseek-v4.1-flash-1017（`~/.deepseek.env`；网关有时返回 `deepseek-v4-1-flash-261017`） |
| 评委 / 阅读模型 | claude-haiku-5-5 / claude-haiku-5-5（都来自 `~/.claude.env`）。`~/.openai.env` 不存在，没有改用备用模型。Claude 5 拒绝 `temperature`，这两次调用用模型默认采样；报告里的 temperature 0 是评分脚本的字段 |
| `memory_limit_number` | 9 |

**写入质量（add）**

| 指标 | 值 |
| --- | --- |
| entries.f1（P / R） | 0.583（0.560 / 0.609） |
| decision P / R / F1 | 0.600 / 0.800 / 0.686 |
| experience P / R / F1 | 0.000 / 0.000 / 0.000 |
| timeline P / R / F1 | 0.500 / 0.143 / 0.222 |
| kind 正确率 | 0.565 |
| decisions.stateExact；content / conflicts / history / userIds / time | 0.733；0.800 / 0.800 / 0.733 / 0.733 / 0.800 |
| decisions.reasons | 0.000 |
| topics.bcubed P / R / F1；实际 / 金标主题数 | 0.485 / 0.180 / 0.262；17 / 5（ledger 11，catalog 6） |
| topics.domain / keyPoints | 0.800 / 0.429 |
| 误写率；旧版当当前 / 不一致成条 / 无法归属 / 重复 / 超长；原因臆造；重复主题 / 错误合并 | 0.200；7 / 1 / 0 / 0 / 0；0；8 / 0 |

**检索（search）**

| 指标 | 值 |
| --- | --- |
| topic Recall@1 / @3 / @9 | 0.826 / 0.913 / 0.913 |
| entryHit / itemHit | 0.652 / 0.692 |
| 旧版在 history / conflicts（预期） | 0.333 |
| 旧版作为当前 / 跨空间泄漏 / 别处主题 / 超限 | 4 / 0 / 0 / 0 |

**回答**

| 指标 | 值 |
| --- | --- |
| answers.llm（总体） | 0.652（15 / 23） |
| answers.llm 按题型 | conflict 0.333（3）· cross-project 1.000（10）· plain 0.600（5）· stale 0.200（5） |
| answers.rubric（总体） | 0.739 |
| Token F1（总体） | 0.416 |
| Token F1 按题型 | conflict 0.532 · cross-project 0.491 · plain 0.265 · stale 0.348 |
| 接口检查 api.passRate | 1.000（4 / 4） |

**效率**

| 指标 | add | search |
| --- | --- | --- |
| wallclock（整轮 1088.5 s） | 983.7 s | 30.8 s（阅读模型另 63.0 s） |
| 请求数（不含 get/status 轮询） | 35（轮询 1070） | 24（23 题 + 1 次 searchBefore） |
| 被测系统 LLM 调用数 | 75（失败 0） | 24（失败 0） |
| 平均输入 / 输出 token | 合计 185591 / 9293，评分脚本未按 add 与 search 拆开；按全部 99 次平均为 1875 / 94 | 同上，未拆开 |
| 任务「受理 → 完成」 | P50 33.6 s / P95 34.2 s（含每次约 30 s 的向量下载失败等待） | — |
| 平均费用 / 总费用（USD） | null / null（`pricing.json` 没有这两个 deepseek 模型名的单价） | null / null |
| 请求延迟 P50 / P95 | 5.1 / 10.0 ms（只含 add/message 受理） | 1218 / 1646 ms |
| 被测系统单次模型延迟 P50 / P95 | 1294 / 3925 ms（99 次合在一起） | — |
| 评委开销（不计入产品） | 80 次调用（缓存命中 1），$0.0199 | |
| 阅读模型开销（不计入产品） | 23 次调用，$0.0077 | |

**备注**：

- 和 v0.1 同口径的 R-20261105-02 比：answers.llm 0.609 → 0.652（15/23，多对 1 题）。cross-project 0.900 → 1.000，plain 0.400 → 0.600；conflict 仍是 0.333；stale 0.400 → 0.200。topic Recall@3 持平 0.913，Recall@1 0.783 → 0.826。entries.f1 0.667 → 0.583，decisions.stateExact 0.800 → 0.733。主题 B-cubed F1 0.473 → 0.262。错误合并 1 → 0，重复主题 0 → 8。
- 主题变多是因为 router 按 super agent 的规则：主题相近就 `accept` 新 session，只有消息明确指向已有 session 才 `attach`。最终 17 个 topic，金标是 5 个。stale 题更容易把旧结论当成当前结论（检索里旧版当当前从 2 增到 4）。跨空间泄漏仍是 0，因为 retrieve 只看本题 `space_ids` 里的 session。
- 回答上限仍是 R-20261105-03 的 0.826。这次 0.652，还差约 0.17。
- 评分脚本仍假设「search 不调模型」，把用量文件里 99 次调用都算进 add，并记下其中 24 次落在 search 请求窗口。上表按这个窗口把 24 次 retrieve 算给 search，其余 75 次算给写入。token 没有按窗口拆开。
- 单次运行。被测模型有随机性，和 R-02 的差距不能全部当成路由算法的效果。
- 原始结果：`eval/project-memory/runs/2026-11-06T06-04-42-036Z/`（不进 git）。`--gate` 未过：stateExact、topic F1、entries.f1、answers.llm 低于脚本里的 0.8，且 `search.staleShownAsCurrent` 为 4。


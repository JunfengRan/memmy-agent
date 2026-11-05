# 评测记录

每次评测追加一条记录（最新放最上面），由 `pm-eval` 维护。**每条记录必须填全「指标定义」里的全部指标**，测不了的写「不适用」并说明原因，不能留空或省略。原始输出在 `eval/project-memory/runs/`（不进 git）。

## 目标（v3）

| 指标 | 目标 | 出处 |
| --- | --- | --- |
| 重复主题率 | ≤2% | §2.2.7 |
| 错误合并率 | ≤1% | §2.2.7 |
| 归类准确率 | ≥0.90 [TBD] | §2.2.7 |
| 「同一问题」判定准确率 | ≥0.90 [TBD] | §2.2.9 |
| 三类条目召回 / 精确 | ≥0.85 / ≥0.90 [TBD] | §2.4 |
| 非作者未认可改写 content | 0 | §2.2.9 |
| 迟交改写更晚决策 | 0 | §2.2.9 |
| 原因臆造 | 0 | §2.4 |
| 复述误写 | ≤2% | §3.6 |
| 检索三路齐全或标记降级 | 100% | §3.2.3 |
| 输出确定性 | 100% | §3.6 |
| 单路 / 总 P95 | ≤800 ms / ≤1.2 s | §3.2.3 |

## 指标定义（数据集 v2，与 `run-pipeline-eval.mjs` 一致）

**归属与匹配**：最终状态里的每条条目由评委归属为 match / stale / conflict / negative / none，文本完全一致时按规则判定。然后一对一匹配：必写条目先匹配，optional 后匹配。

**写入质量（add）**：分组条目 P/R/F1（decision / experience / timeline 与总体）、kind 正确率；决策的 content、conflicts、history、user_ids、time 逐项正确率与全对的 stateExact；有依据的原因比例；Topic B-cubed（含未匹配）；topic domain 正确率与摘要描述要点覆盖率。错误类：不该写入的误写率、旧版当当前、不一致结论单独成条、无法归属、重复、超长；原因臆造；重复主题与错误合并。

**检索（search）**：期望主题进入前 k 个返回主题的比例（topic Recall@1/3/9）；期望条目出现在正确位置的比例（entryHit / itemHit）；旧版本出现在 history / conflicts 的比例（预期行为）。错误类：旧版作为当前内容出现、跨空间泄漏、出现别处主题、超过 9 个主题。

**回答**：评委判对错（总体与按题型）、mustInclude 全中的比例（rubric）、与标准答案的 Token F1（中文字级、英文词级；总体与按题型）。

**效率（add 与 search 分开，评委与阅读模型单独列）**：wallclock；请求数（不含 get/status 轮询）；被测系统 LLM 调用数；平均输入 token（含缓存命中）与输出 token；平均 / 总费用（USD，按 `pricing.json`，模型无单价记 null）；请求延迟 P50 / P95；异步 add 另记任务「受理 → 完成」的耗时；评委与阅读模型的调用数、token 与费用不计入产品。

## 记录

### 索引

| 记录 | 日期 | 被测实现 | 数据集 | entries.f1 | decisions.stateExact | Recall@3 | answers.llm | Token F1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [R-20261105-01](#r-20261105-01) | 2026-11-05 | v0.1（本分支 `44dcbb1e`） | v2 | 0.651 | 0.800 | 0.913 | 0.609 | 0.431 |
| [R-20261104-02](#r-20261104-02) | 2026-11-04 | main 分支对照（无项目记忆） | v1 | 0.000 | 不适用 | 0.117 | 0.100 | 0.054 |
| [R-20261104-01](#r-20261104-01) | 2026-11-04 | 旧实现（Codex 版） | v1 | 0.237 | 不适用 | 0.700 | 0.967 | 0.400 |

### R-20261105-01

**元数据**

| 项 | 值 |
| --- | --- |
| 被测实现 | `dev-project-memory-add-search-dev` @ `44dcbb1e`（工作区另含未提交的评测辅助脚本） |
| 回放脚本 | `run-memmy-live-eval.mjs`；用量经 `harness/usage-proxy.mjs` 记录 |
| 评测配置 | `harness/eval-config.yaml`：token 限流关闭、检索 LLM 过滤关闭、不扫描本机 Agent 会话 |
| 数据集 | v2：35 轮、5 主题、23 必写 + 12 可选条目、10 条负例、23 题、4 项接口检查 |
| 提示词版本 | `project-memory/prompts/organize.ts`（未带版本号，见 open-questions） |
| 被测模型 | deepseek-v4.1-flash-1017（网关返回 `deepseek-v4-1-flash-261017`） |
| 评委 / 阅读模型 | claude-haiku-5-5 |
| `memory_limit_number` | 9 |

**写入质量（add）**

| 指标 | 值 |
| --- | --- |
| entries.f1（P / R） | 0.651（0.700 / 0.609） |
| decision P / R / F1 | 0.706 / 0.800 / 0.750 |
| experience P / R / F1 | 0.000 / 0.000 / 0.000（数据集里只有 1 条必写经验） |
| timeline P / R / F1 | 1.000 / 0.143 / 0.250 |
| kind 正确率 | 0.565 |
| decisions.content / conflicts / history / userIds / time | 0.800 / 0.800 / 0.800 / 0.800 / 0.800 |
| decisions.stateExact | 0.800 |
| decisions.reasons | 0.500 |
| topics.bcubed P / R / F1 | 0.518 / 0.251 / 0.338（实际 10 个主题，金标 5 个） |
| topics.domain | 1.000 |
| topics.keyPoints | 0.357 |
| 不该写入的误写率 | 0.100 |
| 旧版当当前 / 不一致结论单独成条 / 无法归属 / 重复 / 超长 | 4 / 1 / 0 / 0 / 0 |
| 原因臆造 | 1 |
| 重复主题 / 错误合并 | 4 / 1 |

**检索（search）**

| 指标 | 值 |
| --- | --- |
| topic Recall@1 / @3 / @9 | 0.609 / 0.913 / 0.957 |
| entryHit / itemHit | 0.565 / 0.577 |
| 旧版在 history / conflicts（预期） | 0.167 |
| 旧版作为当前内容出现 | 3 |
| 跨空间泄漏 / 别处主题 / 超过 9 个主题 | 0 / 0 / 0 |

**回答**

| 指标 | 值 |
| --- | --- |
| answers.llm（总体） | 0.609 |
| answers.llm 按题型 | conflict 0.667（3）· cross-project 0.900（10）· plain 0.400（5）· stale 0.200（5） |
| answers.rubric（总体） | 0.696 |
| Token F1（总体） | 0.431 |
| Token F1 按题型 | 未按题型输出（评分器待改，见 PM-03 review R1-4） |

**效率**

| 指标 | add | search |
| --- | --- | --- |
| wallclock（整轮含建 Space、读取最终状态与接口检查） | 169.2 s | （同左，整轮合计） |
| 请求数（不含 get/status 轮询） | 37 | 30 |
| 被测系统 LLM 调用数 | 35（每批一次，含重试） | 0 |
| 平均输入 / 输出 token | 2215 / 219 | 不统计 |
| 平均费用 / 总费用（USD） | null / null（`pricing.json` 无 deepseek 单价） | 不统计 |
| 请求延迟 P50 / P95 | 2.1 ms / 2.5 ms（仅入队，异步） | 7.0 ms / 8.7 ms |
| 任务「受理 → 完成」 | 平均 2102 ms，范围 746–3433 ms（35 个任务） | — |
| 被测系统单次模型延迟 P50 / P95 | 2139 ms / 2999 ms（35 次） | — |
| 评委开销（不计入产品） | 53 次调用 + 20 次缓存，$0.0070 | |
| 阅读模型开销（不计入产品） | 23 次调用，输入 92 / 输出 6743 / 缓存 10280 token | |

**备注**：

- 接口检查 4 项全过，但按评审 R1-1 目前用 `!ok` 判通过，证据偏弱。
- `topics.bcubed` 低主要是主题拆得过细（10 对 5）与 keyPoints 覆盖不足 0.357，与 `staleAsCurrent` 4 条同源：旧版说法被写成当前条目。
- 按 ADR-0005，`split`、复述过滤、推迟回填、三路召回在本版未实现，相关指标会系统性偏低。

### 旧记录（v1 数据集，口径不同，不可与新记录逐项对比）

之前两条记录用的是 v1 金标、条目级 Recall 与 28 条 trace 回显，保留仅作参照。指标定义见 ADR-0004。

#### R-20261104-02（main 分支对照）

被测实现 `main` @ `6853b777`，无项目记忆：每条轨迹写成一条 L1 记忆，标签模拟 `space_ids`；回答直接拼接命中片段。Entry / 内容 F1 为 0；条目级 Recall@1/3/5/10 为 0.017 / 0.117 / 0.117 / 0.117；LLM 0.100；Token F1 0.054；trap 0.111；add 34 次请求、2.2 ms / 11.0 ms，search 30 次、958 ms / 1296 ms；wallclock 24.8 s。本地 embedding 失败，向量通道不可用。

#### R-20261104-01（旧实现）

被测实现为 Codex 版旧实现。Entry F1 0.237（P 0.226 / R 0.250），内容 F1 0.644，模型 5 个主题对金标 7 个，B-cubed F1 0.813；条目级 Recall@1/3/5/10 为 0.400 / 0.700 / 0.850 / 0.967；LLM 0.967，Token F1 0.400，trap 0.519；add 12 次请求、11 次 LLM 调用、平均输入 1394 / 输出 270、1730 ms / 3355 ms，search 30 次、1006 ms / 1529 ms；wallclock 55.3 s。

## 记录模板

复制下面这段到「记录」最上面，并在索引表加一行。每个指标都要有值；测不了写「不适用（原因）」。

```markdown
### R-YYYYMMDD-NN

**元数据**

| 项 | 值 |
| --- | --- |
| 被测实现 | 分支 @ commit；工作区是否干净 |
| 回放脚本 | |
| 评测配置 | |
| 数据集 | 版本、条目 / topic / 题数 |
| 提示词版本 | |
| 被测模型 | |
| 评委模型 | |
| `memory_limit_number` | |

**写入质量（add）**

| 指标 | 值 |
| --- | --- |
| entries.f1（P / R） | |
| decision / experience / timeline F1 | |
| kind 正确率 | |
| decisions.stateExact；content / conflicts / history / userIds / time | |
| topics.bcubed P / R / F1；实际 / 金标主题数 | |
| Topic 归纳 B-cubed F1（P / R） | |
| topics.domain / keyPoints | |
| 误写率；旧版当当前 / 不一致成条 / 重复 / 超长；原因臆造；重复主题 / 错误合并 | |

**检索（search）**

| 指标 | 值 |
| --- | --- |
| topic Recall@1 / @3 / @9 | |
| entryHit / itemHit | |
| Recall@10 按题型 | |
| 旧版在 history / conflicts；旧版作为当前 / 跨空间泄漏 / 别处主题 / 超限 | |

**回答**

| 指标 | 值 |
| --- | --- |
| LLM score（总体） | |
| LLM score 按题型 | |
| Token F1（总体） | |
| Token F1 按题型 | |
| 短语 rubric 准确率 | |

**效率**

| 指标 | add | search |
| --- | --- | --- |
| wallclock（整轮） | | |
| 请求数 | | |
| LLM 调用数 | | |
| 平均输入 token | | 不统计 |
| 任务「受理 → 完成」 | | — |
| 平均输出 token | | |
| 平均费用 / 总费用（USD） | | |
| 延迟 P50 / P95 | | |
| 评委开销 / 阅读模型开销 | | |

**备注**：
```

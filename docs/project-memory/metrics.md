# 评测记录

每次评测追加一条记录，由 `pm-eval` 维护。文首三张总表是审计和汇报用的：一行只放这次阶段真正测到的数。没测的阶段不逐格写「不适用」。原始输出在 `eval/project-memory/runs/`（不进 git）。

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
| 单路 / 总 P95 | ≤800 ms / ≤1.2 s | §3.6 |
| 渲染 P95 | ≤5 ms | §3.6 |

## 指标定义（数据集 v2，与 `run-pipeline-eval.mjs` 一致）

**归属与匹配**：最终状态里的每条条目由评委归属为 match / stale / conflict / negative / none，文本完全一致时按规则判定。然后一对一匹配：必写条目先匹配，optional 后匹配。

**写入质量（add）**：分组条目 P/R/F1（decision / experience / timeline 与总体）、kind 正确率；决策的 content、conflicts、history、user_ids、time 逐项正确率与全对的 stateExact；有依据的原因比例；Topic B-cubed（含未匹配）；topic domain 正确率与摘要描述要点覆盖率。错误类：不该写入的误写率、旧版当当前、不一致结论单独成条、无法归属、重复、超长；原因臆造；重复主题与错误合并。

**检索（search）**：期望主题进入前 k 个返回主题的比例（topic Recall@1/3/9）；期望条目出现在正确位置的比例（entryHit / itemHit）；旧版本出现在 history / conflicts 的比例（预期行为）。错误类：旧版作为当前内容出现、跨空间泄漏、出现别处主题、超过 9 个主题。

**回答**：评委判对错（总体与按题型）、mustInclude 全中的比例（rubric）、与标准答案的 Token F1（中文字级、英文词级；总体与按题型）。

**效率（add 与 search 分开，评委与阅读模型单独列）**：wallclock；请求数（不含 get/status 轮询）；被测系统 LLM 调用数；平均输入 token（含缓存命中）与输出 token；平均 / 总费用（USD，按 `pricing.json`，模型无单价记 null）；请求延迟 P50 / P95；异步 add 另记任务「受理 → 完成」的耗时；评委与阅读模型的调用数、token 与费用不计入产品。

## 记录

总表只放这次运行真正测到的数。同一记录可以占两行：`-add` 是写入，`-search` 是检索或回答。金标抄进 run 之后 entries.f1 和 Recall 都是 1，那是评分器自检，不放进产品写入行，也不和 answers.llm 放在同一行。没跑过的写「未跑」，不沿用别的记录。

v1 的两条口径不同，放在文末附录，不进这三张表。

### 端到端

产品先 add，再用写下的记忆 search，再由阅读模型作答。当前代码在数据集 v2.1 上没有这种运行。

| 记录 | 实现 | 数据集 | entries.f1 | stateExact | 主题 F1 | 重复主题 / 错误合并 | Recall@1/3/9 | entryHit | answers.llm | rubric | Token F1 | add P95 | search P95 | 开销 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [R-20261105-02](#r-20261105-02) | v0.1 + MUST 修复 `672919d5` | v2 | 0.667 | 0.800 | 0.473 | 0 / 1 | 0.783 / 0.913 / 0.913 | 0.522 | 0.609 | 0.739 | 0.441 | 入队 3.3 ms；任务完成 3430 ms；模型 2700 ms | 27.8 ms | 整轮 148.2 s。add 35 次调用，输入/输出 2093/192 token，费用 null。search 0 次聊天模型。评委 50 次 + 19 次缓存，$0.0057。阅读 23 次，$0.0029 |
| [R-20261105-01](#r-20261105-01) | v0.1 `44dcbb1e` | v2 | 0.651 | 0.800 | 0.338 | 4 / 1 | 0.609 / 0.913 / 0.957 | 0.565 | 0.609 | 0.696 | 0.431 | 入队 2.5 ms；任务完成平均 2102 ms；模型 2999 ms | 8.7 ms | 整轮 169.2 s。add 35 次调用，输入/输出 2215/219 token，费用 null。search 0 次聊天模型。评委 53 次 + 20 次缓存，$0.0070。阅读 23 次 |
| [R-20261105-04](#r-20261105-04) | 旧实现 `9aabf84b`，同口径 | v2 | 0.294 | 0.000 | 0.127 | 1 / 0 | 0.261 / 0.391 / 0.391 | 0.826 | 0.565 | 0.739 | 0.434 | 2371 ms（同步，含模型；模型单次 2359 ms） | 4.7 ms | 整轮 150.3 s。add 35 次调用，输入/输出 779/118 token，费用 null。评委 65 次，$0.0103。阅读 22 次 + 1 次缓存，$0.0061 |
| 当前代码 | 拆分整理、三路召回、注入之后 | v2.1 | 未跑 | 未跑 | 未跑 | 未跑 | 未跑 | 未跑 | 未跑 | 未跑 | 未跑 | 未跑 | 未跑 | 2026-11-10 两次回放停在阅读模型 503，只留下 `runs/2026-11-10T10-26-44-807Z` 和 `2026-11-10T10-27-50-669Z` 的 `live-run.partial.json`。不填上面三行的旧数 |

按题型的 answers.llm：R-02 是 conflict 0.333、cross-project 0.900、plain 0.400、stale 0.400。R-01 是 0.667 / 0.900 / 0.400 / 0.200，按题型 Token F1 那次没有拆开。R-04 是 1.000 / 0.800 / 0.400 / 0.000。

### 只测写入

不经过产品检索。Jev 的「准确率」是主题归属，不是 entries.f1。

| 记录 | 测什么 | 结果 | 开销 |
| --- | --- | --- | --- |
| [R-20261106-01-add](#r-20261106-01) | gpt-6-luna 在金标主题卡上做 add 选择题。不启动记忆服务 | 归属 0.882（30/34）。已有主题 1.000（21/21），新建 0.600（3/5），无关 0.750（6/8）。词法对照 0.588（已有 0.810，新建 0.600，无关 0，词法不会判无关） | 与下面的 search 行共用：34 次 add + 23 次 search 合计 157.2 s，57 次调用，输入/输出 25349/5639 token，P50/P95 2262/7425 ms，费用 null。模型不接受温度 0 |

金标被原样写入评分器时，entries.f1、stateExact、主题 F1、Recall 都是 1。这只说明评分器认得金标，不单列成写入实验。

### 只测检索或只测回答

记忆来自金标或金标主题卡，不是同一行 add 写出来的。

| 记录 | 测什么 | 检索或回答 | 开销 |
| --- | --- | --- | --- |
| [R-20261106-01-search](#r-20261106-01) | 同一批金标主题卡上的选题。列名是选题 Recall，不是流水线 Recall@3 | 选中 Recall@1 0.826（19/23）。按概率 0.957 / 1.000 / 1.000。词法 0.522 / 1.000 / 1.000。按题型选中：conflict 1.000、cross-project 0.800、plain 0.600、stale 1.000。按概率排序时 22/23 题正确主题排第一，3 题最终选了 none 或 new | 见上一张表的合计 |
| [R-20261110-04](#r-20261110-04) | 阅读上限。提示词 v2，q24 标准答案已改。阅读 claude-sonnet-4-6，评委 claude-haiku-4-5-20251001，温度 0 | answers.llm 1.000（31/31），四类题型都是 1。rubric 0.871（27/31）。Token F1 0.549（conflict 0.631、cross-project 0.586、plain 0.516、stale 0.512） | 阅读 31 次，输入/输出 41436/2568 token，约 81 s。评委 31 次，13568/2677 token，约 75 s。两个模型都没有单价，费用 null |
| [R-20261110-03](#r-20261110-03) | 阅读上限。提示词 v1，阅读模型换成 Sonnet，评委与上一行相同 | answers.llm 0.935（29/31），错题 q03、q24。rubric 0.935。Token F1 0.526。按题型 answers.llm：conflict 1、cross-project 0.900、plain 0.923、stale 1 | 阅读 31 次，39359/2464 token，约 82 s。评委 31 次，13458/2706 token，约 72 s。费用 null |
| [R-20261110-02](#r-20261110-02) | 阅读上限。提示词 v1，阅读和评委都是 claude-haiku-4-5-20251001 | answers.llm 0.903（28/31），错题 q03、q24、q25。rubric 0.903。Token F1 0.510。按题型 answers.llm：conflict 1、cross-project 0.800、plain 0.923、stale 1 | 阅读 31 次，39297/2565 token，约 192 s。评委 31 次，13644/2651 token，约 479 s。费用 null |
| [R-20261105-03](#r-20261105-03) | 数据集 v2 的阅读上限。阅读和评委都是 claude-haiku-5-5 | answers.llm 0.826（19/23），错题 q01、q03、q14、q17。rubric 0.957。Token F1 0.526。按题型 answers.llm：conflict 1.000、cross-project 0.900、plain 0.600、stale 0.800 | 阅读 23 次，约 70 s。评委约 23 次。费用未单列 |
| [R-20261110-01-search](#r-20261110-01) | 金标灌库后的检索延迟。stub embedding，无聊天模型。S 档是门槛 | 第 3 路 P50/P95 0.579/0.741 ms。总检索 1.194/1.462 ms。渲染 0.005/0.008 ms。超时 0。n=620。第 1 路 0.025/0.032 ms、第 2 路 0.526/0.666 ms，两路都是空库，只算链路开销。金标灌库 Recall@1/3/9 0.581/0.968/0.968，不是流水线分 | 计时循环 1765 ms（含丢掉的 3 轮预热和 20 轮测量）。620 次样本，0 次聊天模型。HTTP P95 未跑 |
| R-20261110-01-L | 同一脚本的 L 档，500 个主题，只作参照，不参与门槛 | 第 3 路 P95 1.599 ms，总 P95 2.922 ms，渲染 P95 0.010 ms，超时 0。金标灌库 Recall@1/3/9 0.194/0.968/1.000 | 见 `runs/pm23-search-latency-L-stub.json` |

**口径**：R-20261106 的选题 Recall 不能和端到端表的流水线 Recall@3 对比。v2 的 0.826 不能和 v2.1 的 0.903、0.935、1.000 逐题对比，数据集、题数、阅读模型都不同。R-20261110-02 和 R-20261110-03 的 q24 标准答案是改之前的那句。端到端三行是单次运行。v1 附录里的 0.967 用的是被测系统自己的 `generate_answer`，不能和这些 answers.llm 比。

### R-20261110-04

**元数据**

| 项 | 值 |
| --- | --- |
| 被测实现 | 不是产品。金标在每个 `askedAt` 的 `topic_detail_list` 经 `harness/run-reader-ceiling.mjs` 交给阅读模型。阅读提示词 v2。q24 的标准答案取自 dec_price，只把原因放到句首。R-20261110-02 和 R-20261110-03 用的是改之前的答案。代码在本次提交前的工作区 |
| 目的 | 去掉「问测试怎么写、却只因没贴代码就说没有内容」和「标准答案没写出 price 表、评委把正确回答当成另一张表」这两处上限损失 |
| 回放脚本 | `harness/run-reader-ceiling.mjs`，评分用 `run-pipeline-eval.mjs`，不加 `--gate`。原始输出在 `eval/project-memory/runs/2026-11-10T14-27-24-707Z/`（不进 git） |
| 评测配置 | 不起服务。阅读与评委都走 OpenAI 兼容的 chat completions，温度 0 |
| 数据集 | v2.1：113 轮、50 个主题、78 条必写 + 12 条可选、25 条负例、31 题、4 项接口检查（接口检查按 oracle 记通过）。q03 的问句没改，仍与 q04 成对 |
| 提示词版本 | 阅读模型提示词 v2，评委提示词 v4。产品提示词未参与 |
| 被测模型 | 不适用（金标，无模型） |
| 评委 / 阅读模型 | claude-haiku-4-5-20251001 / claude-sonnet-4-6 |
| `memory_limit_number` | 9 |

**写入质量（add）**

| 指标 | 值 |
| --- | --- |
| entries.f1（P / R） | 1.000（1.000 / 1.000） |
| decision / experience / timeline F1 | 1.000 / 1.000 / 1.000 |
| kind 正确率 | 1.000 |
| decisions.stateExact；content / conflicts / history / userIds / time | 1.000；1.000 / 1.000 / 1.000 / 1.000 / 1.000 |
| decisions.reasons | 1.000 |
| topics.bcubed P / R / F1 | 1.000 / 1.000 / 1.000 |
| topics.domain / keyPoints | 1.000 / 1.000 |
| 误写率；旧版当当前 / 不一致成条 / 无法归属 / 重复 / 超长；原因臆造；重复主题 / 错误合并 | 0；0 / 0 / 0 / 0 / 0；0；0 / 0 |

**检索（search）**

| 指标 | 值 |
| --- | --- |
| topic Recall@1 / @3 / @9 | 1.000 / 1.000 / 1.000 |
| entryHit / itemHit | 1.000 / 1.000 |
| 旧版在 history / conflicts（预期） | 1.000 |
| 旧版作为当前 / 跨空间泄漏 / 别处主题 / 超限 | 0 / 0 / 0 / 0 |

**回答**

| 指标 | 值 |
| --- | --- |
| answers.llm（总体） | 1.000（31 / 31） |
| answers.llm 按题型 | conflict 1.000 · cross-project 1.000 · plain 1.000 · stale 1.000 |
| answers.rubric（总体） | 0.871（27 / 31）。q03、q04、q05、q41 的回答换了标点或说法，mustInclude 逐字未中，评委仍判对 |
| Token F1（总体） | 0.549 |
| Token F1 按题型 | conflict 0.631 · cross-project 0.586 · plain 0.516 · stale 0.512 |
| 接口检查 api.passRate | 1.000（oracle 记通过，不代表产品） |

开销见文首总表。上面写入和检索全是 1，因为最终状态就是金标，总表不把它们当成产品 add 或流水线检索。

**备注**：

- q03 的回答说出了「没有客户名时，这笔不进月报」，后面仍写「无法说明断言和用例是怎么写的」。评委把这句多余的话放过了。换评委或阅读模型时要再看这一题。mustInclude 因为多了一个逗号没逐字命中。
- q24 的标准答案事实取自 dec_price，只把原因放到句首，不是逐字原文。评委不再把 price 表当成另一个需求。
- 重复率与错误合并率在这份金标上是 0。这只说明评分器能算出这两项。产品回放仍未跑。

### R-20261110-03

**元数据**

| 项 | 值 |
| --- | --- |
| 被测实现 | 不是产品。金标在每个 `askedAt` 的 `topic_detail_list` 经 `harness/run-reader-ceiling.mjs` 交给阅读模型。代码 `bec693c2`，工作区干净 |
| 目的 | 用第二个阅读模型测同一份 v2.1 金标上限。评委与 R-20261110-02 相同 |
| 回放脚本 | `harness/run-reader-ceiling.mjs`，评分用 `run-pipeline-eval.mjs`，不加 `--gate`。原始输出在 `eval/project-memory/runs/2026-11-10T14-22-31-379Z/`（不进 git） |
| 评测配置 | 不起服务。阅读与评委都走 OpenAI 兼容的 chat completions，温度 0 |
| 数据集 | v2.1：113 轮、50 个主题、78 条必写 + 12 条可选、25 条负例、31 题、4 项接口检查（接口检查按 oracle 记通过） |
| 提示词版本 | 阅读模型提示词 v1，评委提示词 v4。产品提示词未参与 |
| 被测模型 | 不适用（金标，无模型） |
| 评委 / 阅读模型 | claude-haiku-4-5-20251001 / claude-sonnet-4-6。两者都是 Claude 家族，被测无模型，不触发家族检查 |
| `memory_limit_number` | 9 |

**写入质量（add）**

| 指标 | 值 |
| --- | --- |
| entries.f1（P / R） | 1.000（1.000 / 1.000） |
| decision / experience / timeline F1 | 1.000 / 1.000 / 1.000 |
| kind 正确率 | 1.000 |
| decisions.stateExact；content / conflicts / history / userIds / time | 1.000；1.000 / 1.000 / 1.000 / 1.000 / 1.000 |
| decisions.reasons | 1.000 |
| topics.bcubed P / R / F1 | 1.000 / 1.000 / 1.000 |
| topics.domain / keyPoints | 1.000 / 1.000 |
| 误写率；旧版当当前 / 不一致成条 / 无法归属 / 重复 / 超长；原因臆造；重复主题 / 错误合并 | 0；0 / 0 / 0 / 0 / 0；0；0 / 0 |

**检索（search）**

| 指标 | 值 |
| --- | --- |
| topic Recall@1 / @3 / @9 | 1.000 / 1.000 / 1.000 |
| entryHit / itemHit | 1.000 / 1.000 |
| 旧版在 history / conflicts（预期） | 1.000 |
| 旧版作为当前 / 跨空间泄漏 / 别处主题 / 超限 | 0 / 0 / 0 / 0 |

**回答**

| 指标 | 值 |
| --- | --- |
| answers.llm（总体） | 0.935（29 / 31） |
| answers.llm 按题型 | conflict 1.000 · cross-project 0.900 · plain 0.923 · stale 1.000 |
| answers.rubric（总体） | 0.935 |
| Token F1（总体） | 0.526 |
| Token F1 按题型 | conflict 0.586 · cross-project 0.545 · plain 0.518 · stale 0.472 |
| 接口检查 api.passRate | 1.000（oracle 记通过，不代表产品） |

开销见文首总表。上面写入和检索全是 1，因为最终状态就是金标，总表不把它们当成产品 add 或流水线检索。

**备注**：

- 两道错题：q03、q24。q03 问测试怎么写，阅读模型答「记忆中没有相关内容」；渲染里已有「没有客户名时这笔不进月报」。q24 的回答已经说出价格查询太慢、price 表改为直接读 amount 列，评委把 price 表说成另一个需求，判错。
- q25 在这次通过。R-20261110-02 里它被判错。换阅读模型后仍不是 1。
- 重复率与错误合并率在这份金标上是 0。这只说明评分器能算出这两项。

### R-20261110-02

**元数据**

| 项 | 值 |
| --- | --- |
| 被测实现 | 不是产品。金标在每个 `askedAt` 的 `topic_detail_list` 经 `harness/run-reader-ceiling.mjs` 交给阅读模型。代码 `6d3c22e3`，工作区干净 |
| 目的 | 测 v2.1 上这套评测对该阅读模型和评委的上限 |
| 回放脚本 | `harness/run-reader-ceiling.mjs`，评分用 `run-pipeline-eval.mjs`，不加 `--gate`。原始输出在 `eval/project-memory/runs/2026-11-10T13-47-50-146Z/`（不进 git） |
| 评测配置 | 不起服务。阅读与评委都走 OpenAI 兼容的 chat completions，温度 0 |
| 数据集 | v2.1：113 轮、50 个主题、78 条必写 + 12 条可选、25 条负例、31 题、4 项接口检查（接口检查按 oracle 记通过） |
| 提示词版本 | 阅读模型提示词 v1，评委提示词 v4。产品提示词未参与：extract `pm-extract-v0.2.2`，assign `pm-assign-v0.2.0`，judge `pm-judge-v0.3.0`，inject `pm-inject-v0.1.0` |
| 被测模型 | 不适用（金标，无模型） |
| 评委 / 阅读模型 | claude-haiku-4-5-20251001 / claude-haiku-4-5-20251001。网关模型列表里没有 claude-haiku-5-5（调用返回 503、`model_not_found`）。两者同家族，被测无模型，不触发家族检查 |
| `memory_limit_number` | 9 |

**写入质量（add）**

| 指标 | 值 |
| --- | --- |
| entries.f1（P / R） | 1.000（1.000 / 1.000） |
| decision / experience / timeline F1 | 1.000 / 1.000 / 1.000 |
| kind 正确率 | 1.000 |
| decisions.stateExact；content / conflicts / history / userIds / time | 1.000；1.000 / 1.000 / 1.000 / 1.000 / 1.000 |
| decisions.reasons | 1.000 |
| topics.bcubed P / R / F1 | 1.000 / 1.000 / 1.000（50 个主题对金标 50 个） |
| topics.domain / keyPoints | 1.000 / 1.000 |
| 误写率；旧版当当前 / 不一致成条 / 无法归属 / 重复 / 超长；原因臆造；重复主题 / 错误合并 | 0；0 / 0 / 0 / 0 / 0；0；0 / 0 |

**检索（search）**

| 指标 | 值 |
| --- | --- |
| topic Recall@1 / @3 / @9 | 1.000 / 1.000 / 1.000 |
| entryHit / itemHit | 1.000 / 1.000 |
| 旧版在 history / conflicts（预期） | 1.000 |
| 旧版作为当前 / 跨空间泄漏 / 别处主题 / 超限 | 0 / 0 / 0 / 0 |

**回答**

| 指标 | 值 |
| --- | --- |
| answers.llm（总体） | 0.903（28 / 31） |
| answers.llm 按题型 | conflict 1.000 · cross-project 0.800 · plain 0.923 · stale 1.000 |
| answers.rubric（总体） | 0.903 |
| Token F1（总体） | 0.510 |
| Token F1 按题型 | conflict 0.572 · cross-project 0.527 · plain 0.514 · stale 0.429 |
| 接口检查 api.passRate | 1.000（oracle 记通过，不代表产品） |

开销见文首总表。上面写入和检索全是 1，因为最终状态就是金标，总表不把它们当成产品 add 或流水线检索。

**备注**：

- 三道错题：q03、q24、q25。q03 问「空客户的测试现在是怎么写的」，渲染里已有「没有客户名时这笔不进月报」，阅读模型答测试代码不在记忆里。q24 的回答已经说出价格查询太慢、改为直接读 amount 列，评委仍判错。q25 的渲染里决策仍有两项结论，同时进展写着 amount 列已加上；阅读模型只说已经改完，没写尚未裁决。
- q01、q17 在这次通过。这次上限是 0.903。后来的 R-20261110-04 把阅读提示词升到 v2，answers.llm 才到 1。
- 重复率与错误合并率在这份金标上是 0。这只说明评分器能算出这两项，不是产品回放的结果。

### R-20261110-01

**元数据**

| 项 | 值 |
| --- | --- |
| 被测实现 | 数字测于 `127cca7e` 之上的工作区，脚本在 `b5cb5822` 入库。进程内调用，不起 HTTP。脚本 `eval/project-memory/latency/run-search-latency.ts` |
| 调用 | 临时 sqlite。金标主题经 `ProjectMemoryStore.commitChangeSet` 写入，金标 id 映射到 `bench_<金标 id>`。不读 `~/.memmy`。无聊天模型。`MEMMY_DECISION_TOPIC=0`。embedder 是 stub 哈希向量 `local:pm23-hash-v1`。服务日志仍打印配置里的 `Xenova/all-MiniLM-L6-v2`，那是默认配置名，这次检索没有用它 |
| 数据集 | v2.1：50 个主题，31 道计分题（每题 1 个期望主题）。门槛用 fixture S。L 把被问到的空间补到 500 个主题，只作参照 |
| 提示词版本 | 不适用（本次只测检索延迟） |
| 被测模型 | 不适用（没有聊天模型） |
| 评委 / 阅读模型 | not-run（阅读模型网关 2026-11-10 返回 503，不沿用旧数） |
| `memory_limit_number` | 9。第 1、2 路 `recallCandidates` 的 limit 是 18，与总路径里 `memoryLimit * 2` 相同 |

本阶段不测写入，也不测回答。流水线 Recall 未跑。数字在文首总表的 R-20261110-01-search 行。

分位用 `eval/project-memory/gold-add-memory/metrics.mjs` 的 `percentile`：按 `(n - 1)` 线性插值，参数是 0–100。这不是 nearest-rank。下面的毫秒数是脚本打出来的三位小数。先丢掉 3 轮，再测 20 轮，样本是每道计分题一次调用，n=620。超时指样本耗时达到 `recallPathTimeoutMs`（1200 ms）；这次没有改这个值。金标灌库 Recall@1/3/9 为 0.581 / 0.968 / 0.968，不是流水线分。

S + stub 的延迟（门槛只用这一列）：

| 段 | P50 | P95 | max | n | 超时 | degraded |
| --- | --- | --- | --- | --- | --- | --- |
| 第 3 路 `rankProjectCandidates` | 0.579 ms | 0.741 ms | 3.117 ms | 620 | 0 | 0 |
| 第 1 路 `recallCandidates`（空库，仅链路开销） | 0.025 ms | 0.032 ms | 2.577 ms | 620 | 0 | 0 |
| 第 2 路 `recallCandidates`（空库，仅链路开销） | 0.526 ms | 0.666 ms | 3.271 ms | 620 | 0 | 0 |
| 总 `search/memory` | 1.194 ms | 1.462 ms | 5.796 ms | 620 | 0 | 0 |
| 渲染 `renderTurnMemories` | 0.005 ms | 0.008 ms | 0.018 ms | 620 | 0 | 0 |

第 1、2 路没有返回候选，`lane_empty` 为 true。门槛：第 3 路 P95 ≤ 800 ms，总 P95 ≤ 1.2 s，渲染 P95 ≤ 5 ms，超时 0。这次通过。

计时循环 1765.296 ms，含丢掉的 3 轮预热和 20 轮测量。620 次样本，0 次聊天模型。HTTP P95 未跑。开销见文首总表。

**备注**

- 原始 JSON 在 `eval/project-memory/runs/pm23-search-latency-S-stub.json`（该目录被 gitignore，不提交）。
- L + stub 只作参照，不参与门槛：500 个主题，第 3 路 P95 1.599 ms，总 P95 2.922 ms，渲染 P95 0.010 ms，超时 0，degraded 0。金标灌库 Recall@1/3/9 为 0.194 / 0.968 / 1.000。JSON 为 `pm23-search-latency-L-stub.json`。
- 两种存储的 Recall 差仍是 PM-24，这次没有测。

### R-20261106-01

**元数据**

| 项 | 值 |
| --- | --- |
| 被测实现 | `gpt-6-luna` 主题选择题。脚本 `eval/project-memory/jev-topic/run-jev-topic-eval.ts`，决策文案 `openai-chat-choice-1`。不启动记忆服务，不打开 `MEMMY_DECISION_TOPIC`。工作区相对 `25ff3fff` 有未提交的选题实验代码 |
| 调用 | 内部中转 `chat/completions`。`POST /v1/decisions` 在该网关返回 404，所以没有用 Decisions 专用接口。模型不接受 `temperature: 0`，请求里不传 temperature。网关探测时返回的模型名是 `gpt-6-luna-2026-09-22` |
| 数据集 | v2：34 条计入的 add（21 条归入已有主题、5 条新建、8 条无关；`t_informed` 没有主题标签，跳过），23 道 search |
| 提示词版本 | `openai-chat-choice-1`（不是产品 `organize` 提示词） |
| 被测模型 | gpt-6-luna |
| 评委 / 阅读模型 | 不适用（没有生成回答，选题对错按金标 id 直接比对） |
| `memory_limit_number` | 不适用（不调用 search/memory） |

这次不测 entries.f1。测的是主题归属：0.882（30/34）。已有主题 1.000（21/21），新建 0.600（3/5），无关 0.750（6/8）。词法对照 0.588（已有 0.810，新建 0.600，无关 0）。数字在文首「只测写入」。

**检索（search）**

候选只有该空间在提问时已经存在的金标主题，卡片是名称、摘要和描述，不含条目正文。Recall@1（选中）看模型返回的 `choice` 是不是金标主题。按概率排序的 Recall 把 `new` / `none` 除外，只排主题 id。

| 指标 | 值 |
| --- | --- |
| topic Recall@1 / @3 / @9（选中 / 按概率） | 选中只有 @1：0.826（19/23）。按概率 0.957 / 1.000 / 1.000 |
| 词法对照 topic Recall@1 / @3 / @9 | 0.522 / 1.000 / 1.000 |
| 选中 Recall@1 按题型 | conflict 1.000（3）· cross-project 0.800（10）· plain 0.600（5）· stale 1.000（5） |

这次不生成回答，也没有 entryHit。选题 Recall 在文首「只测检索或只测回答」。

**效率**

57 次调用合在一起计时，没有拆成 add 和 search 两段。

| 指标 | add | search |
| --- | --- | --- |
| wallclock | 157.2 s（34 次 add + 23 次 search 合计） | 同左 |
| 请求数 / LLM 调用数 | 34 / 34 | 23 / 23 |
| 平均输入 / 输出 token | 合计 25349 / 5639，未按阶段拆开。57 次平均约 445 / 99 | 同左 |
| 平均费用 / 总费用（USD） | null / null（`pricing.json` 无 gpt-6-luna 单价） | 同左 |
| 请求延迟 P50 / P95 | 2262 / 7425 ms（57 次合计） | 同左 |

**备注**

- 和 R-20261105-02 的产品 search Recall@1 0.783、@3 0.913 不是同一件事。那次是记忆服务自己的召回；这次是在金标主题卡上做选择题。
- 同一批卡片上，gpt-6-luna 的选中 Recall@1 0.826，词法是 0.522。按概率排序时有 22/23 题的正确主题排第一，其中 3 题模型最终选了 `none` 或 `new`，所以选中率低于概率排序。
- add 上已有主题 21/21 都归对。新建和无关仍会错。
- 产品开关 `MEMMY_DECISION_TOPIC` 保持关闭。

### R-20261105-04

**元数据**

| 项 | 值 |
| --- | --- |
| 被测实现 | 旧实现：`git archive 44dcbb1e^`（= `9aabf84b`，v0.1 之前的 `memories` 表 work_memory 实现），解到 `/tmp/pm-eval/legacy`；回放脚本在当前分支 `aa80a687`，工作区含未提交的 `harness/run-control-legacy.mjs`、`harness/run-reader-ceiling.mjs` |
| 回放脚本 | `harness/run-control-legacy.mjs`：每轮一次 `/api/v1/memory/add`（user + 回复，不带 source_trace_id），按 `askedAt` 用 `/api/v1/memory/search`（`include_memory_view: ["project"]`，`generate_answer: false`）；回答由固定阅读模型读模板三渲染；用量经 `harness/usage-proxy.mjs`，评分加 `--sut-usage` |
| 评测配置 | `harness/eval-config.yaml`；被测模型走 `MEMMY_SUMMARY_*` / `MEMMY_EVOLUTION_*` 指向用量代理；新库 |
| 数据集 | v2：35 轮、5 主题、23 必写 + 12 可选条目、10 条负例、23 题、4 项接口检查 |
| 提示词版本 | 旧实现的抽取与答案提示词（未带版本号）；本次不用它的答案提示词 |
| 被测模型 | deepseek-v4.1-flash-1017 |
| 评委 / 阅读模型 | claude-haiku-5-5 / claude-haiku-5-5 |
| `memory_limit_number` | 9（问答）；最终状态探测用 25（旧接口上限） |

**与 v0.1 不可比之处（必须与数字一起读）**

- 旧实现没有 history、conflicts，没有 `get_memory`。最终状态取自所有题目和 7 条探测查询返回主题的并集，写入类指标是**下界**。
- 旧接口没有空间隔离检查、领域登记检查，`api.passRate` 按构造为 0，不可比。
- 旧实现的 add 是同步的（请求延迟含模型调用），没有任务轮询。
- 旧实现的 `evolution` 类条目在转换时映射为 `timeline`。

**写入质量（add）**

| 指标 | 值 |
| --- | --- |
| entries.f1（P / R） | 0.294（0.455 / 0.217） |
| decision P / R / F1 | 0.333 / 0.200 / 0.250 |
| experience P / R / F1 | 0.000 / 0.000 / 0.000 |
| timeline P / R / F1 | 0.000 / 0.000 / 0.000 |
| kind 正确率 | 0.130 |
| decisions.stateExact；content / conflicts / history / userIds / time | 0.000；0.200 / 0.133 / 0.067 / 0.000 / 0.200 |
| decisions.reasons | 0.000 |
| topics.bcubed P / R / F1；实际 / 金标主题数 | 0.258 / 0.084 / 0.127；6 / 5 |
| topics.domain / keyPoints | 0.800 / 0.214 |
| 误写率；旧版当当前 / 不一致成条 / 无法归属 / 重复 / 超长；原因臆造；重复主题 / 错误合并 | 0.100；3 / 2 / 0 / 0 / 2；0；1 / 0 |

**检索（search）**

| 指标 | 值 |
| --- | --- |
| topic Recall@1 / @3 / @9 | 0.261 / 0.391 / 0.391 |
| entryHit / itemHit | 0.826 / 0.846 |
| 旧版在 history / conflicts（预期） | 0.000（旧实现没有这两个字段） |
| 旧版作为当前 / 跨空间泄漏 / 别处主题 / 超限 | 6 / 0 / 0 / 0 |

**回答**

| 指标 | 值 |
| --- | --- |
| answers.llm（总体） | 0.565（13 / 23） |
| answers.llm 按题型 | conflict 1.000 · cross-project 0.800 · plain 0.400 · stale 0.000 |
| answers.rubric（总体） | 0.739 |
| Token F1（总体） | 0.434 |
| Token F1 按题型 | conflict 0.542 · cross-project 0.515 · plain 0.296 · stale 0.346 |
| 接口检查 api.passRate | 0.000（旧实现无这些接口，按构造） |

**效率**

| 指标 | add | search |
| --- | --- | --- |
| wallclock（整轮 150.3 s） | 55.2 s | 0.06 s |
| 请求数（不含 get/status 轮询） | 35（无轮询，同步） | 23 |
| 被测系统 LLM 调用数 | 35（失败 0） | 0 |
| 平均输入 / 输出 token | 779（含缓存命中 22272 合计）/ 118 | 不适用 |
| 任务「受理 → 完成」 | 不适用（同步 add） | — |
| 平均费用 / 总费用（USD） | null / null（`pricing.json` 无 deepseek 单价） | 0 / 0 |
| 请求延迟 P50 / P95 | 1493 / 2371 ms（含模型调用） | 2.2 / 4.7 ms |
| 被测系统单次模型延迟 P50 / P95 | 1488 / 2359 ms | — |
| 评委开销（不计入产品） | 65 次调用，$0.0103 | |
| 阅读模型开销（不计入产品） | 22 次调用 + 1 次缓存，$0.0061 | |

**备注**：

- 同口径下 v0.1（R-02）对旧实现：answers.llm 0.609 对 0.565，rubric 0.739 对 0.739，Token F1 0.441 对 0.434，回答层面几乎持平；写入与检索差距大：entries.f1 0.667 对 0.294，topic Recall@3 0.913 对 0.391，旧版当当前（检索）2 对 6，条目误成 conflict 条目 1 对 2。
- 旧实现 conflict 类题 1.000 而 stale 类 0.000，原因是它没有 history 和 conflicts：两条互相矛盾的说法平铺为并列决策，阅读模型按模板把它们当「不一致」列出，在 conflict 题上碰巧对，在 stale 题上把旧说法当并列选项，判「尚未确定」。
- 所以 v1 报告里的 0.967 到 v2 上同一实现的 0.565，是评测口径变化的直接证据：同一个旧实现，换成 v2 口径后少了 40 个百分点。v0.1 的 0.609 没有退步，只是回答层被阅读模型保守性、oracle 摘要未来信息（E-02）和少量实现缺口（G-01 等）压着。
- 本次是单次运行，旧实现与被测模型都有随机性。

### R-20261105-03

**元数据**

| 项 | 值 |
| --- | --- |
| 被测实现 | 不是产品：金标（`oracle.mjs`）在每个 `askedAt` 的 `topic_detail_list` 经 `harness/run-reader-ceiling.mjs` 交给固定阅读模型；基于 `aa80a687`，工作区含未提交的 `harness/run-reader-ceiling.mjs`、`harness/run-control-legacy.mjs` |
| 目的 | 测这套评测对该阅读模型和评委的上限，把评测自身造成的失分和实现造成的失分分开 |
| 回放脚本 | `harness/run-reader-ceiling.mjs`（评分用 `run-pipeline-eval.mjs`，不加 `--gate`） |
| 评测配置 | 不起服务；无被测模型调用 |
| 数据集 | v2：35 轮、5 主题、23 必写 + 12 可选条目、10 条负例、23 题、4 项接口检查（接口检查按 oracle 记通过） |
| 提示词版本 | 阅读模型提示词 v1，评委提示词 v4 |
| 被测模型 | 不适用（金标，无模型） |
| 评委 / 阅读模型 | claude-haiku-5-5 / claude-haiku-5-5（评委与阅读同一模型，被测无模型，不触发家族检查） |
| `memory_limit_number` | 9 |

**写入质量（add）**

| 指标 | 值 |
| --- | --- |
| entries.f1（P / R） | 1.000（1.000 / 1.000） |
| decision / experience / timeline F1 | 1.000 / 1.000 / 1.000 |
| kind 正确率 | 1.000 |
| decisions.stateExact；content / conflicts / history / userIds / time | 1.000；1.000 / 1.000 / 1.000 / 1.000 / 1.000 |
| decisions.reasons | 1.000 |
| topics.bcubed P / R / F1 | 1.000 / 1.000 / 1.000（5 个主题对金标 5 个） |
| topics.domain / keyPoints | 1.000 / 1.000 |
| 误写率；旧版当当前 / 不一致成条 / 无法归属 / 重复 / 超长；原因臆造；重复主题 / 错误合并 | 0；0 / 0 / 0 / 0 / 0；0；0 / 0 |

**检索（search）**

| 指标 | 值 |
| --- | --- |
| topic Recall@1 / @3 / @9 | 1.000 / 1.000 / 1.000 |
| entryHit / itemHit | 1.000 / 1.000 |
| 旧版在 history / conflicts（预期） | 1.000 |
| 旧版作为当前 / 跨空间泄漏 / 别处主题 / 超限 | 0 / 0 / 0 / 0 |

**回答**

| 指标 | 值 |
| --- | --- |
| answers.llm（总体） | 0.826（19 / 23） |
| answers.llm 按题型 | conflict 1.000 · cross-project 0.900 · plain 0.600 · stale 0.800 |
| answers.rubric（总体） | 0.957 |
| Token F1（总体） | 0.526 |
| Token F1 按题型 | conflict 0.618 · cross-project 0.601 · plain 0.384 · stale 0.463 |
| 接口检查 api.passRate | 1.000（oracle 记通过，不代表产品） |

开销见文首总表。上面写入和检索全是 1，因为最终状态就是金标。

**备注**：

- 金标是完美记忆，但 answers.llm 只有 0.826。4 道错题：q01、q03、q14、q17。q01、q03 的原因是 oracle 的主题摘要和描述取最终状态、不随提问时刻变化（q01 在 14:00 提问，摘要却写着「月报按 amount 列汇总」；q03 在 12:00 提问，摘要写着「空客户的处理尚有不一致结论」），即登记在 gaps-v01.md 的 E-02。q17 的标准答案是「已修好」，但金标状态里 `dec_empty` 的 conflict 未解决，阅读模型按模板回答「尚未确定」（E-03）。q14 是阅读模型在给出当前决策后又加了一句无法确认，评委判错（E-04）。
- 这是上限的下界估计：修好 E-02 后上限会上升。真实被测系统的摘要来自自己的写入，不受 E-02 影响。
- v0.1（R-02）的 0.609 对这个上限 0.826：差 5 题。同一次回放里这 5 题的错因，见 gaps-v01.md 的 G-01、G-04、G-06、G-08。

### R-20261105-02

**元数据**

| 项 | 值 |
| --- | --- |
| 被测实现 | `dev-project-memory-add-search-dev` @ `672919d5`（产品代码含 `59547700` 的 5 项 MUST 修复；工作区干净） |
| 回放脚本 | `run-memmy-live-eval.mjs`（runnerRevision 2，记录分阶段与任务耗时）；用量经 `harness/usage-proxy.mjs`，评分加 `--sut-usage` |
| 评测配置 | `harness/eval-config.yaml`：token 限流关闭、检索 LLM 过滤关闭、不扫描本机 Agent 会话 |
| 数据集 | v2：35 轮、5 主题、23 必写 + 12 可选条目、10 条负例、23 题、4 项接口检查 |
| 提示词版本 | `project-memory/prompts/organize.ts`（与 R-20261105-01 相同） |
| 被测模型 | deepseek-v4.1-flash-1017（网关返回 `deepseek-v4-1-flash-261017`） |
| 评委 / 阅读模型 | claude-haiku-5-5 |
| `memory_limit_number` | 9 |

**写入质量（add）**

| 指标 | 值 |
| --- | --- |
| entries.f1（P / R） | 0.667（0.737 / 0.609） |
| decision P / R / F1 | 0.765 / 0.867 / 0.813 |
| experience P / R / F1 | 0.000 / 0.000 / 0.000（只有 1 条必写经验） |
| timeline P / R / F1 | 1.000 / 0.143 / 0.250 |
| kind 正确率 | 0.609 |
| decisions.content / conflicts / history / userIds / time | 0.867 / 0.800 / 0.867 / 0.800 / 0.867 |
| decisions.stateExact | 0.800 |
| decisions.reasons | 0.500 |
| topics.bcubed P / R / F1 | 0.515 / 0.438 / 0.473 |
| topics.domain | 0.800 |
| topics.keyPoints | 0.429 |
| 不该写入的误写率 | 0.100 |
| 旧版当当前 / 不一致结论单独成条 / 无法归属 / 重复 / 超长 | 3 / 1 / 0 / 0 / 0 |
| 原因臆造 | 1 |
| 重复主题 / 错误合并 | 0 / 1 |

**检索（search）**

| 指标 | 值 |
| --- | --- |
| topic Recall@1 / @3 / @9 | 0.783 / 0.913 / 0.913 |
| entryHit / itemHit | 0.522 / 0.538 |
| 旧版在 history / conflicts（预期） | 0.167 |
| 旧版作为当前内容出现 | 2 |
| 跨空间泄漏 / 别处主题 / 超过 9 个主题 | 0 / 0 / 0 |

**回答**

| 指标 | 值 |
| --- | --- |
| answers.llm（总体） | 0.609 |
| answers.llm 按题型 | conflict 0.333（3）· cross-project 0.900（10）· plain 0.400（5）· stale 0.400（5） |
| answers.rubric（总体） | 0.739 |
| Token F1（总体） | 0.441 |
| Token F1 按题型 | conflict 0.437 · cross-project 0.553 · plain 0.386 · stale 0.272 |
| 接口检查 api.passRate | 1.000（新规则：要求 40001 / DOMAIN_INVALID，隔离检查带正对照） |

**效率**

| 指标 | add | search |
| --- | --- | --- |
| wallclock（整轮 148.2 s） | 85.6 s | 0.24 s |
| 请求数（不含 get/status 轮询） | 35（另有轮询 176 次） | 24 |
| 被测系统 LLM 调用数 | 35（失败 0） | 0（实测） |
| 平均输入 / 输出 token | 2093（含缓存 12416 合计）/ 192 | 不统计 / 不适用 |
| 平均费用 / 总费用（USD） | null / null（`pricing.json` 无 deepseek 单价） | 0 / 0 |
| 请求延迟 P50 / P95 | 2.2 ms / 3.3 ms（仅入队） | 7.6 ms / 27.8 ms |
| 任务「受理 → 完成」P50 / P95 / 平均 | 2413 / 3430 / 2444 ms（35 个，轮询误差均值 960 ms） | — |
| 被测系统单次模型延迟 P50 / P95 | 1830 / 2700 ms | — |
| 评委开销（不计入产品） | 50 次调用 + 19 次缓存，$0.0057 | |
| 阅读模型开销（不计入产品） | 23 次调用，$0.0029 | |

**备注**：

- 与 R-20261105-01 比：重复主题 4 → 0、topics.bcubed.f1 0.338 → 0.473、topic Recall@1 0.609 → 0.783；entries.f1 0.651 → 0.667；answers.llm 持平 0.609。两次都是单次运行，被测模型有随机性，差异不能全部归因于修复；R1-2 / R1-3 都会影响主题归类，但本数据集里没有跨 Space 复用消息和并发新建，主题变化更可能来自模型波动。
- 仍按 ADR-0005：`split`、复述过滤、推迟回填、三路召回未实现。

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

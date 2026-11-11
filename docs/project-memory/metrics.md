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
| [R-20261106-01](#r-20261106-01) | 2026-11-06 | super agent session 路由（工作区未提交，基线 `25ff3fff`） | v2 | 0.583 | 0.733 | 0.913 | 0.652 | 0.416 |
| [R-20261105-04](#r-20261105-04) | 2026-11-05 | 旧实现（`9aabf84b` 的 Memory 代码，即 `44dcbb1e^`）同口径对照 | v2 | 0.294 | 0.000 | 0.391 | 0.565 | 0.434 |
| [R-20261105-03](#r-20261105-03) | 2026-11-05 | 金标作被测系统（阅读模型上限，非产品） | v2 | 1.000 | 1.000 | 1.000 | 0.826 | 0.526 |
| [R-20261105-02](#r-20261105-02) | 2026-11-05 | v0.1 + 评审 MUST 修复（`672919d5`） | v2 | 0.667 | 0.800 | 0.913 | 0.609 | 0.441 |
| [R-20261105-01](#r-20261105-01) | 2026-11-05 | v0.1（本分支 `44dcbb1e`） | v2 | 0.651 | 0.800 | 0.913 | 0.609 | 0.431 |
| [R-20261104-02](#r-20261104-02) | 2026-11-04 | main 分支对照（无项目记忆） | v1 | 0.000 | 不适用 | 0.117 | 0.100 | 0.054 |
| [R-20261104-01](#r-20261104-01) | 2026-11-04 | 旧实现（Codex 版） | v1 | 0.237 | 不适用 | 0.700 | 0.967 | 0.400 |

**口径提醒**：v1（R-20261104-01/02）与 v2（R-20261105-xx 及之后）不可逐项对比。v1 的回答由被测系统自带的 `generate_answer` 生成，题目 30 道、没有 conflict 题，评委只看是否说出最新结论，金标按旧实现抽取的条目反推；v2 由固定阅读模型只读渲染后的 `topic_detail_list`，23 题含 3 道 conflict，金标按 v3 重推。同在 v1 报告里 rubric 准确率只有 0.367，v2 是 0.739。v2 的 answers.llm 上限（金标作被测系统，R-20261105-03）是 0.826，不是 1。旧实现在 v2 上的同口径结果是 0.565（R-20261105-04），v0.1 是 0.609，所以从 0.967 到 0.6 上下几乎全是口径变化，不是 v0.1 退步。拆解见 [gaps-v01.md](gaps-v01.md)。

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

**效率**

| 指标 | add | search |
| --- | --- | --- |
| wallclock | 不适用（不起服务） | 不适用（阅读模型 23 次调用约 70 s，不计入产品） |
| 请求数 / LLM 调用数 | 不适用 | 不适用 |
| 平均输入 / 输出 token | 不适用 | 不适用 |
| 任务「受理 → 完成」 | 不适用 | — |
| 平均费用 / 总费用（USD） | 不适用 | 不适用 |
| 延迟 P50 / P95 | 不适用 | 不适用 |
| 评委开销 / 阅读模型开销（不计入产品） | 评委 23 次调用左右（缓存命中部分不计），阅读模型 23 次调用；费用未单列 | |

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

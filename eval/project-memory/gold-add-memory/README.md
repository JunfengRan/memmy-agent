# 项目记忆评测数据集 v2（gold-add-memory）

评测项目记忆的写入（`add_message` → M02/M04/M05）和检索（`search_memory` → M09）。金标按 v3 §2.2.5–§2.2.9 的判定与合并规则重推，检索与返回结构按 v3 §3.2、§3.3.4。决定见 ADR-0004。

被测系统只通过规格接口调用；评测专用信息（轨迹 id、标注）不进任何请求。

### v2.1

要点是 `{text, since, until?}`，`since` / `until` 为轨迹 id。某要点在提问时有效，当且仅当 `since` 的 `submit_time ?? reply_time` 已不晚于 `askedAt`，且 `until` 还没有到。`oracle.mjs` 与阅读上限按这个时刻取要点；主题要点评分只用没有 `until` 的最终要点。

回放顺序用 `submit_time ?? chat_time`，可见性用 `submit_time ?? reply_time`。`resubmitOf` 原样重发原来的 add，且该轨迹没有 op。`deferredUntil` 到后一条轨迹才生效，条目时间仍是原来的 `chat_time`，来源含两条轨迹。`history_backfill` 按时间插入 history，不改当前版本。迟交且非作者的结论只做 `conflict_append`。

`--gate` 另有 `--max-duplicate-rate`（默认 0.02）和 `--max-wrong-merge-rate`（默认 0.01）；`topics.controlMerges` 与 `writes.lateAsCurrent` 必须为 0。对照组写在 `labels.controls` 的 `similar-name`（主题对）和 `same-work`（同一主题里的条目对）。

语料在 ledger、catalog 之外增加门诊、仓储、车队、厨房，共 50 个主题、7 名成员。新题从 q40 起。q17 的标准答案同时说明丢行原因和空客户仍有未决分歧。q24 的标准答案在 v2.1 内改过：事实取自 dec_price，只把原因放到句首。R-20261110-02 和 R-20261110-03 用的是改之前的答案。上面各表里的轮数和题数是 v2 的，v2.1 以 `node load-eval-set.mjs` 的输出为准。

换成大版本时，上一版整份冻在 `history/<版本>/`。v2 在 `history/v2/`。评分只读 `dataset/`。小改动不另存副本。

## 快速开始

```bash
cd eval/project-memory/gold-add-memory
node load-eval-set.mjs                 # 校验数据集，errors 必须为 []
node run-pipeline-eval.mjs --oracle    # 金标自身作答：每项得分 1、每项错误 0
node run-pipeline-eval.mjs --empty     # 什么都不写、不答：每项得分 0
node selftest.mjs                      # 评分与接口检查的自测（不需要服务、评委、阅读模型）
```

改了 `dataset/` 下的任何输入，先重建金标再校验：

```bash
node build-gold-baseline.mjs           # 写 dataset/gold.json（随数据集提交）
node load-eval-set.mjs
```

## 对着服务跑

服务需要提供 `http://127.0.0.1:18960/api/openmem/v1/` 下的 `create/space`、`create/domains`、`list/domains`、`add/message`、`get/status`、`search/memory`、`get/memory`。

```bash
# 0. （可选）记录被测系统的模型用量：把服务的 MEMMY_SUMMARY_ENDPOINT / MEMMY_EVOLUTION_ENDPOINT 指向代理
node harness/usage-proxy.mjs --upstream <模型网关>/v1 --port 18970 --out /tmp/pm-eval/sut-usage.jsonl

# 1. 回放：建空间与领域 → 每轮 add_message 并轮询 get/status → 按 askedAt 提问 → 读最终状态 → 接口检查
export MEMMY_EVAL_BASE=http://127.0.0.1:18960/api/openmem/v1
export MEMMY_EVAL_MODE=local                 # X-MemOS-Mode
export MEMMY_EVAL_SUT_MODEL=<服务端 M02/M04/M05 用的模型>
export MEMMY_EVAL_READER_PROVIDER=anthropic  # 或 openai（兼容 chat completions）
export MEMMY_EVAL_READER_MODEL=<固定的阅读模型>
export MEMMY_EVAL_READER_BASE_URL=... MEMMY_EVAL_READER_API_KEY=...
node run-memmy-live-eval.mjs                 # 写 ../runs/<stamp>/live-run.json

# 2. 评分：评委必须显式配置，且与被测模型不同家族
export MEMMY_EVAL_JUDGE_PROVIDER=openai MEMMY_EVAL_JUDGE_MODEL=<非被测家族的模型>
export MEMMY_EVAL_JUDGE_BASE_URL=... MEMMY_EVAL_JUDGE_API_KEY=...
node run-pipeline-eval.mjs ../runs/<stamp>/live-run.json --gate \
  --sut-usage /tmp/pm-eval/sut-usage.jsonl     # 可选，也可用 MEMMY_EVAL_SUT_USAGE；写同目录 report.json

# 3. 报告（可选）
node build-report.mjs ../runs/<stamp>/report.json [--template <explainer.html>]   # 写 ../runs/report.html

# 只重跑接口检查（不需要阅读模型），复用一次回放的空间与 run tag
node run-memmy-live-eval.mjs --api-checks-only ../runs/<stamp>/live-run.json   # 写 ../runs/<新 stamp>/api-checks.json，未全过退出 1
```

- `create/space` 只传 `space_name`（`<数据集 space_id>_<MEMMY_EVAL_RUN_TAG>`），`space_id` 由 MemOS 生成，回放从响应的 `data.space_id` 读出并用于之后所有调用，记在 `live-run.json` 的 `spaceMap`。`conversation_id` 加 `MEMMY_EVAL_RUN_TAG` 后缀（默认是时间戳）。建好后先读一次，空间不为空就停止。
- 回放遇到 HTTP 错误、`code ≠ 0` 或任务 `failed` 立即停止，把已有结果写到 `live-run.partial.json`，退出码 1。
- 每个请求记 `{call, phase, poll, at, ms, status, code}`，`phase` 为 setup / add / search / final / check，`poll` 标出 `get/status` 轮询；每段的耗时记在 `phaseMs`（阅读模型单独记 `reader`）。每个任务记 `acceptMs`（add/message 的请求延迟）、`completedMs`（add/message 返回 → 看到 completed 的那次轮询返回）、`polls` 与 `detectionSlackMs`（那次轮询前的等待，完成时刻最多早这么多）。轮询间隔从 200 ms 翻倍到 1 s 封顶。这些只在评测侧记录，不进产品请求与响应。
- **接口检查**（`api-checks.mjs`）只认正面证据，连接失败、404、500 都判不通过，每项单独捕获异常：
  - `search_requires_space_ids`、`add_requires_space_ids`：响应信封 `code === 40001`（INVALID_PARAMS）才通过；
  - `search_space_isolation`：同一题先在 `space_ledger` 问（正对照，必须返回 ≥ 1 个 ledger 主题），再在 `space_catalog` 问，返回的主题必须都属于 catalog、且不含 ledger 主题；正对照为空也判不通过；
  - `add_unregistered_domain`：同步返回 `40002` / `DOMAIN_INVALID`，或任务 `failed` 且错误为 `DOMAIN_INVALID`，并且 ledger 主题数不变。
- 每轮的 `chat_time` 按 `YYYY-MM-DD HH:mm:ss` 发送，带 `X-MemOS-TZ: +08:00`。
- 带 `searchBefore` 的轨迹（`t_informed`）先在同一会话检索一次，再写入，用来满足「已告知」。
- 回答不由被测系统生成。`search_memory` 返回的 `topic_detail_list` 按模板三（§3.3.4）渲染后，交给固定的阅读模型作答。阅读模型只看渲染结果。
- `harness/run-control-main.mjs` 是对照组：main 分支没有项目记忆，用通用 `/api/v1` 记忆写入与检索，命中片段包成伪主题，用同一个阅读模型作答、同一个评分脚本打分。写入和决策类得分按定义为 0，只有检索与回答可比；`harness/eval-config.yaml` 是对照组的服务配置。

生成物（回放、报告、评委与阅读缓存）都写在 `eval/project-memory/runs/`，已被忽略；只把指标摘要写进 `docs/project-memory/metrics.md`。

## 数据集

| 文件 | 内容 |
| --- | --- |
| `dataset/corpus.json` | 2 个 Space（`space_ledger`：代码开发、工程规范；`space_catalog`：代码开发、产品设计），3 名成员，5 个会话（3 个写入会话、2 个只提问的会话），35 轮对话，每轮带 `chat_time`、`reply_time`（+2 分钟）、调用方指定的 `domain`。`annotations`（认可、已告知、裁决信号）只供金标校验，不发给被测系统 |
| `dataset/labels.json` | 5 个主题（领域、名称、摘要与描述要点）；条目元数据（kind、决策类别、optional）；每轮的 M05 动作（`add` / `rewrite` / `update` / `conflict_append` / `conflict_update` / `resolve`），或不写入的原因 |
| `dataset/conflicts.json` | 10 个分歧场景：作者、现有结论作者、认可、已告知，以及据此推出的动作 |
| `dataset/questions.json` | 24 道题（1 道 excluded）与 4 项接口检查 |
| `dataset/gold.json` | 由 `build-gold-baseline.mjs` 推出：最终条目（content、time、user_ids、conflicts、history）、不该写入的内容、每轮结果、每题提问时刻的期望条目与陷阱 |
| `report.html` | 给新同事和负责人读的介绍页。这一页仍是数据集 v2（35 轮、五条时间线），v2.1 入库时没有重写 |

### 标注规则

- **决策**只记范围、对外约定、共同约定三类（§2.2.5）。局部实现、执行步骤、未采纳、未决、重复、过程材料、无关内容不写入，每轮注明原因。
- **输出约定算决策**：月报路径、导出格式都是决策；「不把 catalog 的 export 搬进 ledger」是范围决策（`dec_copy`）。
- **进展**的 kind 名为 `timeline`，只记产出状态变化。较早的进展不是过时内容，不当陷阱。部分进展标 `optional`，写不写都对。
- **作者**：`user_ids` 记交办或采纳的成员（不记 Agent），`time` 取用户消息的 `chat_time`，允许落在回复之前的 2 分钟窗口内。
- **原因**只取自会话，每个非空 `reason` 都附 `reasonQuote`（会话原文），会话没说就留 `null`。
- **分歧**（§2.2.9，规格不设成员权限）：
  - 作者已在 content 中，或会话体现认可 → `rewrite`，旧结论进 history；
  - 作者在某一项 conflicts 中 → `conflict_update`；
  - 都不是 → `conflict_append`；
  - 已告知后成员裁决 → `resolve`，清空 conflicts 并写 history。
- **主题**：月报计算与空客户处理合为一个主题；回复格式偏好不算项目记忆（标为 `unrelated`）。

### 与 v1 相比

| 变化 | 说明 |
| --- | --- |
| 删除 | 顶层 `dataset/`、`workspaces/`、`load-eval-set.mjs`、`build-sessions.mjs`；`gold-add-memory/source/`、`workspaces/`、`build-sessions.mjs`、`generated/`；`decisions/relay/scheme/scoring/todolists.json`；当时入库的旧介绍页 `report.html` |
| 删题 | q08（执行步骤不写入，无记忆可答）、q10–q12、q18、q20、q22 |
| scope-leak | 改为接口检查：不带 `space_ids` 检索必须被拒；`space_ids=[catalog]` 检索 ledger 的题目，返回的 ledger 主题必须为 0 |
| 改题 | q17 改为 plain；q21 保持 excluded，不提问也不计分；q01–q04、q13、q15、q19 的标准答案按新金标重写；新增 q31（裁决后的当前状态） |
| 语料 | 新增 `t_informed`、`t_resolve`；`t_wait` 改为体现认可的说法 |

介绍页已按这一版重写为同目录的 `report.html`。带分数的报告仍由 `build-report.mjs` 写到 `../runs/report.html`，两份不要混用。

## 校验（`load-eval-set.mjs`）

- **语料**：
  - 成员与会话完整；ledger-build 与 ledger-follow 是不同成员；
  - 领域已在所属空间登记；时间为 ISO 8601 且带 `+08:00`，同一会话内按时间递增；
  - 文本里不出现标注词。
- **标注**：
  - kind ∈ decision / experience / timeline；决策类别只有三类；
  - 条目只写进本空间、本次请求领域的主题；
  - 字段长度：`topic_name` 20、摘要 80、描述 400、决策与进展 100、经验 200；
  - 非空原因必须附会话原文；不写入的轮次必须有原因。
- **分歧**：
  - 从作者、现有结论作者和会话信号推出动作，与 `conflicts.json` 和 `labels.json` 三方一致；
  - 每个非 `add` 的决策动作都有对应场景；
  - 「已告知」要求同一会话有 `searchBefore` 和 informed 信号。
- **金标**：`gold.json` 必须与重建结果逐字一致。
- **题目**：
  - 从本空间只提问的会话发问；只期望一个本空间主题；
  - 期望条目的证据早于 `askedAt`；
  - 题型与陷阱相符：stale 有旧版陷阱，cross-project 的陷阱来自另一空间，conflict 期望 conflicts，plain 无陷阱；
  - `mustInclude` 出现在标准答案中；题目不照抄回复。

## 指标（`run-pipeline-eval.mjs`）

**归属与匹配**：最终状态里的每条条目由评委归属为 match / stale / conflict / negative / none，文本完全一致时按规则判定。然后做一对一二分匹配，分四轮：必写条目先在 kind 相同的写入上匹配，再放开 kind；optional 条目同样两轮。已经和同 kind 写入配上的金标只能换到另一条同 kind 写入，所以 kind 不同的写入（比如带着决策原文的进展）抢不走正确的决策；候选内部再按「主 id 是否为该金标」和写入顺序排。匹配到 optional 的条目不计入分母。

| 得分（oracle = 1，empty = 0） | 定义 |
| --- | --- |
| `entries.{decision,experience,timeline}.{precision,recall,f1}` | 内容匹配且 kind 一致才算命中；另报总体 P/R/F1 与 `kindCorrect` |
| `decisions.content / conflicts / history / userIds / time / stateExact` | 逐条必写决策：内容匹配；conflicts 条数与内容一一对上且成员一致；history 一一对上；user_ids 一致（允许 `alternatives`）；time 在窗口内；以上全对才算 `stateExact` |
| `decisions.reasons` | 金标中有原因的 history 项，系统写出了有会话依据的原因 |
| `topics.bcubed.{precision,recall,f1}` | 扩展 B-cubed：未匹配的写入稀释精确率，未写出的金标召回为 0 |
| `topics.domain / keyPoints` | 每个金标主题的主对应主题领域正确；摘要与描述要点覆盖率 |
| `search.recall@{1,3,9}` | 期望主题出现在前 k 个返回主题中（按最终状态的主题对应关系） |
| `search.entryHit / itemHit` | 期望条目出现在正确的位置（content 为当前内容，conflicts 为不一致结论） |
| `search.staleTrapInHistory` | 旧版本出现在 history 或 conflicts 中（这是预期行为） |
| `answers.llm / rubric / tokenF1` | 评委判对错；`mustInclude` 全部出现；与标准答案的字词 F1 |
| `answers.llm.<题型>`、`answers.tokenF1.<题型>` | 按题型（conflict / cross-project / plain / stale）分别报评委分与 Token F1 |
| `api.passRate` | 4 项接口检查通过率 |

| 错误（oracle = 0） | 定义 |
| --- | --- |
| `notWritten.falseWriteRate` | 不该写入的内容被写入的比例 |
| `writes.staleAsCurrent / conflictAsEntry / unattributed / duplicate / fieldLimitViolations` | 旧版本当作当前条目、不一致结论单独成条、无法归属、重复写入、超长字段 |
| `decisions.reasonFabricated` | 没有会话依据的原因 |
| `topics.duplicateTopics / wrongMerges` | 一个金标主题被拆成多个；一个主题混入多个金标主题 |
| `search.staleShownAsCurrent` | 旧版本在检索结果中作为当前内容出现 |
| `search.crossProjectLeak / foreignTopics / overLimit` | 别的空间的内容或主题出现在结果中；返回主题超过 9 个 |

- **`--gate` 门槛**：`decisions.stateExact` ≥ 0.8、`topics.bcubed.f1` ≥ 0.8、`entries.f1` ≥ 0.8、`search.recall@3` ≥ 0.85、`answers.llm` ≥ 0.8、`api.passRate` = 1，且 `staleShownAsCurrent`、`crossProjectLeak`、`foreignTopics`、`reasonFabricated`、`wrongMerges` 为 0。可以用 `--min-*` 调整。
- **效率**（`report.efficiency`，覆盖 metrics.md「指标定义 … 效率」每一行，测不了的字段为 null，原因写在该块的 `reasons`）：

  | 字段 | add | search |
  | --- | --- | --- |
  | `wallclockMs` | `phaseMs.add`：每轮 add/message 到任务完成 | `phaseMs.search`：search/memory 请求（不含阅读模型，阅读模型见 `phaseWallclockMs.reader`） |
  | `requests` / `pollingRequests` | add/message 次数（不含 get/status 与接口检查）/ get/status 轮询次数 | search/memory 次数（不含接口检查） |
  | `llmCalls` / `failedLlmCalls` | `--sut-usage` 文件中本轮时间窗内的全部调用 | 0（v0.1 检索不调模型，全部调用归 add；`sutUsage.callsDuringSearchRequests` 核对检索请求期间是否有调用） |
  | `avgInputTokens`（含缓存命中）/ `avgOutputTokens` | 每次模型调用的平均 | 输入只统计 add；无调用时输出为 null |
  | `avgCostUsd` / `totalCostUsd` | 按 `pricing.json` 逐次计价（长上下文分档按单次判断）；平均按每个 add/message 请求；模型无单价为 null | 0 |
  | `latencyMs.{p50,p95}` | add/message 请求延迟（异步入队） | search/memory 请求延迟 |
  | `task.{p50,p95,mean}` | 任务受理 → 完成（上界，见 `detectionSlackMeanMs`） | — |
  | `llmLatencyMs.{p50,p95}` | 被测模型单次调用延迟 | — |

  没给 `--sut-usage` 时被测系统的调用数、token 与费用都为 null。旧回放（`runnerRevision` < 2，没有 `phase` 与任务计时）按路径分 add / search，接口检查的请求会算进去，分段 wallclock 与任务耗时为 null。评委（`efficiency.judge`）与阅读模型（`efficiency.reader`）的调用数、token、费用单独列，不计入产品。
- **评委**：只读显式环境变量，不回落到 `~/.memmy` 或服务配置；与 `MEMMY_EVAL_SUT_MODEL` 同家族时拒绝运行；温度 0；缓存键包含模型、提示词哈希和输入，提示词一改即失效。缓存在 `runs/judge-cache.json`，`--prune-judge-cache` 只保留本次用到的项。

## 规格含糊处

下面这些按注明的方式处理；以后规格明确了，再改标注并重建金标。

1. **`dec_env` 是 join 还是 rewrite 加合并**：林工先定「连接串写进 README」（t_write_secret），周工给出相反结论「.env 留在本机、说明里不放连接串」（t_admin_env，`conflict_append`）。之后林工自己改成与周工一致（t_env）。金标按作者 `rewrite`，再按不变式 1 把变得相同的那项 conflicts 合并进 content，user_ids 为林工、周工；`alternatives` 也接受不合并、保留 conflicts 的结果。合并掉的那项不进 history，规格没说要不要留痕。
2. **认可者是否进 user_ids**：t_wait 周工经林工认可改写。金标只记周工，`dec_copy` 的 `alternatives` 也接受「周工、林工」。
3. **决策时间**：取用户消息还是回复的 `chat_time`。金标取用户消息，评分接受两者之间的 2 分钟窗口。
4. **resolve 后的 user_ids**：林工裁决选周工的结论后，金标的 user_ids 只记周工，不加入裁决者。
5. **t_bug 用 `conflict_update` 还是 join**：周工更新的是自己那一项不一致结论，金标按 `conflict_update`。
6. **进展粒度**：改代码、改 README 这类变化算不算产出状态变化，规格没有给界线。这些条目标为 optional。
7. **`t_write_edit`、`t_admin_claim` 定为无关**：两轮讨论的是「什么算冲突」，对象是 Agent 自己怎么记修改，不是 ledger 的产出。也可以读成团队对协作方式的共同约定，规格没有给出界线。
8. **`memory_limit_number`**：§3.2.2 示例传 3，规则写默认 9。评测固定传 9。
9. **题目清单重叠**：任务里 q11、q12 同时出现在删除和改答案两处，按删除处理。
10. **q15 没有分歧**：`t_sample` 是假设加执行步骤，不构成一项结论。
11. **get_memory 分页**：规格没写 `size` 上限，回放按 50 翻页直到 `pages`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `build-gold-baseline.mjs` | 回放标注动作并校验分歧规则，写 `dataset/gold.json` |
| `load-eval-set.mjs` | v2 校验，同时导出 `LIMITS` 与 `loadGold()` |
| `run-memmy-live-eval.mjs` | 只走规格接口的回放；`--api-checks-only` 只重跑接口检查 |
| `api-checks.mjs` | 4 项接口检查（错误码与正对照） |
| `selftest.mjs` | 不依赖服务与模型的自测：kind 优先匹配、接口检查在拒连 / 404 / 500 / 空检索下不通过、效率字段 |
| `harness/run-reader-ceiling.mjs` | 阅读模型上限：把金标的 `topic_detail_list` 交给固定阅读模型，生成可评分的 run（记录见 metrics.md R-20261105-03） |
| `harness/run-control-legacy.mjs` | 旧实现（`44dcbb1e^`）的同口径对照：驱动它的 `/api/v1/memory/add`、`search`，同一阅读模型、同一评分。旧实现没有 history / conflicts、没有 get_memory，写入类得分是下界，`api.passRate` 按构造为 0 |
| `harness/run-legacy-eval.sh` | 一键跑旧实现对照：解出 `44dcbb1e^`、起用量代理和旧服务（配置复制到工作目录，服务回写不会弄脏仓库）、回放。需要环境变量 `SUT_ENV_FILE`（被测模型）、`JUDGE_ENV_FILE`（评委与阅读模型），密钥不进仓库 |
| `harness/usage-proxy.mjs` | 被测系统模型调用的用量记录代理（JSONL），评分时用 `--sut-usage` 读入 |
| `run-pipeline-eval.mjs` | 评分，以及 `--oracle` / `--empty` 自检和 `--gate` |
| `oracle.mjs` | 从金标生成规格形状的 `topic_detail_list` |
| `reader.mjs` | 模板三渲染与固定阅读模型 |
| `judge.mjs` | 评委提示词，完全一致时按规则判定 |
| `llm.mjs` | 显式配置、家族检查、温度 0、带提示词哈希的缓存 |
| `metrics.mjs` | 通用指标函数 |
| `report.html` | 数据集介绍页（空间、金标故事、题目、调用链） |
| `build-report.mjs` | 把一次评分结果渲染成 `../runs/report.html` |
| `pricing.json` | 被测系统、评委与阅读模型的费用估算（USD / 1M token） |
| `../jev-topic/` | Jev 主题归属的单独评测。不进主回放，产品开关默认关闭 |

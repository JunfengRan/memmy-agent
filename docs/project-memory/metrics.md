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

## 指标定义（与评测脚本一致）

**写入质量（add）**

- **Entry F1**：模型写入的条目与 gold 条目一对一匹配，要求 kind 相同且内容同一事实。不比较 topic 名和来源轨迹。同时报 kind 混淆矩阵、stale（写了旧版说法）条数、重复条数。
- **内容 F1**：与 Entry F1 相同，不看 kind。
- **Topic 归纳 B-cubed**：只对内容匹配上的条目，比较模型 topic 聚类与 gold topic；P 低说明不同事实被并进一个 topic，R 低说明同一工作被拆散。
- **来源轨迹覆盖率**：gold 轨迹里有多少被任一模型条目引用；只看覆盖率，不参与 F1。

**检索（search）**

- **Retrieval Recall@k**（k=1/3/5/10，另加"全部上下文"）：按排名取前 k 条返回条目所引用的轨迹，计算证据轨迹被带进上下文的比例，按题宏平均，并按题型分组。
- **trap rate**：上下文出现陷阱轨迹的题目比例。

**回答**

- **LLM score**：LLM 裁判对照题目、提问时间和标准答案判断回答对错，按题型和总体报。
- **Token F1**：回答与标准答案的词重合度（中文按字切）。
- **短语 rubric 准确率**：按 mustInclude / mustNotInclude 判，参考用。

**效率（add 与 search 分开）**

- wallclock 总耗时、请求数、LLM 调用数；
- 平均输入 token（只统计 add，含缓存命中）、平均输出 token；
- 平均费用和总费用（USD，按 `pricing.json` 单价；模型不在表里记为 null）；
- 请求延迟 P50 / P95。

## 记录

### 索引

| 记录 | 日期 | 被测实现 | 数据集 | Entry F1 | 内容 F1 | Recall@10 | LLM score | Token F1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [R-20261104-02](#r-20261104-02) | 2026-11-04 | main 分支对照（无项目记忆） | v1 现行金标 | 0.000 | 0.000 | 0.117 | 0.100 | 0.054 |
| [R-20261104-01](#r-20261104-01) | 2026-11-04 | 当前分支旧实现 | v1 现行金标 | 0.237 | 0.644 | 0.967 | 0.967 | 0.400 |

### R-20261104-02

**元数据**

| 项 | 值 |
| --- | --- |
| 被测实现 | `main` @ `6853b777`，无项目记忆；每条轨迹写成一条 L1 记忆，标签 `space:<项目>` 模拟 `space_ids` |
| 回放脚本 | `harness/run-control-main.mjs` |
| 评测配置 | `harness/eval-config.yaml`：token 限流关闭、检索 LLM 过滤关闭 |
| 数据集 | v1 现行金标：28 条 / 7 topic / 30 题（2 个项目，34 条轨迹） |
| 提示词版本 | 不适用（main 无项目记忆提示词） |
| 被测模型 | deepseek-v4.1-flash-1017（网关返回 `deepseek-v4-1-flash-261017`） |
| 评委模型 | claude-haiku-5-5 |
| `memory_limit_number` | 10 |

**写入质量（add）**

| 指标 | 值 |
| --- | --- |
| Entry F1（P / R） | 0.000（0.000 / 0.000），匹配 0 / 28 |
| 内容 F1（P / R） | 0.000（0.000 / 0.000） |
| kind 混淆矩阵 | 不适用（没有项目条目） |
| stale 条数 / 重复条数 | 0 / 0 |
| 模型 topic 数 / gold topic 数 | 0 / 7 |
| Topic 归纳 B-cubed F1（P / R） | 不适用（无匹配条目） |
| 来源轨迹覆盖率 | 0.00（0 / 25） |

**检索（search）**

| 指标 | 值 |
| --- | --- |
| Recall@1 / @3 / @5 / @10 | 0.017 / 0.117 / 0.117 / 0.117 |
| Recall（全部上下文） | 0.117 |
| Recall@10 按题型 | cross-project 0.125（12）· overridden 0.000（5）· plain 0.000（3）· scope-leak 1.000（1）· stale 0.111（9） |
| trap rate | 0.111 |

**回答**

| 指标 | 值 |
| --- | --- |
| LLM score（总体） | 0.100 |
| LLM score 按题型 | cross-project 0.167 · overridden 0.000 · plain 0.000 · scope-leak 0.000 · stale 0.111 |
| Token F1（总体） | 0.054 |
| Token F1 按题型 | cross-project 0.048 · overridden 0.039 · plain 0.019 · scope-leak 0.136 · stale 0.074 |
| 短语 rubric 准确率 | 0.100 |

**效率**

| 指标 | add | search |
| --- | --- | --- |
| wallclock（整轮） | 24.8 s | （同左，整轮合计） |
| 请求数 | 34 | 30 |
| LLM 调用数 | 0（摘要在后台 worker 里做，不计入请求） | 0 |
| 平均输入 token | 不适用（请求内无 LLM 调用） | 不统计 |
| 平均输出 token | 不适用 | 不适用 |
| 平均费用 / 总费用（USD） | 不适用 | 不适用 |
| 延迟 P50 / P95 | 2.2 ms / 11.0 ms | 958 ms / 1296 ms |
| 评委开销（不计入产品） | 17 次调用，$0.0020，P50 1.6–2.1 s | |

**备注**：search 回答直接拼接命中片段，不经模型生成，所以 LLM score 测的是"片段里有没有答案"。本地 embedding 在评测机上反复 `fetch failed`，通用检索的向量通道受影响，分数偏低有一部分是这个原因。

### R-20261104-01

**元数据**

| 项 | 值 |
| --- | --- |
| 被测实现 | 本分支旧实现（Codex 版，`memories` 表 work_memory 行）。代码等同 `69cc0915`（评测时这部分改动尚未提交） |
| 回放脚本 | `run-memmy-live-eval.mjs` |
| 评测配置 | `harness/eval-config.yaml`：token 限流关闭、检索 LLM 过滤关闭 |
| 数据集 | v1 现行金标：28 条 / 7 topic / 30 题（2 个项目，34 条轨迹） |
| 提示词版本 | 旧实现抽取提示词 + topic skill（未带版本号） |
| 被测模型 | deepseek-v4.1-flash-1017（网关返回 `deepseek-v4-1-flash-261017`） |
| 评委模型 | claude-haiku-5-5 |
| `memory_limit_number` | 10 |

**写入质量（add）**

| 指标 | 值 |
| --- | --- |
| Entry F1（P / R） | 0.237（0.226 / 0.250），匹配 7 / 28，模型写入 31 条 |
| 内容 F1（P / R） | 0.644（0.613 / 0.679），匹配 19 / 28 |
| kind 混淆矩阵（gold→模型） | decision→decision 5 · experience→decision 9 · evolution→evolution 1 · evolution→decision 4 |
| stale 条数 / 重复条数 | 8 / 4 |
| 模型 topic 数 / gold topic 数 | 5 / 7 |
| Topic 归纳 B-cubed F1（P / R） | 0.813（0.707 / 0.957），23 条参与 |
| 来源轨迹覆盖率 | 1.00（25 / 25） |
| 未命中 gold | `decision_d_empty`、`experience_d_copy`、`decision_d_notify`、`experience_d_export`、`experience_d_csv`、`experience_t_admin_bug`、`decision_t_admin_todo`、`evolution_t_column`、`evolution_t_wait` |

**检索（search）**

| 指标 | 值 |
| --- | --- |
| Recall@1 / @3 / @5 / @10 | 0.400 / 0.700 / 0.850 / 0.967 |
| Recall（全部上下文） | 0.967 |
| Recall@10 按题型 | cross-project 1.000（12）· overridden 1.000（5）· plain 1.000（3）· scope-leak 0.000（1）· stale 1.000（9） |
| trap rate | 0.519 |

**回答**

| 指标 | 值 |
| --- | --- |
| LLM score（总体） | 0.967 |
| LLM score 按题型 | cross-project 1.000 · overridden 1.000 · plain 1.000 · scope-leak 0.000 · stale 1.000 |
| Token F1（总体） | 0.400 |
| Token F1 按题型 | cross-project 0.443 · overridden 0.413 · plain 0.350 · scope-leak 0.000 · stale 0.396 |
| 短语 rubric 准确率 | 0.367 |

**效率**

| 指标 | add | search |
| --- | --- | --- |
| wallclock（整轮） | 55.3 s | （同左，整轮合计） |
| 请求数 | 12 | 30 |
| LLM 调用数 | 11 | 29 |
| 平均输入 token | 1394（含缓存命中） | 不统计 |
| 平均输出 token | 270 | 42 |
| 平均费用 / 总费用（USD） | null（`pricing.json` 无该模型单价） | null |
| 延迟 P50 / P95 | 1730 ms / 3355 ms | 1006 ms / 1529 ms |
| 评委开销（不计入产品） | 15 次调用 + 43 次缓存命中，$0.0008 | |

**备注**：search 带 `generate_answer`，回答由被测模型生成。scope-leak 一题（q20）走 L1 通用检索，本地 embedding 失败，返回空。

### 本轮口径说明（2026-11-04）

- 两条记录用同一份金标、同一套脚本、同一评委，只有被测实现不同，可以直接对比。
- 检索指标仍是**条目级 Recall**（按 topic 展开后逐条计）；v3 要求按 topic 计数，改口径放在数据集 v2 里做（ADR-0004），届时与这两条记录不能直接对比。
- 网关把请求的 `deepseek-v4.1-flash-1017` 返回为 `deepseek-v4-1-flash-261017`，`pricing.json` 没有单价，费用为 null。补单价后可重算。
- 评测配置关掉了生产环境的 token 限流和检索后的 LLM 过滤器，两者在正式环境默认开启。

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
| Entry F1（P / R） | |
| 内容 F1（P / R） | |
| kind 混淆矩阵（gold→模型） | |
| stale 条数 / 重复条数 | |
| 模型 topic 数 / gold topic 数 | |
| Topic 归纳 B-cubed F1（P / R） | |
| 来源轨迹覆盖率 | |
| 未命中 gold | |

**检索（search）**

| 指标 | 值 |
| --- | --- |
| Recall@1 / @3 / @5 / @10 | |
| Recall（全部上下文） | |
| Recall@10 按题型 | |
| trap rate | |

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
| 平均输出 token | | |
| 平均费用 / 总费用（USD） | | |
| 延迟 P50 / P95 | | |
| 评委开销（不计入产品） | | |

**备注**：
```

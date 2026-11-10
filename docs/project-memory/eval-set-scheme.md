# 项目记忆评测集方案

- 日期：2026-11-10
- 条目：PM-18（PRD 待办 3，截止 11/13）
- 分支：`dev-project-memory-add-search-dev`
- 本文所在提交的父版本：`6f4801ff`
- 数据集版本：v2.1，入库提交 `e5f03e43`（2026-11-10）

这是评测集的留存和使用方案。可运行的语料、标注、题目和金标在 `eval/project-memory/gold-add-memory/dataset/`。本文不另附一份数据集。操作细节、指标定义和规格含糊处仍以该目录的 [README](../../eval/project-memory/gold-add-memory/README.md) 为准。

## 版本怎么留

依据 [ADR-0004](decisions/0004-eval-hygiene-and-dataset-v2.md) 及其 2026-11-10 补记。

- 评分脚本只读 `dataset/`。同一时刻只有这一份可跑。
- 换成大版本时，上一版整份冻在 `eval/project-memory/gold-add-memory/history/<版本>/`。v2 已冻在 `history/v2/`，从 `fc59409e` 的 `dataset/` 原样拷出。评分不会加载冻结副本。说明见 [history/v2/README.md](../../eval/project-memory/gold-add-memory/history/v2/README.md)。
- 小改动只改 `dataset/`，不在 `history/` 留副本。
- 改过 `dataset/` 的输入后，先 `node build-gold-baseline.mjs` 重写 `dataset/gold.json`，再跑下面的校验。生成物写到 `eval/project-memory/runs/`，指标摘要才进 [metrics.md](metrics.md)。

`e5f03e43` 之后到 `6f4801ff`，`dataset/` 与 `history/` 没有再改。

## 当前可跑的一版：v2.1

`corpus.json`、`labels.json`、`questions.json` 的 `datasetVersion` 都是 2.1。2026-11-10 在 `6f4801ff` 上 `node load-eval-set.mjs` 的输出：

| 项 | 数量 |
| --- | --- |
| 轨迹 | 113（写入 83，仅可选 1，不写入 29） |
| 主题 | 50 |
| 必写条目 / 可选条目 | 78 / 12 |
| 负例 | 25 |
| 计分题 | 31（conflict 3，cross-project 10，plain 13，stale 5） |
| 接口检查 | 4 |

题目文件里还有 1 道 excluded 的 q21，不计分。README「数据集」一节里的轮数和题数是 v2 的表，v2.1 以上面这行为准。

### 空间、成员、会话

六个 Space，主题数如下。

| Space | 主题 | 领域 |
| --- | --- | --- |
| `space_ledger` | 4 | 代码开发、工程规范 |
| `space_catalog` | 2 | 代码开发、产品设计 |
| `space_clinic` | 11 | 门诊排班、药房管理 |
| `space_warehouse` | 11 | 入库验收、拣货出库 |
| `space_fleet` | 11 | 车辆维保、线路调度 |
| `space_kitchen` | 11 | 菜品备料、食安留样 |

七名成员：林工、周工、陈工、赵工、吴工、孙工、郑工。17 个会话，其中 6 个只提问。会话带 `agent_id`，取值是 `cursor` 或 `claude-code`。轨迹的 `chat_time` 落在 2026-10-21、11-03、11-04、11-05、11-06。

每个 Space 有一段 `instructions`。回放创建空间时，请求带 `space_name`，并带上这段指令（`run-memmy-live-eval.mjs` 展开语料里该空间的其余字段）。

### 随提问时刻变化的要点

主题摘要和描述的要点是 `{text, since, until?}`，`since` / `until` 是轨迹 id。某要点在提问时有效，当且仅当 `since` 的 `submit_time ?? reply_time` 已不晚于 `askedAt`，且 `until` 还没有到。`oracle.mjs` 和阅读上限按这个时刻取要点。主题要点评分只用没有 `until` 的最终要点。

当前 105 条要点都有 `since`。自测里有一条检查：q01 在 14:00 看不到后来的金额列要点，q03 在 12:00 看不到后来的空客户要点。

### 迟交、重发、推迟、补历史

回放顺序用 `submit_time ?? chat_time`，可见性用 `submit_time ?? reply_time`。迟交且非作者的结论只做 `conflict_append`。

| 字段 | v2.1 里的数量 | 规则 |
| --- | --- | --- |
| `submit_time` | 12 条轨迹 | 提交时刻晚于说话时刻时，按提交排序、按提交后才可见 |
| `resubmitOf` | 5 条轨迹 | 原样重发原来的 add，该轨迹没有 op |
| `deferredUntil` | 6 条 op | 到后一条轨迹才生效；条目时间仍是原来的 `chat_time`；来源含两条轨迹 |
| `history_backfill` | 1 条 op | 按时间插入 history，不改当前版本 |

### 重复率与错误合并率

`--gate` 同时检查：

- `topics.duplicateRate` ≤ `--max-duplicate-rate`（默认 0.02）。一个金标主题对应到 k 个实际主题时计 k−1，再除以有匹配写入的金标主题数。
- `topics.wrongMergeRate` ≤ `--max-wrong-merge-rate`（默认 0.01）。一个实际主题对应到 k 个金标主题时计 k−1，再除以有金标匹配的实际主题数。
- `topics.controlMerges` 为 0，`writes.lateAsCurrent` 为 0。

同一条 `--gate` 还要求 `decisions.stateExact`、`topics.bcubed.f1`、`entries.f1` 不低于 0.8，`search.recall@3` 不低于 0.85，`answers.llm` 不低于 0.8，`api.passRate` 为 1，以及 `staleShownAsCurrent`、`crossProjectLeak`、`foreignTopics`、`reasonFabricated` 为 0。

对照组写在 `labels.controls`：`similar-name` 6 对主题（名称相近、应当分开），`same-work` 4 对条目（同一主题里的两条，应当留在一起）。

## 和 PRD 待办 3 的对应

PRD「待办」第 3 条的建议是：评测集采用多成员、多 Agent、跨天的工作会话，含方案变更、延迟提交与项目指令；对照无记忆、仅事实与事件记忆、竞品方案；并入 OmniMemEval 开源。关联交付物 4，算法侧，截止 11/13。

v2.1 已经覆盖建议里的语料形状：七名成员、两种 `agent_id`、跨五天、决策改写与分歧（`rewrite` 4、`conflict_append` 10、`conflict_update` 1、`resolve` 1）、延迟提交，以及每个空间的项目指令。

已有的对照脚本是另一类对照，写在 README：`harness/run-control-main.mjs` 用没有项目记忆的 main，`harness/run-control-legacy.mjs` 用 v0.1 之前的旧实现。`similar-name` / `same-work` 用来卡错误合并和错误拆分。

## 这次留下的部分

下面几项留在 PM-17，或留到评测集构建排期（PRD 排期表，11/2–12/4）。本文不把它们标成已完成，也不改 [open-questions.md](open-questions.md) 和 [gaps-v01.md](gaps-v01.md)。

1. **q17 的标准答案已改**（Q-14，E-03）。现文同时说明丢行原因和空客户仍有未决分歧。阅读模型上限还没有在这一版上复跑。
2. **阅读模型上限已在 v2.1 上复跑**（E-04）。R-20261110-02 是 0.903（28/31），阅读模型 claude-haiku-4-5-20251001。R-20261110-03 是 0.935（29/31），阅读模型 claude-sonnet-4-6。评委都是 claude-haiku-4-5-20251001，温度 0。都不是 1。网关没有 claude-haiku-5-5。两次都错的是 q03、q24。这条上限来自 `harness/run-reader-ceiling.mjs`。`--oracle` 把标准答案直接写入 run，它的 `answers.llm` 为 1，不能当作这条上限。
3. **新题 q40–q47 都是 plain。** 门诊 q40、q41，仓储 q42、q43，车队 q44、q45，厨房 q46、q47。这四个空间没有 stale、conflict、cross-project 题。
4. **PRD 建议的三套系统对照和开源方式没有做。** 没有「无记忆」「仅事实与事件记忆」「竞品」三套对照，也没有把评测集并入 OmniMemEval。

## 怎么校验

在 `eval/project-memory/gold-add-memory/`：

```bash
node load-eval-set.mjs              # errors 必须为 []
node selftest.mjs                   # 评分与接口检查自测；不需要服务、评委、阅读模型
node run-pipeline-eval.mjs --oracle # 金标自身作答：每项得分 1、每项错误 0
node run-pipeline-eval.mjs --empty  # 什么都不写、不答：每项得分 0
```

2026-11-10 在 `6f4801ff` 上四条都通过：`load-eval-set` 的 `errors` 为 `[]`；`selftest` 16/16；`--oracle` 的 `failures` 为 `[]`，得分全是 1、错误全是 0；`--empty` 的 `failures` 为 `[]`，得分全是 0。报告写在已忽略的 `eval/project-memory/runs/oracle-report.json` 与 `empty-report.json`。

对着服务回放、评委打分和阅读上限不在这四条里。命令见 README「对着服务跑」。

## 同事的数据集分支

`dev-project-memory-search-gold-baseline` 是同事在用的数据集分支。未经用户确认，不推送、不改写。ADR-0004 写明：同步到该分支之前先征得用户同意。

---
item: PM-18-eval-scheme
seq: 01
role: reviewer
app: Cursor
model: claude-sonnet-5-5-medium
date: 2026-11-10
reviewed: handoff-01.md
range: 6f4801ff..cb3cd2eb
verdict: approved   # approved | changes-requested | blocked
---

# 评审 01：方案与 cb3cd2eb 的仓库一致，通过；一条 SHOULD

评的是交付当时（`cb3cd2eb`）的文档。q17 答案和阅读上限 R-20261110-02 是后来的提交，不在范围内，不据此扣分。

## 复核验证

diff 只有三个文件：`eval-set-scheme.md`（新增）、`ROADMAP.md`（PM-18 改 done，加一行变更记录）、`item.md`。`eval/` 在 `6f4801ff..cb3cd2eb` 之间没有任何改动，所以方案里「`e5f03e43` 之后到 `6f4801ff`，`dataset/` 与 `history/` 没有再改」和「在 `6f4801ff` 上跑过」的说法，对 `cb3cd2eb` 同样成立。

handoff 没有新跑测试（文档项）。我在 `git archive cb3cd2eb` 解出的临时目录里抽查了三条命令：

| 命令 | 结果 |
| --- | --- |
| `node load-eval-set.mjs` | `errors: []`，`datasetVersion` 2.1，轨迹 113（写入 83 / 仅可选 1 / 不写入 29），主题 50，必写 78 / 可选 12，负例 25，计分题 31（conflict 3、cross-project 10、plain 13、stale 5），接口检查 4。与方案表逐项一致 |
| `node selftest.mjs` | 16/16 passed |
| `node run-pipeline-eval.mjs --oracle` | `failures: []`，得分全 1，错误全 0；`answers.llm` = 1 |

`--empty` 没有重跑，只信方案里的记录。`git show cb3cd2eb:.../history/v2/README.md` 写明从 `fc59409e` 拷出，该提交存在；`corpus.json`、`labels.json`、`questions.json` 的 `datasetVersion` 都是 2.1；`history/v2/` 下有 `corpus.json`、`gold.json`、`labels.json`、`questions.json`、`conflicts.json`、`README.md`；`e5f03e43` 存在。

## 重点核对

1. **评分只读 `dataset/`，`history/v2` 不参与。** 成立。`load-eval-set.mjs` 与 `run-pipeline-eval.mjs` 里没有读 `history/` 目录的路径，`run-pipeline-eval.mjs` 里出现的 `history` 都是决策条目的 `history` 字段。方案「版本怎么留」一节的说法与此一致，也与 ADR-0004 补记和 `history/v2/README.md` 一致。
2. **`--oracle` 的 `answers.llm` = 1 没有被写成阅读上限已达到。** 成立。方案「这次留下的部分」第 2 条明说阅读上限没有在 v2.1 上复跑，`--oracle` 把标准答案直接写入 run，所以 `answers.llm` 为 1 不能当作这条上限；上限指 `harness/run-reader-ceiling.mjs`。ROADMAP 的 PM-17 行也仍写「answers.llm = 1 尚未核对」。
3. **handoff 里没做的三项**（q17、阅读上限、三套对照）在方案正文和 ROADMAP 变更记录里都写明留在 PM-17 或方案外，没有被写成已完成。按评审要求不因此标 MUST。

## 上一轮 MUST 的关闭情况

无。

| 意见 | 结果（已关闭 / 未关闭 / 转裁决） | 说明 |
| --- | --- | --- |
| — | — | 第一轮 |

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | SHOULD | `docs/project-memory/ROADMAP.md` PM-18 行（`cb3cd2eb` 第 37 行） | 状态格是 `done（eval-set-scheme.md；v2.1 即 e5f03e43）`，没有提 PRD 待办 3 的三套系统对照和 OmniMemEval 开源这次没做。这两项只在方案正文里写明，只看 Roadmap 的人会以为 PRD 待办 3 整条已交付 | 方案「和 PRD 待办 3 的对应」与「这次留下的部分」第 4 条；AGENTS.md「文档随代码」要求条目状态与实际一致 | 状态格补一句「三套对照与开源未做」，或在 Roadmap 里另开一行记这两项的去向 | 读 ROADMAP PM-18 行能看到这两项未做 |
| R1-2 | NIT | `eval-set-scheme.md`「当前可跑的一版」 | 方案说 README「数据集」一节的轮数和题数是 v2 的表。这是方案去对冲 README 的旧数字，更好的做法是直接更新 README，但这属于改 `eval/`，不在本工作项范围内 | — | 可选；在 PM-17 顺手更新 README | — |

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| 方案说明：评分只读 `dataset/`，大版本冻在 `history/<版本>/`，小改动不另存副本 | 是 | 方案「版本怎么留」；脚本不读 `history/` |
| 方案写明 v2.1（`e5f03e43`）：50 个主题、7 名成员、六个空间、随时间变化的要点、`submit_time` / `resubmitOf` / `deferredUntil` / `history_backfill`、`duplicateRate` 与 `wrongMergeRate` | 是 | 方案对应各节；规模数字与 `load-eval-set` 输出一致 |
| 方案写明 q17 答案未改（Q-14）、阅读上限未复跑（E-04）、q40–q47 均为 plain | 是 | 「这次留下的部分」第 1–3 条 |
| 方案写明校验命令及 2026-11-10 在 `6f4801ff` 上的结果 | 是 | 「怎么校验」；我抽查的 `load-eval-set`、`selftest`、`--oracle` 在 `cb3cd2eb` 上与记录一致 |
| 交接评审 | 是 | handoff-01.md；本份为 review-01 |

## 需要 designer / 用户裁决

无。

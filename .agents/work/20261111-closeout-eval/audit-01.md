# 审计 01：2026-11-05 之后未写入项目记忆文档的变动

- 日期：2026-11-11
- 分支：`dev-project-memory-add-search-dev`
- 范围：只读。对照 `git log --since=2026-11-05`，以及 Cursor 会话里的用户原话。
- 核对过的文档：`ROADMAP.md` 变更记录、`spec-alignment.md`、`open-questions.md`、`gaps-v01.md`、`decisions/*.md`、`findings.md`、`metrics.md`。这些文件里已经写过的不重复列。未提交的 `decisions/0009-eval-protocol-v2-1.md` 算已记录。

下面只列文档没写到的候选。不写分数，不提议新行为。

## 未记录

### 1. 旧任务没有 `domains` 时，不参与「同一 domain 集合」去重

已完成任务的进度里如果没有 `domains` 数组，不再把它当成空 domain 集合；之后一次 `domains` 为 `[]` 的请求仍会抽取这些消息。

- 证据：`9953ace9`。评审要求见 `.agents/work/PM-15-restatement-filter/review-01.md` R1-1（SHOULD）：「旧行没有 `domains` 时不参与去重（缺字段按未知处理，不与任何集合相等），或在 ADR-0005 补记」。代码按前一种做了，`local-state.ts` 的 `organizedTurnIds` 在 `domains` 不是数组时直接跳过。
- 文档：Q-27 只写「domain 集合不同或上次失败仍然整理」。`spec-alignment.md` §2.2.1、ADR-0005 的 PM-15 补记、ROADMAP 的 PM-15、`gaps-v01.md`、`findings.md`、`metrics.md` 都没有这条例外。

### 2. 钉钉上的架构 v3 正文是空的，不改用钉钉 v2

用户要求改对照钉钉上的 v2。核对后的结论是：钉钉 v3 节点正文为空，不能当拉取源；钉钉 v2 的章节和本地 v3 不是同一篇；代码继续对齐本地 `design-docs/standard/项目记忆：端云协同架构与模块设计（v3）.md`（2026-11-02 评审稿）。这次没有改文件，也没有提交。

- 证据：会话 [钉钉规格改指 v2](b6f3eae0-2a94-4838-b782-8564b29e0db4)，用户原话：「原来研发的v3文档变了，现在使用的应该是v2文档。」
- 文档：`spec-snapshots.md` 仍是 2026-11-03 的三行，2026-11-11 只加了一句「收尾没有新的规格版本」。`open-questions.md`、ROADMAP 变更记录、ADR 都没有记下「钉钉 v3 为空、不切换到钉钉 v2」。

### 3. 数据集介绍页没有随 v2.1 更新

给新同事看的介绍页仍是数据集 v2：35 轮、五条时间线。v2.1 入库时没有重写这一页。

- 证据：会话 [重建数据集介绍页](79fb3fe7-bf8e-4a4c-9c10-d9e46f64f848)，用户原话：「以前用来展示和介绍数据集的html好像被删除了？请重建这个html，使用最新的数据集版本作为参考。」落地提交是 `556cd340`（`eval/project-memory/gold-add-memory/report.html`）。该文件之后没有再改。`e5f03e43` 发布 v2.1 时没有动它。同目录 README 仍把这一页写成「35 轮对话按五条时间线排列」，并注明上面各表的轮数和题数是 v2 的。
- 文档：ROADMAP、`eval-set-scheme.md`、`findings.md` 写了 v2.1 的规模，没有提到这份介绍页还停在 v2。周报 `weekly/2026-W45.md` 只登记了 `556cd340` 是 v2 介绍页，当时 v2.1 还没有。

## 状态对照（PM-12～PM-23）

工作项 `item.md` 的 `status` 与 ROADMAP 状态格：

| 条目 | item.md | ROADMAP |
| --- | --- | --- |
| PM-12 | done | 实现完成，待复测 |
| PM-13 | done | 实现完成，评测待补 |
| PM-14～PM-23 | done | done |

PM-12、PM-13 的差别已经写在 ROADMAP 变更记录（2026-11-10：验收数字还没有，状态不再写成 done）。工作项前言仍是 `done`，文档没有写「工作项状态未改」。

## 已核对、不列入

- 裁判改为 `~/.openai.env` 的 `gpt-6-luna`（chat completions，不用 Decisions），温度用模型默认，`max_completion_tokens`；不重跑 v0.1，旧实现和 main 也用 v2.1。用户原话在 [收尾评测](43127fa4-455f-418f-97cf-94b83548513f)（「老的方法可以重跑，数据集都用最新的数据集吧，不要再跑v0.1了」）和 [W46–W47 开发](9992bc91-ffbe-4827-8db9-8bb09ad15598)（「请把裁判模型换成.openai.env中的gpt-6-luna」）。未提交的 ADR-0009 和当前 `metrics.md` 已写。工作区里 `llm.mjs` 的未提交 diff 就是这一条。
- Q-18、Q-19 暂缓：会话 [补周报](7c834b17-df47-4d01-99f8-92e4e38e419d)，「Q-18和19以及相关项先暂时不考虑，等初始版本完成后再想。」ROADMAP 2026-11-09 与 open-questions 已写。
- 数据集只冻大版本：会话 `9992bc91`，「仅需要留下数据集的大版本就行了」。ROADMAP 2026-11-10、ADR-0004、`eval-set-scheme.md` 已写。
- Jev 默认关闭、改用 gpt-6-luna：ADR-0006、ROADMAP 2026-11-06、metrics 专项实验已写。
- 会话消融和「细 topic 给 Agent、粗列表给人看」：`findings.md` §9–§10 已写。这还不是规格。
- 提示词现行号 `pm-extract-v0.2.2`、`pm-judge-v0.3.0` 在 `spec-alignment.md` 里。ADR-0007 正文仍是 `pm-extract-v0.2.0` / `pm-judge-v0.2.0`，ROADMAP 的 PM-13 仍写 `pm-extract-v0.2.1`。升版随 `7bc8ca04`、`bb2f0a70`、`c966fc5c` 落地，不是另一项未记录的产品决定。
- 会话 [对照 Super Agent 架构](d69d1e1c-8b13-43ce-ade3-1c5fabc5fa7e) 要求只提建议、不要改文档。建议只留在该会话，没有写进 open-questions。按当时要求，不算漏记的实现。

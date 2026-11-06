# 新同事上手：项目记忆现状（2026-11-06）

项目记忆让多个成员、多个 Agent 在同一个项目空间里共享「决策 / 经验 / 进展」，对外是 `add_message` 和 `search_memory` 两个接口。代码在 `Memory/src/service/project-memory/`，交付日是 **2026-11-27**，范围是 Local 全链路加云端 Store 的 HTTP 适配（见 [ROADMAP.md](ROADMAP.md)）。

## 先读什么

1. 仓库根的 [AGENTS.md](../../AGENTS.md)：权威顺序、模块边界、算法红线。所有 Agent 和人都按它来。
2. 规格：`design-docs/standard/` 里的《项目记忆：端云协同架构与模块设计（v3）》，其次是 SDK 规格和 PRD。`design-docs/` 不进 git，找负责人要本地镜像。代码对齐的版本见 [spec-snapshots.md](spec-snapshots.md)，目前是 v3 的 11/02 评审稿。
3. [DEVELOPMENT.md](DEVELOPMENT.md)：模块布局、编码规则、测试和评测命令。
4. [gaps-v01.md](gaps-v01.md)：v0.1 哪里不行、证据是什么、由哪个 Roadmap 条目收回。想知道下一步该做什么，从这里看最快。

`design-docs/` 下的 `alpha/`、`claude/`、`codex/` 是 v3 之前的历史方案，不是事实源；里面有而 v3 没采纳的设计（如 `.memos/` 目录、`ProjectSnapshot`）不算缺口。

## 做到哪了

W45（11/3–11/6）的目标是出一个能端到端跑通的 v0.1，用来暴露问题，这个目标已经达到：

- **已完成**：独立的表结构（schema v10，不复用 `memories` 表）、SQLite Store 与条件写、异步 add（一次 LLM 调用完成抽取和归类，再做条目合并，冲突重合并最多 3 次）、search 的 project 一路召回（FTS5 + 向量，RRF + MMR）、旧实现已删除、评测数据集 v2 和评分脚本。
- **在评审**：两个工作项 [PM-03-eval-dataset-v2](../../.agents/work/PM-03-eval-dataset-v2/item.md) 和 [PM-05-09-v01-core](../../.agents/work/PM-05-09-v01-core/item.md) 的评审 MUST 已经修完，状态是 `ready-for-review`，在等第二轮评审。
- **实验，默认关闭**：用 `gpt-6-luna` 做主题归属的选择题，设置 `MEMMY_DECISION_TOPIC=1` 才会生效，代码在 `decisions/`。它会让 search 不再确定性，所以不能当默认路径，见 [ADR-0006](decisions/0006-jev-topic-experiment.md)。

v0.1 在数据集 v2 上的数字（[metrics.md](metrics.md) 的 R-20261105-02）：

| 指标 | v0.1 | 上限（金标作被测系统） | 目标 |
| --- | --- | --- | --- |
| answers.llm | 0.609 | 0.826 | ≥ 0.8 |
| entries.f1 | 0.667 | 1.000 | ≥ 0.8 |
| decisions.stateExact | 0.800 | 1.000 | ≥ 0.8 |
| topics.bcubed.f1 | 0.473 | 1.000 | ≥ 0.8 |
| search.recall@3 | 0.913 | 1.000 | ≥ 0.85 |

旧实现在同一口径下 answers.llm 是 0.565。早先 v1 数据集上的 0.967 和这些数字不可比，口径不同，原因写在 metrics.md 的「口径提醒」里。

主要差距在写入侧：推迟的内容不回填、进展几乎不写、经验写错类、主题粒度不对（gaps-v01.md 的 G-01～G-04）。另外有一部分失分来自评测本身（E-02、E-03），拿回答分对齐目标之前要先修数据集。

## 接下来

- **W46**：拆开 M02 / M04 的提示词（PM-12）、推迟回填（PM-13）、决策补全 resolve / split 等 op（PM-14）、迟交与复述过滤（PM-15）、数据集 v2.1（PM-17）。
- **W47**：search 三路召回、渐进式披露和注入模板。
- **W48**：云端 Store 契约测试、小范围云端测试、按 v3 验收表逐项核对。

## 怎么开始干活

```bash
npm --prefix Memory run typecheck
cd Memory && npx vitest run tests/service/project-memory
```

- 工作分支是 `dev-project-memory-add-search-dev`。挑一个 Roadmap 条目，按 `pm-dev-loop` 技能做；评测用 `pm-eval` 技能，生成物写到 `eval/project-memory/runs/`（不进 git）。
- 本项目由多个 Agent 和人接力，只通过仓库文件交接。开工前读 [.agents/README.md](../../.agents/README.md)，交接写 `handoff-NN.md`，评审写 `review-NN.md`，只追加不改别人的文件。
- 发现规格冲突或空白，写进 [open-questions.md](open-questions.md)，不要自己改设计。改契约、表结构或已定决策要写 ADR。
- 几条容易踩的红线：检索不调模型重排、同样输入同样输出；`domain` 由调用方指定；`history` 只追加；改提示词要升版本并补一次评测；`dev-project-memory-search-gold-baseline` 是同事在用的数据集分支，不要推送或改写。

# 新同事上手：项目记忆现状（2026-11-11）

项目记忆让多个成员、多个 Agent 在同一个项目空间里共享「决策 / 经验 / 进展」，对外是 `add_message` 和 `search_memory` 两个接口。代码在 `Memory/src/service/project-memory/`，交付日是 **2026-11-27**，范围是 Local 全链路加云端 Store 的 HTTP 适配（见 [ROADMAP.md](ROADMAP.md)）。

## 先读什么

1. 仓库根的 [AGENTS.md](../../AGENTS.md)：权威顺序、模块边界、算法红线。所有 Agent 和人都按它来。
2. 规格：`design-docs/standard/` 里的《项目记忆：端云协同架构与模块设计（v3）》，其次是 SDK 规格和 PRD。`design-docs/` 不进 git，找负责人要本地镜像。代码对齐的版本见 [spec-snapshots.md](spec-snapshots.md)，目前是 v3 的 11/02 评审稿。
3. [DEVELOPMENT.md](DEVELOPMENT.md)：模块布局、编码规则、测试和评测命令。
4. [findings.md](findings.md)：这次开发里值得告诉同事的发现。它不是规格。
5. [metrics.md](metrics.md) 文首的三张总表：端到端、只测写入、只测检索或回答。想看数字先看总表，不要把金标上限读成产品效果。
6. [gaps-v01.md](gaps-v01.md)：v0.1 哪里不行、证据是什么、由哪个 Roadmap 条目收回。

`design-docs/` 下的 `alpha/`、`claude/`、`codex/` 是 v3 之前的历史方案，不是事实源；里面有而 v3 没采纳的设计（如 `.memos/` 目录、`ProjectSnapshot`）不算缺口。

## 做到哪了

W45 的 v0.1 已经用来暴露问题。W46 和 W47 的代码已经落地，评审没有未关闭的 MUST。W48（云端 Store、云端测试、故障注入、验收表）还没做。

- **整理**：抽取、归属、判断分成三次调用。每个任务只抽取一次。主题集合变化时重跑召回和归属，版本冲突只重跑判断，最多 3 次。
- **检索**：用户记忆、L1/Skill、project 三路并行，失败写入 `degraded`，再按名次融合。省略 `include_memory_view` 时不搜项目。
- **注入**：模板 1–3、闭合块剥离、降级提示。宿主钩子只接了 Memmy agent。
- **数据集**：可跑的是 v2.1（6 个项目、50 个 topic、113 轮写入）。v2 冻在 `eval/project-memory/gold-add-memory/history/v2/`。
- **实验，默认关闭**：`MEMMY_DECISION_TOPIC=1` 才用 gpt-6-luna 做主题选择题，见 [ADR-0006](decisions/0006-jev-topic-experiment.md)。

产品端到端（先 add，再用写下的记忆 search）的最近一次数仍是 v0.1 在数据集 v2 上的 R-20261105-02：`entries.f1` 0.667，Recall@3 0.913，answers.llm 0.609。当前代码在 v2.1 上还没有这次回放。金标阅读上限 R-20261110-04 的 answers.llm 是 1.000，那是阅读模型在看金标，不是产品写入的结果。总表和口径见 [metrics.md](metrics.md)。

## 接下来

- **W48**：云端 Store 契约测试、小范围云端测试、按 v3 验收表逐项核对。
- 当前代码的 v2.1 端到端回放还没跑成。补上之前，不要用 v0.1 的 0.667 / 0.913 或金标上限的 1.000 描述现在的产品。

## 怎么开始干活

```bash
npm --prefix Memory run typecheck
cd Memory && npx vitest run tests/service/project-memory
```

- 工作分支是 `dev-project-memory-add-search-dev`。挑一个 Roadmap 条目，按 `pm-dev-loop` 技能做；评测用 `pm-eval` 技能，生成物写到 `eval/project-memory/runs/`（不进 git）。
- 本项目由多个 Agent 和人接力，只通过仓库文件交接。开工前读 [.agents/README.md](../../.agents/README.md)，交接写 `handoff-NN.md`，评审写 `review-NN.md`，只追加不改别人的文件。
- 发现规格冲突或空白，写进 [open-questions.md](open-questions.md)，不要自己改设计。改契约、表结构或已定决策要写 ADR。
- 几条容易踩的红线：检索不调模型重排、同样输入同样输出；`domain` 由调用方指定；`history` 只追加；改提示词要升版本并补一次评测；`dev-project-memory-search-gold-baseline` 是同事在用的数据集分支，不要推送或改写。

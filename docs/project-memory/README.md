# 项目记忆开发文档

这里放项目记忆 `add_message` / `search_memory` 的开发规范、计划和过程记录。规格本身在 `design-docs/standard/`（钉钉文档的本地镜像，不进 git）。

## 文档

| 文件 | 内容 | 什么时候改 |
| --- | --- | --- |
| [findings.md](findings.md) | 开发过程中的发现，给同事和汇报用。不是规格 | 有新的评测结论或设计建议时 |
| [ONBOARDING.md](ONBOARDING.md) | 给新同事的现状说明：先读什么、做到哪了、接下来做什么 | 每周五随周报 |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 模块布局、编码规则、测试与评测命令、提交流程 | 约定变化时 |
| [ROADMAP.md](ROADMAP.md) | 里程碑、周计划、条目状态、变更记录 | 每周一确认，每周五修订 |
| [spec-alignment.md](spec-alignment.md) | 规格章节 → 代码 → 状态 → 测试，及与 PRD 的差异 | 每次改变行为的提交 |
| [spec-snapshots.md](spec-snapshots.md) | 每次对齐时三份规格的日期和 sha256 | 跑 `pm-spec-sync` 时 |
| [open-questions.md](open-questions.md) | 规格 TBD、实现中发现的问题和我们的提议 | 随时；周报汇总 |
| [gaps-v01.md](gaps-v01.md) | v0.1 的实现缺口与评测缺口，含证据、归属条目、状态 | 每次评测后、缺口收回时 |
| [metrics.md](metrics.md) | 每次评测完整记录全部指标，对照 v3 目标 | 每次跑 `pm-eval` |
| [../../.agents/](../../.agents/README.md) | designer / developer / reviewer 的交接规范与工作项 | 每次交接 |
| [decisions/](decisions/) | ADR，只追加 | 改契约、表结构或已定决策时 |
| [weekly/](weekly/) | 周报 | 每周五 |

## 权威顺序

最新版架构文档（当前 v3）> SDK 接口规格 > PRD。冲突按此取舍并登记到 `spec-alignment.md`。见 [ADR-0001](decisions/0001-authority-order.md)。

## 当前对齐的规格

见 [spec-snapshots.md](spec-snapshots.md) 最上面一行。

## 更新机制

探索期设计每周都会变，文档和计划按下面的机制跟着变，每周至少迭代一次。

1. **节奏**：周一在 `ROADMAP.md` 确认本周条目；周五跑 `pm-weekly-review`，写 `weekly/2026-Wxx.md`，重排下周计划，列出需要架构文档作者回复的问题。
2. **规格变化触发**：`design-docs/standard/` 有改动或出现新版本时跑 `pm-spec-sync`：比对 sha256、按章节列出变化、把受影响的对齐行标为「待重新对齐」、必要时起草 ADR、调整 Roadmap。新版架构文档自动成为最高权威。
3. **按变化分级**：
   - L1 只改文档：更新对齐表；
   - L2 改契约或表结构：写 ADR，做 schema 迁移和契约测试；
   - L3 改算法或提示词：提示词升版本，`metrics.md` 追加一次评测。
4. **可追溯**：Roadmap 条目有 ID（PM-xx），状态变化写在底部变更记录；ADR 只追加，改主意时新写一条并注明「取代 ADR-xxxx」；评测数据集带版本号，`metrics.md` 每行写明数据集版本。
5. **反馈上游**：实现发现的规格问题写进 `open-questions.md`，周报列出待回复项，回复后关闭并在对齐表落地。

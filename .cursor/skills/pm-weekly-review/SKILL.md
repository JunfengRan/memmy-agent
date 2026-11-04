---
name: pm-weekly-review
description: 写项目记忆开发周报并修订 Roadmap。每周五使用，或用户说「写周报」「本周复盘」「更新计划」时使用。汇总提交、指标、规格变化和 ADR，产出 docs/project-memory/weekly/2026-Wxx.md 并重排下周计划。
---

# 项目记忆周报

探索期每周至少迭代一次文档和计划，这个技能就是那次迭代。

## 步骤

1. **确定周次**：ISO 周（`date +%G-W%V`），周一到周五的日期。
2. **先同步规格**：调用 `pm-spec-sync`，确认本周规格有没有变化。
3. **收集材料**：
   - 本周提交：`git log --since=<周一> --until=<周六> --format='%h %ad %s' --date=short`；
   - `ROADMAP.md` 本周条目的状态；
   - `metrics.md` 本周新增行与上周对比；
   - `spec-snapshots.md` 本周新增行；
   - `decisions/` 本周新增或改状态的 ADR；
   - `open-questions.md` 中 `待回复` 的条目。
4. **写周报**：复制 `docs/project-memory/weekly/_template.md` 为 `weekly/<YYYY>-W<NN>.md`，逐节填写。「发现的问题与修订提议」要写清问题归属（架构文档 / 实现 / 数据集）。
5. **修订 Roadmap**：
   - 本周完成的条目改 `done`；没完成的改 `moved` 并写去向，或留在本周并说明原因；
   - 根据问题清单新增、拆分或调整下周条目，保持 11/27 交付日；放不下的列进「风险」并提醒用户取舍；
   - 变更记录追加一行。
6. **向用户汇报**：本周结论、下周计划、需要用户或架构文档作者决定的事项。Roadmap 中跨周的大调整（推迟里程碑、砍范围）要先征得用户同意。

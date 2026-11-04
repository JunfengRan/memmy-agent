---
name: pm-dev-loop
description: 实现项目记忆 Roadmap 条目（PM-xx）的标准流程。在开始写 Memory/src/service/project-memory/ 下的代码、实现某个 PM 条目、或用户说「做 PM-07」「继续开发项目记忆」时使用。
---

# 项目记忆开发循环

规则见仓库根 `AGENTS.md`，细则见 `docs/project-memory/DEVELOPMENT.md`。

## 步骤

1. **定位条目**：在 `docs/project-memory/ROADMAP.md` 找到条目，读它的规格出处和验收；把状态改为 `doing`。
2. **读规格**：读 `design-docs/standard/` 中最新架构文档的对应章节，再看 `spec-alignment.md` 对应行和 `open-questions.md` 相关条目。规格与 PRD 冲突时按架构文档。规格没写清的地方，先在 `open-questions.md` 写提议再实现。
3. **先写测试**：在 `Memory/tests/service/project-memory/` 写失败的测试。规格里有逐轮示例表的，做成 golden 用例。LLM 用 `vi.stubGlobal("fetch")` 打桩。
4. **实现**：只改 `Memory/src/service/project-memory/` 和必要的薄委托（`memory-service.ts`、`server/http.ts`、`storage/schema.ts`、`service/worker/job-handlers.ts`）。对照 AGENTS.md 的算法红线自查。改提示词时升版本号。
5. **检查**：
   ```bash
   npm --prefix Memory run typecheck
   cd Memory && npx vitest run tests/service/project-memory
   ```
   行为影响 add 或 search 质量时，用 `pm-eval` 跑一次评测冒烟。
6. **更新文档**（与代码同一个提交）：
   - `spec-alignment.md` 对应行的状态和代码位置；
   - `ROADMAP.md` 条目状态；
   - 有简化或偏离时写进 ADR（v0.1 的简化汇总到 ADR-0005）；
   - 评测有新数时由 `pm-eval` 写 `metrics.md`。
7. **提交**：英文 Conventional Commit，scope `project-memory`，正文说明对应的 PM ID 和规格章节。只在用户要求时提交。

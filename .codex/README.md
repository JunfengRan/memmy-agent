# Codex 配置说明

Codex 启动时会读取仓库根的 `AGENTS.md`，其中「多 Agent 协作（必读）」一节要求先读 `.agents/README.md` 并按 `.agents/protocol.md` 交接。

`.codex/skills/` 下是指向 `.agents/skills/` 的符号链接（`agent-handoff`、`agent-review` 和 `pm-*` 开发技能），技能内容只在 `.agents/skills/` 维护。

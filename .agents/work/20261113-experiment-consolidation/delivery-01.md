---
item: 20261113-experiment-consolidation
role: developer
app: Codex
model: GPT-6
date: 2026-11-13
branch: feat/jev-superagent
status: ready-for-review
---

# 分支改名与清理说明

用户要求整合分支改为 feat/jev-superagent，不使用 codex 或 consolidated，并以清理后的本地分支为准同步 origin。handoff-01.md 中的旧分支名和保留原分支说明是此前交付时的历史状态，以本记录为后续说明；实现交付仍为 559f342a，未改产品代码，未新增评审结论。

- 整合分支改名为 `feat/jev-superagent`，目录改为 `.worktrees/jev-superagent/`；材料中的当前入口随之更新。
- 删除本地 `dev-project-memory-alpha`、`dev-project-memory-search-gold-baseline`、`feat/local-lab-chat`、`feat/superagent-session-as-topic`、`feat/superagent-session-router`。
- 两个旧实验 worktree 保留文件，切为 detached HEAD；65e61c7e/fa04419b 均在整合分支历史内。没有强制删除其目录或依赖链接。
- `feat/project-memory-frontend` 未被点名删除，保留；它也保有与已删除本地 alpha 相同的 0ed9161c 提交。
- origin 的目标分支集合为：`backup/main-before-project-memory-20261113`、`dev`、`dev-project-memory-add-search`、`dev-project-memory-add-search-dev`、`feat/jev-superagent`、`feat/project-memory-frontend`、`main`、`release/v1.2.7`。
- 同步使用显式 heads refspec、普通更新及删除 origin 多余分支；不使用 mirror、不修改 tags 或 upstream。main 已预先确认可从 origin/main 快进到本地 main。

本记录随改名材料先提交，再执行远端同步，最终远端名称与 SHA 由实际 git ls-remote 比对结果确认；不提前声称未发生的推送结果。只改文档和 Git 引用，不重复运行产品测试。已有独立评审仍待进行。

# 多 Agent 协作规范

本项目由不同应用（Claude Code、Codex、Cursor 等）里的多个 Agent 接力完成。Agent 之间不共享对话，**只通过仓库里的文件交接**。本目录规定交接的方式；每个 Agent 开工前必须读完本文件。

完整协议见 [protocol.md](protocol.md)，模板在 [templates/](templates/)，交接记录在 [work/](work/)。

## 角色

| 角色 | 做什么 | 主要产出 |
| --- | --- | --- |
| designer（架构） | 定架构与规格，回答设计问题 | 架构文档（`design-docs/standard/` 最新版）、ADR、`open-questions.md` 的答复、`design-NN.md` |
| developer | 按 Roadmap 条目实现，交给 reviewer 或下一个 developer | 代码与测试、`handoff-NN.md` |
| reviewer | 评审实现，给出必须修改项和建议 | `review-NN.md` |

一个 Agent 一次只担任一个角色，在交接文件的头部写明。

## 必须遵守

1. **开工先读**：读本文件 → 找到要做的工作项 `work/<id>/` → 按编号读完其中所有文件，最新一份最先看结论、再按顺序补齐上下文。没有工作项就新建一个（见 protocol.md §2）。
2. **只追加，不改别人的文件**：每次交接新建下一个编号的文件（`handoff-03.md`、`review-02.md`），不修改已有文件。唯一可改的是 `item.md` 的状态字段。
3. **交接前先提交**：交接文件里引用的代码必须已经提交，写明分支和 commit。未提交的改动不算交付。
4. **状态必须真实**：测试、评测没跑就写没跑；失败就贴失败输出。不能写「应该可以」。
5. **reviewer 的 MUST 必须逐条回应**：developer 的下一份 handoff 要有「评审回应」表，每条 MUST 写「已修复（commit）」或「不同意（理由，等 reviewer 或 designer 裁决）」。MUST 没有全部关闭，工作项不能进入 `approved`。
6. **设计问题交给 designer**：developer 和 reviewer 都不自行改变设计。发现规格冲突或空白，写进 `docs/project-memory/open-questions.md` 并在交接文件里标出，按现有权威顺序（AGENTS.md）先实现提议方案，或停在 `blocked`。
7. **写明身份**：每份交接文件头部写角色、应用、模型，以便追溯。

## 状态

`in-progress` → `ready-for-review` → `changes-requested` ⇄ `ready-for-review` → `approved` → `done`

另有 `handed-off`（交给下一个 developer 继续）和 `blocked`（等 designer 或用户决定）。状态写在 `work/<id>/item.md` 的头部。

---
name: agent-handoff
description: developer 交接：把进度和成果交给 reviewer，或把没做完的工作交给下一个 developer。在实现告一段落、准备请求评审、回应评审意见、要结束会话但工作没做完、或用户说「交接」「提交评审」「交给下一个人」时使用。
---

# developer 交接

规则见 `.agents/README.md` 和 `.agents/protocol.md`。

1. 找到工作项 `.agents/work/<id>/`，没有就按 `templates/item.md` 新建。读完 `item.md` 和全部已有文件。
2. 确认代码已提交：`git status --short` 干净（无关文件除外，在交接里说明），记下 `git rev-parse --short HEAD` 作为 head；base 取上一份 handoff 的 head，第一份取开工时的 commit。
3. 亲自跑验证：至少 typecheck 和受影响的测试；行为影响 add / search 质量时跑 `pm-eval`。记录真实结果。
4. 复制 `templates/handoff.md` 为下一个编号的 `handoff-NN.md`，逐节填写：
   - 有上一份 review 时，「评审回应」必须覆盖它的每条 MUST 和 SHOULD；
   - 偏离规格的地方都要链接 ADR 或 open-questions；
   - 交给下一个 developer 时写可勾选的剩余任务和继续方法。
5. 更新 `item.md` 头部的 `status`、`owner`、`updated`，在「状态记录」表加一行。
6. 提交交接文件（`docs:` 或随代码一起），提交信息带 `Work-Item: <id>`。只在用户同意时提交。
7. 告诉用户：工作项 ID、交接文件路径、状态、需要谁接手。

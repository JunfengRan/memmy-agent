---
name: agent-review
description: reviewer 评审：读 developer 的交接记录，复核实现，给出 MUST / SHOULD / NIT 意见和结论。在用户说「评审」「review 这个工作项」、或工作项状态为 ready-for-review 时使用。
---

# reviewer 评审

规则见 `.agents/README.md` 和 `.agents/protocol.md` §4。评审只读代码，不顺手修改实现；需要改的写成意见。

1. 读 `.agents/work/<id>/item.md` 的验收标准，再读最新的 `handoff-NN.md` 和所有历史 review。
2. 看改动：`git diff <base>..<head>`，对照 handoff 的「改动」表和规格出处，检查 AGENTS.md 里的模块边界与算法红线。
3. 复核：亲自重跑 handoff 的验证命令；声称的评测数字到 `docs/project-memory/metrics.md` 核对记录。
4. 有上一轮 review 时，先逐条判断上一轮 MUST 是否关闭（看 handoff 的「评审回应」和对应 commit）。
5. 复制 `templates/review.md` 为下一个编号的 `review-NN.md`，每条意见带编号、级别、`file:line`、依据、要求的结果、验证方法。只有真正阻塞的才标 MUST。
6. 给出结论：没有未关闭 MUST 才能 `approved`；需要设计决定写 `blocked` 并在 open-questions 登记。
7. 更新 `item.md` 的 `status`、`owner`（交回 developer 或标 done），在「状态记录」加一行；告诉用户结论和 MUST 数量。

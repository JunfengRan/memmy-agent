# 交接协议

## 1. 文件布局

```
.agents/
  README.md            必读规则（所有 Agent 自动加载）
  protocol.md          本文件
  templates/           item / handoff / review / design 模板
  skills/              agent-handoff、agent-review 两个技能
  work/
    <id>/
      item.md          工作项：目标、范围、验收、当前状态（唯一可改的文件）
      handoff-01.md    developer 交接
      review-01.md     reviewer 评审
      design-01.md     designer 裁决（可选）
      ...
```

每个工作项一个目录，文件按类型各自编号，只追加。这样多个 Agent 并行时不会改同一个文件。

## 2. 工作项

- **ID**：有 Roadmap 条目时用条目 ID 加短名，如 `PM-07-add-pipeline`；没有时用 `YYYYMMDD-短名`。
- **新建**：复制 `templates/item.md` 到 `work/<id>/item.md`，填目标、范围、规格出处、验收标准。验收标准优先抄 Roadmap 和规格里的验收表，不自己发明。
- **粒度**：一个 reviewer 一次能评完，通常对应一个 Roadmap 条目。太大就拆成多个工作项，并在 `item.md` 里互相链接。

## 3. developer 交接（handoff-NN.md）

在以下时刻写：

- 实现完成，请求评审 → 状态改 `ready-for-review`；
- 做不完，交给下一个 developer → 状态改 `handed-off`；
- 卡在设计问题 → 状态改 `blocked`；
- 回应 review 后再次提交评审 → 状态改 `ready-for-review`。

模板：`templates/handoff.md`。必填：

1. **头部**：工作项、角色、应用 / 模型、日期、分支、基线 commit、交付 commit、交给谁（reviewer / developer）。
2. **结论**：两三句话，现在什么能用、什么还不能用。
3. **改动**：按文件或模块列出，说明为什么改；对应的规格章节。
4. **验证**：实际运行的命令和结果（通过数 / 失败输出）；跑了评测就链接 `metrics.md` 的记录 ID。
5. **与规格的偏离和简化**：每条链接 ADR 或 `open-questions.md` 条目。
6. **评审回应**（第二轮起必填）：逐条回应上一份 review 的 MUST 和 SHOULD。
7. **请 reviewer 重点看**：风险最高的地方，最多 5 条，带 `file:line`。
8. **交给下一个 developer**（`handed-off` 时必填）：剩余任务清单（可勾选），如何继续（命令、入口文件），已知的坑。

## 4. reviewer 评审（review-NN.md）

模板：`templates/review.md`。reviewer 必须先读 `item.md` 的验收标准和最新 handoff，再看 diff（`git diff <基线>..<交付>`），并亲自重跑 handoff 里的验证命令。

每条意见一行，带编号（`R<轮次>-<序号>`，如 `R2-3`）和级别：

| 级别 | 含义 | developer 的义务 |
| --- | --- | --- |
| **MUST** | 不满足就不能通过：缺陷、违反规格或 AGENTS.md 红线、验收标准未达到、测试缺失 | 必须修复，或给出理由请 reviewer / designer 裁决 |
| **SHOULD** | 建议修改，明显更好 | 修改，或写理由说明不改 |
| **NIT** | 措辞、命名等小问题 | 可选 |
| **QUESTION** | 需要 developer 解释 | 在下一份 handoff 回答 |

每条 MUST 要写清：位置（`file:line`）、问题、依据（规格章节 / 红线 / 复现步骤）、要求的结果、怎么验证已修复。

结论三选一，写在头部并同步到 `item.md`：

- `approved`：没有未关闭的 MUST；
- `changes-requested`：有 MUST；
- `blocked`：需要 designer 或用户裁决，写明问题。

第二轮及以后的 review 先逐条确认上一轮 MUST 是否关闭，再写新意见。

## 5. designer 裁决（design-NN.md）

designer 主要通过文档传递信息：

- 影响全局的决定：更新架构文档（`design-docs/standard/`，随后由 `pm-spec-sync` 登记快照）或写 ADR；
- 回答具体问题：在 `docs/project-memory/open-questions.md` 改状态并写答复；
- 只影响一个工作项的裁决：在该工作项下写 `design-NN.md`（模板 `templates/design.md`），说明问题、决定、依据和对现有实现的要求。

developer 和 reviewer 以「最新架构文档 > ADR > design-NN > open-questions 答复」为准。

## 6. 和其他文件的关系

- `docs/project-memory/ROADMAP.md`：条目状态以工作项为准；工作项进入 `done` 时同步改 Roadmap。
- `docs/project-memory/metrics.md`：评测数字只记在这里，交接文件只链接记录 ID。
- 提交信息可加 trailer `Work-Item: <id>`，便于从 git log 找回交接记录。

## 7. 收尾

reviewer 给出 `approved` 后，developer（或 reviewer）把 `item.md` 状态改为 `done`，写上合入的 commit，并更新 Roadmap 与 `spec-alignment.md`。

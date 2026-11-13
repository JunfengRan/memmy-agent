---
item: PM-22-injection-templates
seq: 01
role: reviewer
app: Cursor
model: claude-sonnet-5-5-medium
date: 2026-11-10
reviewed: handoff-01.md
range: f7eb0022..e980bf77
verdict: approved   # approved | changes-requested | blocked
---

# 评审 01：模板、剥离、降级提示符合验收，无 MUST，有 3 条 SHOULD

## 复核验证

在独立 worktree（`/tmp/pm-review-pm22`，e980bf77，node_modules 软链）里重跑，跑完已移除 worktree。结果与 handoff 一致。

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 退出码 0 |
| `cd Memory && npx vitest run tests/service/project-memory tests/cli-command-map.test.ts tests/local-cloud-parity/openmem-cloud-client.test.ts` | 退出码 0；20 个文件、197 通过、1 个 todo（与 handoff 一致） |
| `npm --prefix App/memmy-agent run typecheck` | 退出码 0 |
| `cd App/memmy-agent && npx vitest run tests/memmy-memory/client-tools.test.ts tests/memmy-memory/hook.test.ts` | 退出码 0；2 个文件、48 通过（与 handoff 一致） |
| 两份模板 `diff -q`（`memmy-default.ts`、`memmy-plugin.ts`，App/backend 与 Memory/agent-source 各一份） | 无输出，无差异。`memmy-default.md` 只在 App/backend 有一份，没有对应副本可比 |

评测：handoff 声明未跑。`git diff f7eb0022..e980bf77 -- docs/project-memory/metrics.md` 为空，没有用新分数冒充评测。

## 上一轮 MUST 的关闭情况

无（第一轮）。

| 意见 | 结果 | 说明 |
| --- | --- | --- |
| — | — | — |

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | SHOULD | `Memory/src/service/project-memory/inject/render.ts:68-70`（`escapeInjectedMarkers`）；`:339-358`（`renderProjectIndex`） | 字段里的字面标签只转义了 `<memos_context`，没有转义 `</project_index` / `<project_index`。主题名或摘要里若含 `</project_index>`，会提前闭合索引块；而 `strip.ts` 会把 `project_index` 当闭合块删除，两边口径不一致 | v3 §3.4（`strip_injected` 同时处理两种块）；handoff 重点 1「字段里的字面标签被换成全角」 | 转义同时覆盖 `memos_context` 与 `project_index`，并加一条索引渲染的单测 | 构造 `topic_summary` 含 `</project_index>`，渲染结果里只剩一个闭合标签 |
| R1-2 | SHOULD | `App/memmy-agent/src/memmy-memory/hook.ts:902-969`（`loadProjectSession`、`injectBoundProjectTurn`、`prependProjectTurn`）；`App/memmy-agent/src/memmy-memory/project-inject.ts` | Memmy agent 的会话索引、每轮注入和「检索失败不挡本轮」（handoff 重点 4）没有单测：`hook.test.ts` 在这个范围内没有改动，`project-inject.ts`（433 行）也没有测试。此外 `project-inject.ts` 基本是 `inject/render.ts` 的拷贝，两份会各自漂移 | AGENTS.md「测试」；v3 §3.1 | 补一条 hook 测试，覆盖：绑定空间时注入索引和每轮模板、`post` 抛错时本轮照常继续、无命中且无降级时不注入。后续单独排期收敛成一份渲染代码 | `npx vitest run tests/memmy-memory/hook.test.ts` |
| R1-3 | SHOULD | `Memory/src/service/project-memory/prompts/inject.ts:6`；`docs/project-memory/metrics.md` | 提示词有版本号 `pm-inject-v0.1.0`，但没有任何引用，`metrics.md` 也没有对应评测行。AGENTS.md 要求新增或修改提示词时在 `metrics.md` 追加一次评测 | AGENTS.md「提示词与技能」 | 下次评测时把 `pm-inject-v0.1.0` 记入 `metrics.md`；或在 handoff / ROADMAP 里写明评测排期 | `metrics.md` 里能找到该版本号 |

核对「重点看」5 条：

1. 降级提示：`renderTurnMemories` 中提示在闭合标签之前，有命中、无命中的 `tool`、无命中的 `turn` 三种情况都渲染固定提示，对应单测在 `inject-render.test.ts`。字段字面标签的转义见 R1-1。
2. `strip.ts`：只删闭合块，嵌套块循环到不再变化为止，未闭合标签原样留下并计入 `unclosedBlocks`，与 Q-34 一致。`collect.ts` 同时处理 content 和字符串形式的 tool-call 参数，`extract.ts` 再剥一次，作为兜底。
3. 工具默认输出：`inject/tool.ts`、CLI 与 App 工具改走模板三，`--raw` 保留 JSON，`cli-command-map` 与 client-tools 测试已覆盖。
4. 检索失败不挡本轮：代码上成立（`injectBoundProjectTurn` 外层 try/catch，`finally` 仍置 `turn.finished`），但没有测试，见 R1-2。
5. Q-21 状态：`open-questions.md` 的 diff 只新增 Q-33、Q-34 两行，没有改 Q-21 状态列。

红线核对：存储层和云端没有新增模型调用（`render.ts`、`strip.ts` 为纯函数）；渲染不重排，排序用时间与下标做稳定比较，同样输入同样输出；提示词有版本号，但见 R1-3。`TaskDetails` 新增的 `strippedBlocks`、`unclosedBlocks` 是可选字段，不改表结构。

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| 提交给 M02 的内容里闭合注入块 = 0，并有单测 | 满足 | `strip.ts`、`collect.ts`、`extract.ts`；`inject-strip.test.ts`、`organize-stages.test.ts`；云端 `addMessage` 剥离见 `openmem-cloud-client.test.ts` |
| `degraded` 非空时，有命中和无命中都渲染固定提示，并有单测 | 满足 | `render.ts:369-391`；`inject-render.test.ts` |
| 交接（本轮不写 handoff，代码未提交） | 已由 handoff-01.md（e980bf77）取代。这一条是本轮 item.md 里的旧文字，不影响结论 | `item.md` 状态记录 |

## 需要 designer / 用户裁决

无。Q-21、Q-33、Q-34 仍待回复，是已知范围，不阻塞本工作项。Claude / Codex / Cursor 宿主钩子没接，按范围说明不算缺口。

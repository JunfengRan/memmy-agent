---
item: PM-13-deferred-backfill
seq: 01
role: reviewer
app: Cursor
model: claude-sonnet-5-5-medium
date: 2026-11-10
reviewed: handoff-01.md
range: c6f1f842..7bc8ca04
verdict: approved   # approved | changes-requested | blocked
---

# 评审 01：回填实现与规格一致，无 MUST；评测缺口已如实声明

## 复核验证

在独立 worktree（`/tmp/pm-review-pm13`，checkout `7bc8ca04`，软链主工作区 `node_modules`）里重跑，跑完已 `git worktree remove --force`。

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | exit 0 |
| `cd Memory && npx vitest run tests/service/project-memory` | exit 0；10 个文件、65 个测试全部通过，与 handoff 一致 |
| `git diff --stat c6f1f842..7bc8ca04` | 17 个文件，+1326 / −54；其中新增测试文件 `deferred-backfill.test.ts`（874 行） |
| `git diff c6f1f842..7bc8ca04 -- docs/project-memory/metrics.md` | 无改动 |

评测：handoff 声明未跑，我核对 `metrics.md` 在该范围内没有任何改动，没有把回填率写成新分数。表里的 R-20261110-01 / -02 是后来的检索延迟与阅读上限，不是这次的产品回放，与 PM-13 无关。

## 上一轮 MUST 的关闭情况

无（第一轮）。

| 意见 | 结果（已关闭 / 未关闭 / 转裁决） | 说明 |
| --- | --- | --- |
| 无 | 不适用 | 无 |

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | SHOULD | `docs/project-memory/ROADMAP.md`（PM-13 行，7bc8ca04） | Roadmap 把 PM-13 写成「done」，但 item.md 当时是 `ready-for-review`，且验收「推迟内容回填 ≥90%」没有数字。括号里写了「评测未跑」，但状态列仍是 done，容易被后续读成已达标。 | protocol §6：工作项进入 `done` 才同步改 Roadmap；工作项状态才是准 | 把状态改成「实现完成，评测待补」之类，或在补到回放数字后再标 done | 看 ROADMAP 的 PM-13 行 |
| R1-2 | SHOULD | `prompts/extract.ts`（`pm-extract-v0.2.1`）；`docs/project-memory/metrics.md` | 提示词升了版本，AGENTS.md 要求同时在 `metrics.md` 追加一次评测。本次因网关 503 没有记录，handoff 如实写了，但这条要求仍欠着。 | AGENTS.md「提示词与技能」 | 网关恢复后补一次 add 回放，记录回填率，并回写 G-01 与 PM-13 验收；在此之前不要把 G-01 标成 fixed | 新增 `metrics.md` 记录 ID，handoff 或工作项链接它 |
| R1-3 | NIT | `pipeline/organize-job.ts` `planSettlement` | 模型对某个 ref 既不认领也不带回时，该行被当作「明确丢弃」删除。这符合提示词「确定不该记时不要带回 ref」，但模型漏写也同样删行，没有告警日志区分。`deferred.backfill` 日志只有 consumed 总数。 | v3 §2.2.7（归类失败不保守新建）；提示词第三条 | 可选：日志里把「认领 / 丢弃」分开计数，便于回放时看漏带回 | 看日志字段 |

## 重点项核对

| # | handoff 提的点 | 结论 | 证据（行号以 `7bc8ca04` 为准） |
| --- | --- | --- | --- |
| 1 | 结算只在完成时、失败路径不调用 | 成立 | `finish()` 只在 `extracted.drafts.length === 0`、`!merged.changeSet`、`result.ok` 三处返回前调用。`model()` 抛 `TaskFailure`、commit 重试耗尽走 `fail`/throw，不经过 `finish`，行保留。单测覆盖「模型失败行仍在」 |
| 2 | 幂等键不含回填 id | 成立 | `idempotencyKey` 仍是 `spaceId:conversation:batchHash(turns)`；提交成功后崩溃再重放，`replayed` 为真时 `added/updated` 为 0，仍调用 `finish` 删行，不复制条目。PM-16 的限制写在注释和 Q-22 / handoff |
| 3 | `pendingDeferred` 排除 `topic_unavailable` 和清空前行 | 成立 | `local-state.ts` 查询：`reason != 'topic_unavailable'`，`JOIN pm_tasks` 且 `accepted_at >= clearedAt`（`clearedAt` 为空则不限）；按 `conversation_id` + `space_id` 过滤，匿名会话（无 `conversationId`）不加载（`EMPTY_BACKFILL`） |
| 4 | 每个 ref 只留第一条草稿、未知 ref 丢弃 | 成立 | `parseExtractOutput`：`occupied` 去重，`byRef` 无此 ref 直接 return；`deferred_idx` 必须在该 ref 的 `didx` 内，否则放回 deferred；作者与时间取自原轮次（`draftAuthors`、`turn.chatTime`），不取模型输出，符合红线「原因只取自会话」 |
| 5 | 清空 Space 丢掉推迟行 | 成立 | `service.clearSpace` 在 `store.clearSpace` 之后调用 `local.forgetDeferred`；`forgetSpace` 复用它。同时查询侧还有 `clearedAt` 围栏，两层都有 |

补充核对：

- 模块边界：改动都在 `project-memory/` 内，`organize-job.ts` 里的 `local-state` 经 `ProjectLocalState`，`service.ts` 只加一行委托，不违反「薄委托」。
- 算法红线：回填没有新增模型调用（仍在 M02 同一次调用里），排序只取 id，确定；未改 M05；`history` 与 `conflicts` 不涉及。
- 并发：入队 `scopeKey = project_memory:<spaceId>` 加 `scopeSeq`，同一 Space 的任务串行，所以两个任务同时认领同一批行的竞态不成立。
- `backfillOf` 穿过 M03/M04/merge：`TOPIC_SET_CHANGED` 下被标 `topic_unavailable` 的草稿带 `backfillOf`，`planSettlement` 把旧行删掉并追加一条新的 `topic_unavailable` 行，下一次不回填。
- 回填上限 10 取最近 10 行（`ORDER BY id DESC LIMIT`），更早的行永远不会被带进来。这是 Q-22 写明的取舍，不当缺陷，但行会长期留在表里。
- 文档：ADR-0005 补记追加，没改原表；Q-22 状态为「按提议实现」，只引了 v3 §2.2.7、§4.5，没有引历史方案。

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| 同一会话下一条消息能把推迟句写回，时间与作者取自原轮次，原行删除，本批 `deferred_count` 只计新推迟 | 是 | `parseExtractOutput` 取原轮次；`finish` 返回 `plan.appended.length`；单测 |
| 模型原样带回 ref 时保留同一行；之后可以认领 | 是 | `echoed` → `kept`；单测 |
| `topic_unavailable` 不回填；已删除主题不被这条路径重建 | 是 | 查询排除；`TOPIC_SET_CHANGED` 路径换行 |
| 清空 Space 后旧行消失，下一条消息不回填 | 是 | `forgetDeferred` + `clearedAt` 围栏 |
| 其他会话、匿名会话、其他 Space 看不到这批行 | 是 | 查询过滤 + `EMPTY_BACKFILL` |
| 模型调用失败时行还在，下一次任务可重试 | 是 | 失败路径不结算 |
| `VERSION_CONFLICT` 只写一次；`TOPIC_SET_CHANGED` 保留 `backfillOf`；提交后重放删行且不复制条目 | 是 | 代码路径如上，单测覆盖 |
| 推迟内容回填 ≥90% | 否（已知，非本轮 MUST） | handoff 与 item.md 都写明没有新数字；`metrics.md` 无新记录，未把没跑的说成跑了。见 R1-1 / R1-2 |

## 需要 designer / 用户裁决

无。

---
item: PM-15-restatement-filter
seq: 01
role: reviewer
app: Cursor
model: claude-sonnet-5-5-medium
date: 2026-11-10
reviewed: handoff-01.md
range: e5f03e43..c966fc5c
verdict: approved   # approved | changes-requested | blocked
---

# 评审 01：复述过滤接入整理任务，无阻塞问题

## 复核验证

在独立 worktree（`/tmp/pm-review-pm15`，c966fc5c，node_modules 软链主工作区）里重跑，跑完已移除。沙箱建 worktree 失败，用不受限权限重试后成功。

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | exit 0 |
| `cd Memory && npx vitest run tests/service/project-memory` | exit 0；13 个文件、103 个测试通过、1 个 todo（Q-23），与 handoff 一致 |
| `git diff e5f03e43..c966fc5c -- docs/project-memory/metrics.md eval` | 空。没有改 metrics.md，没有冒充新分数 |

## 上一轮 MUST 的关闭情况

无。

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | SHOULD | `store/sqlite/local-state.ts` `organizedTurnIds`（`space.domains ?? []`） | 本次改动之前完成的任务没有 `domains` 字段，被当成空 domain 集合。之后一次空 domain 请求（payload.domains 为 `[]`）会把这些旧任务当成「同一 domain 集合」，对已整理的消息跳过抽取，而旧任务其实可能用的是非空集合。 | Q-27：同一 Space、同一 domain 集合才去重 | 旧行没有 `domains` 时不参与去重（缺字段按「未知」处理，不与任何集合相等），或在 ADR-0005 补记这个取舍 | 加一个用例：旧行无 `domains`，请求 `[]` 时消息仍被抽取 |
| R1-2 | NIT | `pipeline/organize-job.ts` `recalledEntries` | 经验和时间线只取当前内容，被替换过的旧版不在召回集里，助手复述旧版经验不会被丢掉。handoff 和 ADR-0005 补记已说明，是 recall_log 没有这些 id 造成的。 | ADR-0005 2026-11-10 补记 | 无，记录即可 | |

## 重点 5 条的核对

| 条目 | 结论 | 证据 |
| --- | --- | --- |
| 1 过滤只在抽取后跑一次 | 成立 | `filterRestatements` 写在 `if (!extracted)` 块里，结果存回 `extracted`；TOPIC_SET_CHANGED 和 VERSION_CONFLICT 重试直接复用，不再抽取也不再过滤。过滤后无草稿时直接 `finish`，被丢弃的回填草稿不在 `resolvedBackfill` 也不回显，`planSettlement` 按显式丢弃处理，不会留成永久待处理行 |
| 2 只等于 history 的迟交不产生 op | 成立 | `decideDecision` 里 `late` 返回 null；非迟交、无 reason、无 resolve、无 signaledResolve 返回 `"restatement"` 并记入 `dropped`；有 reason 或裁决信号则落到后面的逻辑，当作改回。判定要求不等于当前内容和任何 conflict（`sameConclusion === null`） |
| 3 用户消息文本等于召回也不丢 | 成立 | `dropsAsRestatement` 对 `role === "user"` 直接返回 false，对 `unknown` 只做精确匹配，approval 和 resolve 信号一律保留 |
| 4 推迟回填仍按原 task id 读原文 | 本范围内未改动 | 回填走原 `backfill.turns` / `deferredTurns`，diff 没碰 `loadBackfill`；回填草稿通过 `sourceRole(turn)` 取原消息的角色 |
| 5 幂等键和失败重交没改 | 成立 | 键仍是 `space:conversation:batchHash`，只是 hash 输入改成完整的 `batchTurns`，不因去重而变化；`organizedTurnIds` 排除当前 task 且要求 `status === "completed"`，失败任务和另一 Space 不参与 |

红线：没有新增模型调用，过滤和合并比对都是确定性的；`history` 仍只追加；存储仍经 `ProjectMemoryStore`；`recalledIds` 只读 `pm_recall_log`。

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| 迟交且只等于 history 的草稿不写 | 是 | `merge.ts` `late` 分支返回 null；`restatement-pipeline.test.ts` 覆盖 |
| 非迟交、无原因、无裁决信号的 history 复述不改当前内容 | 是 | `"restatement"` 分支，记入 `dropped` |
| 助手复述他人 conflict 不 join；没有事先检索时同一草稿会合并 | 是 | 有召回时过滤丢弃；无召回时 `recalled` 为空，不过滤 |
| `TOPIC_SET_CHANGED` 不把丢掉的复述找回来，抽取只跑一次 | 是 | 过滤结果缓存在 `extracted` |
| 同一 Space、同一 domain 集合的已完成消息不再抽取；另一 Space、另一 domain 集合、失败任务仍然整理 | 是，旧行缺 `domains` 的情况见 R1-1 | `organizedTurnIds` 逻辑；全量测试通过 |
| 评测未跑 | 是 | metrics.md 没有变更 |

## 需要 designer / 用户裁决

无。评测欠账（`pm-extract-v0.2.2` 在数据集 v2.1 上复测）和 Q-23 未改，交接里已写明，不作为 MUST。

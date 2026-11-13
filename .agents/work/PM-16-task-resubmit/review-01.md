---
item: PM-16-task-resubmit
seq: 01
role: reviewer
app: Cursor
model: claude-sonnet-5-5-medium
date: 2026-11-10
reviewed: handoff-01.md
range: 47639967..62d542b6
verdict: approved   # approved | changes-requested | blocked
---

# 评审 01：缺时间重提、可重试失败重交实现与验收一致，无 MUST

## 复核验证

在独立 worktree（62d542b6，软链主工作区 node_modules）里重跑，结束后已移除 worktree。

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | exit 0 |
| `cd Memory && npx vitest run tests/service/project-memory` | exit 0；12 个文件、93 个测试通过、1 个 todo（Q-23），与 handoff 一致 |
| `git diff 47639967..62d542b6 -- docs/project-memory/metrics.md` | 无改动。没有拿评测分数冒充；提示词也未改 |

## 上一轮 MUST 的关闭情况

无（第一轮）。

| 意见 | 结果（已关闭 / 未关闭 / 转裁决） | 说明 |
| --- | --- | --- |
| — | — | — |

## 意见

对 handoff 的 5 条重点逐条核对：

1. `batchKey`（`service.ts:232`）：推断时间不再写 null，`idempotencyKey`（`organize-job.ts:202`）未动，符合 Q-15。成立。
2. `local-state.ts:111-119`、`:146-165`：`retryableFailure` 要求所有失败 Space 的 `error.reason` 都在 `RESUBMITTABLE_REASONS`；旧任务 `batch_key` 追加 `#task_id`，旧 `task_id` 仍可查；只有失败 Space 重排队（`service.ts` 用 `pendingSpaceIds`）。符合 Q-16、Q-25。成立。
3. `taskFromRow`（`local-state.ts:85-92`）只复制 status、memoryIds、added、updated、deferredCount，不带 `resubmitOf`。成立。
4. `organize-job.ts` 失败路径只 `fail(...)`，没有 `settleDeferred` 调用。成立。
5. 幂等键不含回填 id，见 `organize-job.ts:202`。成立。

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | SHOULD | `local-state.ts:159-163` | 重提任务里已完成的 Space 被复制成 `completed` 且 `memoryIds: []`、`added: 0`；任务汇总的 added / memoryIds 只反映本次重跑，调用方看不到上一次已写入的结果。旧任务仍可查，所以不丢信息，但新任务状态容易被误读为「什么都没写」 | v3 §2.2.11；handoff 改动表 | 在 `detail` 或文档里写明：重提任务的汇总只含重跑的 Space，已完成 Space 的结果看原任务（`resubmitOf` 目前只存 progress_json、不对外） | 看 spec-alignment 或 ADR 有一句说明；或测试断言 |
| R1-2 | SHOULD | `local-state.ts:154` | 旧任务用 `batch_key || '#' || task_id` 腾开键。UPDATE 与 INSERT 在同一事务里，没问题；但同一任务第二次失败、再重提时会得到两层后缀，没有测试覆盖「连续两次重提」 | Q-16 | 补一条连续重提（失败 → 重提失败 → 再重提成功）的单测 | `npx vitest run tests/service/project-memory/task-resubmit.test.ts` |
| R1-3 | NIT | `organize-job.ts` 冲突 detail | `detail` 形如 `VERSION_CONFLICT,TOPIC_SET_CHANGED; topics=a,b`，topics 去重与否未处理，多次冲突同一主题会重复列出 | v3 §2.2.11 | 可选：去重 | — |

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| 缺 `chat_time` 时，时钟前进两秒的两次同文提交各自整理；同一秒仍是一条任务 | 是 | `service.ts:232`；`task-resubmit.test.ts` 通过 |
| 同一 `chat_time` 在完成后重放返回原 task_id，不再抽取 | 是 | `createTask` 对 completed 任务返回 `created:false`；测试通过 |
| `MODEL_CALL_FAILED` 与 `VERSION_CONFLICT_RETRY_EXHAUSTED` 可重提为新任务；旧任务保持 failed | 是 | `RESUBMITTABLE_REASONS`；旧行只改 `batch_key` |
| `SPACE_CLEARED` 以及任一 Space 不可重试时返回原任务 | 是 | `retryableFailure` 的 `every(...)` |
| 冲突耗尽不落 deferred；重提成功后才写入 | 是 | 失败路径无 `settleDeferred`；测试通过 |
| 并发：其他领域新建不触发围栏；拒绝的提交不留半写入；三人同时新建最终 1 个主题 | 是 | `concurrency.test.ts` 通过 |

其他核对：改动只在 `service.ts`（薄委托范围内的 batchKey 与排队）、`store/sqlite/local-state.ts`、`pipeline/organize-job.ts`，没有越过模块边界、没有模型调用、没有评测专用字段。C01 留给 PM-24、未跑评测，交接已写明，不算缺陷。

## 需要 designer / 用户裁决

无。

---
item: PM-16-task-resubmit
seq: 01
role: developer
app: Cursor
model: grok-4.7-xhigh-fast
date: 2026-11-10
branch: dev-project-memory-add-search-dev
base: 47639967
head: 62d542b6
to: reviewer
status: ready-for-review
---

# 交接 01：缺时间的提交会再整理，可重试失败可以重交

## 结论

没有 `chat_time` 时，到达时间的秒进入任务批次键。同一秒的同文提交仍是一条任务；隔开两秒则各整理一次。`MODEL_CALL_FAILED` 和 `VERSION_CONFLICT_RETRY_EXHAUSTED` 再提交时新建任务，只重跑失败的 Space。不可重试的失败仍返回原任务。C01 仍留给 PM-24。评测未跑。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `service.ts` | `batchKey` 始终带 `chatTime` | 推断时间被丢掉后，第二次「继续」拿回旧任务 | v3 §2.2.2、Q-15 |
| `store/sqlite/local-state.ts` | 可重试失败把旧 `batch_key` 腾开，插入新任务；已完成的 Space 不重排队 | 失败批次没有恢复途径 | v3 §2.2.11、Q-16、Q-25 |
| `pipeline/organize-job.ts` | 冲突耗尽的 `detail` 列出每次冲突种类 | 失败原因要能看 | v3 §2.2.11 |
| `task-resubmit.test.ts`、`concurrency.test.ts` | 重交、同一秒、多 Space、并发新建和半写入 | 验收表 | v3 §2.3.1 |
| open-questions | Q-15、Q-16、Q-24、Q-25 按提议实现 | 秒精度和部分失败是规格没写死的 | Q-24、Q-25 |
| ADR-0005 补记 | 第 10 条 C01 改到 PM-24 | 本项验收不含 C01 | ADR-0005 #10 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过，exit 0（交接前重跑） |
| `cd Memory && npx vitest run tests/service/project-memory` | 12 个文件、93 个测试通过、1 个既有 todo（Q-23） |

评测：未跑。本项不改提示词。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| 可重试失败再提交新建任务，不是永远返回原 task_id | Q-16 |
| 到达时间只到秒，同一秒同文仍是一条任务 | Q-24 |
| 任一 Space 不可重试失败则整单返回原任务 | Q-25 |
| 本机不做 C01 | ADR-0005 #10，PM-24 |

## 评审回应

无。

## 请 reviewer 重点看

1. `Memory/src/service/project-memory/service.ts` 的 `batchKey` — 推断时间不再写成 null。
2. `Memory/src/service/project-memory/store/sqlite/local-state.ts` — 只在每个失败 Space 都是可重试原因时换新任务；旧 `task_id` 仍能查到。
3. `get/status` 不返回 `resubmitOf`。
4. 失败路径仍不调用 `settleDeferred`。
5. 幂等键不含回填 id。

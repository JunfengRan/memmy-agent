---
item: PM-19-three-path-recall
seq: 01
role: reviewer
app: Cursor
model: claude-sonnet-5-5-medium
date: 2026-11-10
reviewed: handoff-01.md
range: 31f59624..6ad531fa
verdict: approved   # approved | changes-requested | blocked
---

# 评审 01：三路召回满足验收标准，无 MUST，有 2 条 SHOULD

## 复核验证

在独立 worktree（`6ad531fa`，软链 `node_modules`）里重跑，结束后已移除 worktree。

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | exit 0 |
| `cd Memory && npx vitest run tests/service/project-memory tests/service/retrieval/recall-candidates.test.ts` | exit 0；15 个文件，123 个测试通过，1 个 todo（与 handoff 一致） |
| `git diff 31f59624..6ad531fa --stat -- docs/project-memory/metrics.md` | 无改动，没有拿未跑的评测冒充分数 |

## 上一轮 MUST 的关闭情况

无。

## 重点项核对

1. `recall-paths.ts`：三路用 `Promise.allSettled` 并行，每路有独立超时。请求了的路，成功则出现在 `user_memory` / `agent_memory` / `topics`，失败则写入 `degraded`。端口缺失会抛错，被记为 `user_memory` / `agent_memory`。未请求的路不出现，也不进 `degraded`，符合 Q-28。通过。
2. `recallCandidates`：只传 `rewrite: false`、`mmr: false`、`recencyAnchor: "newest"`，不走 `filterRecallHits`，没有 chat 请求，没有墙钟，也不写 recall event。`newestCandidateMs` 取候选最大时间，同样输入得到同样输出。符合 §6.1 #9 和 Q-20。通过。
3. 只请求 project：`searchProjectMemory` 原样运行，`topic_detail_list` 恒存在。`search.test.ts` 和 `http-contract.test.ts` 均通过。通过。
4. `preference` / `profile` / `event` / `tool_memory` 返回 `MODE_UNSUPPORTED`，不进 `degraded`。未知值返回 `INVALID_PARAMS`。通过。
5. add 路径与 `get/status` 未改。`memory-service.ts` 只去掉 search 的 `assertMemorySearchEnabled`，个人检索关闭时由 `recallCandidates` 抛错，退成降级 ①②，project 仍可用。通过。

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | SHOULD | `recall-paths.ts:67-90`、`limits.ts` `recallPathTimeoutMs` | 1.2 秒超时也包住了 project 路。以前 project-only 请求不设超时，现在慢的 embedding 会让 `topics` 变成 `[]` 并记 `degraded: ["project"]`。超时后底层任务也不会取消，仍可能在返回之后写 `recall_log`。 | 验收标准「只请求 project 时与现有行为一致」；§3.2.3 每路超时 | 说明 project 路超时与既有行为的差异，写入 ADR-0005 补记；或给 project 路单独更宽的预算。可选：超时后的结果不再落 `recall_log`。 | 加一条 project 路超时的测试，断言超时后 `recall_log` 行数 |
| R1-2 | SHOULD | `api.ts:121-138` | 省略 `include_memory_view` 以前返回 `INVALID_PARAMS`，现在默认走 ①② 且不含 project。这是对调用方可见的行为变化，handoff 的「与规格的偏离」表没有列出。 | Q-28 只定了取值和通道名，没定缺省 | 把「缺省 = ①②、不含 project」写进 Q-28 或 ADR-0005 补记，交 designer 确认。 | 文档里能查到，且 `http-contract.test.ts` 有对应用例（已有） |
| R1-3 | NIT | `retrieval-service.ts` `recallCandidates` | `void input.contextBudget` 只是占位，留着没有作用。 | — | 删掉参数，或在 M10 实现时再加。 | — |

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| 请求的每一路要么出现在结果里，要么出现在 `degraded` | 是 | `recall-paths.ts` `readPath`，`recall-paths.test.ts` |
| 只请求 project 时，`topic_detail_list` 与 `recall_log` 与现有行为一致 | 是（超时差异见 R1-1） | `search.test.ts`、`http-contract.test.ts` 通过 |
| ② 和 ① 不调用查询改写、LLM 过滤，也不按墙钟改顺序 | 是 | `recall-candidates.test.ts`，`recencyAnchor: "newest"`，`mmr: false` |
| typecheck 与项目记忆、recallCandidates 单测通过 | 是 | 本次复核 exit 0，123 通过 |

## 需要 designer / 用户裁决

R1-2 的缺省视图建议 designer 在 Q-28 里确认，不阻塞本工作项。

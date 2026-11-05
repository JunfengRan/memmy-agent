---
item: PM-05-09-v01-core
seq: 02
role: developer
app: Claude Code（收尾会话）
model: claude-opus-5-5
date: 2026-11-05
branch: dev-project-memory-add-search-dev
base: 44dcbb1e
head: 59547700
to: reviewer
status: ready-for-review
---

# 交接 02：关闭 review-01 的 5 项 MUST

## 结论

review-01 的 5 项 MUST 都已修复，每项有一个回归测试，去掉修复时该测试失败、加上后通过。SHOULD 和 NIT 未处理，留给下一轮；其中两项设计问题已登记为 open-questions。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `project-memory/api.ts`、`server/http.ts` | 写路由集合与 `openMemRoute()` 移到 api.ts；鉴权和分发共用同一个规范化路由 | R1-1 | — |
| `storage/schema.ts`、`store/sqlite/local-state.ts` | 新表 `pm_task_turns(task_id, turn_id)`；消息仍按会话唯一存一份，但每个提交它的任务都关联它；`taskTurns` / `contextTurns` 改按关联查；对已有 v10 库做一次回填 | R1-2 | v3 §2.2.2 |
| `pipeline/organize-job.ts` | `TOPIC_SET_CHANGED` 时把 `newTopicIds` 记入 `mustConsider`，下一次召回的候选强制包含它们 | R1-3 | v3 §2.3.1 |
| `organize/organizer.ts` | 作者由会话推出：用户消息的作者就是发言人；Agent 回复取本批中交办它的成员（模型给出的 user_ids 只在本批发言人范围内采信），否则取前一条用户消息的发言人 | R1-4 | v3 §2.2.9 |
| `project-memory/api.ts`、`service.ts` | `create/space` 只收 `space_name`；传 `space_id` 返回 40001；每次调用都生成新 id | R1-5 | Q-04 |
| `tests/service/project-memory/helpers.ts` | `setupSpace` 改经 store 建固定 id 的 Space（公开接口不再允许指定 id） | 测试需要固定 id | — |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过 |
| `cd Memory && npx vitest run tests/service/project-memory` | 6 个文件、25 个测试全部通过（新增 4 个，`http-contract` 改 1 处） |
| 逐项去掉修复再跑（`git stash push -- <源文件>`） | R1-1/R1-5：2 个失败；R1-2：1 个失败；R1-3：1 个失败；R1-4：1 个失败；恢复后全部通过 |
| `cd Memory && npx vitest run --dir tests`（全量） | 1477 通过、1 失败：`tests/build-standalone.test.ts` 缺 Node 24.22.1，与本改动无关（交接 01 已有） |

评测：未重跑。runner 需要跟着 `create/space` 契约改（由评测工作项 PM-03 同步修改）。

## 与规格的偏离和简化

- R1-4 的修复比评审要求更严：用户消息的作者固定为发言人，模型不能再把一条用户消息记给多人。共同作出的决策需要每个人各自发言或通过认可体现。
- 认可人（`approved_by`）没有要求本人在会话中发言：现有 golden 用例把「已和用户B 确认」当作认可。是否接受转述的认可，登记为 [open-questions Q-12](../../../docs/project-memory/open-questions.md)。合并时仍要求认可人是现行结论的成员。

## 评审回应

| 意见 | 级别 | 处理 | commit / 理由 |
| --- | --- | --- | --- |
| R1-1 | MUST | 已修复 | 59547700；测试 `requires write scope for write routes even with a trailing slash` |
| R1-2 | MUST | 已修复 | 59547700；测试 `organizes messages again for another space after they were stored for the first` |
| R1-3 | MUST | 已修复 | 59547700；测试 `shows topics another writer created to the model on the retry after TOPIC_SET_CHANGED`（先建 11 个词法命中的主题，并发新建的主题措辞无关） |
| R1-4 | MUST | 已修复 | 59547700；测试 `keeps a non-author's different conclusion in conflicts even when the model names the author`（两名成员在同一会话中） |
| R1-5 | MUST | 已修复 | 59547700；`http-contract` 中传 `space_id` 返回 40001、同名两次创建得到两个 id |
| R1-6～R1-15 | SHOULD | 未处理 | 留给下一轮；R1-9、R1-10 已登记 Q-09、Q-10 |
| R1-16 | NIT | 未处理 | |

## 请 reviewer 重点看

1. `Memory/src/service/project-memory/organize/organizer.ts` `draftAuthors()` — 作者推导是否过严，是否会让 Agent 回复的交办人判错
2. `Memory/src/storage/schema.ts` `pm_task_turns` 的回填语句 — 只在表为空时执行一次
3. `Memory/src/service/project-memory/pipeline/organize-job.ts` `mustConsider` — 已确认 `getTopicsFull`（`sqlite-store.ts:386`）会跳过不存在的 id，新主题在重试前被删除不会报错；请确认这种情况下不该改报 TOPIC_NOT_FOUND

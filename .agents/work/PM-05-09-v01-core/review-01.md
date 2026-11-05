---
item: PM-05-09-v01-core
seq: 01
role: reviewer
app: Claude Code（子代理，只读）
model: claude-opus-5-5
date: 2026-11-05
reviewed: handoff-01.md
range: 459a2972..44dcbb1e
verdict: changes-requested
---

# 评审 01：主体可用，5 项 MUST 需修复

## 复核验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过 |
| `cd Memory && npx vitest run tests/service/project-memory` | 6 个文件、21 个测试全部通过 |

## 上一轮 MUST 的关闭情况

无（第一轮）。

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | MUST | `Memory/src/server/http.ts:278-279`、`project-memory/api.ts:261` | 写权限按原始路径判断，路由分发前却去掉了末尾斜杠：只读 token 请求 `delete/space/`、`add/message/` 也能写 | 安全 | 两处用同一规范化路径，或在路由解析后再判读写 | 只读 principal 请求 `delete/space/` 返回 403 的 HTTP 测试 |
| R1-2 | MUST | `store/sqlite/local-state.ts:134-155`、`pipeline/organize-job.ts:91` | `pm_raw_turns` 唯一键不含任务 / Space，同一批消息再写到另一个 Space（或换 domains）时新任务拿到 0 条消息并报 completed | v3 §2.2.2；PRD 多空间各自整理 | 去重按任务进行（唯一键带 task_id 或用关联表） | 同一批消息先后写 Space A、B，B 也产生主题 |
| R1-3 | MUST | `pipeline/organize-job.ts:179-181`、`sqlite-store.ts:349` | TOPIC_SET_CHANGED 后重试忽略 `newTopicIds`，候选取 lexical 前 10，新主题可能不在候选里，导致重复新建 | v3 §2.3.1「拉取新主题的摘要与描述」 | 下次尝试必须把 `newTopicIds` 加入候选 | 超过 10 个词法命中 + 并发新建，最终只有 1 个主题 |
| R1-4 | MUST | `organize/organizer.ts:200, 228`、`merge/merge.ts:149` | 模型给出的 `approved_by`、`user_ids` 未校验：一次错误输出即可让非作者改写决策 | v3 §2.2.9；AGENTS.md 红线「非作者且未经认可只能进 conflicts」 | `approvedBy` 必须是该决策现有结论的成员；用户消息的作者必须包含发言人 `role_id`，或由规则推出 | 桩模型把他人消息的 user_ids 写成 content 作者，结果应为 conflict_append |
| R1-5 | MUST | `project-memory/api.ts:333-337`、`sqlite-store.ts:161-162` | `create/space` 接受调用方的 `space_id`，已存在时静默返回旧 Space、忽略新名称和 domain | open-questions Q-04（用户决定：只传 space_name，由 MemOS 生成 id，每次新建） | 只接受 `space_name` 并生成 id；测试同步修改 | 传 `space_id` 的请求返回 INVALID_PARAMS；两次同名创建得到两个 Space |
| R1-6 | SHOULD | `sqlite-store.ts:403` | 条件写用 deferred 事务，多进程写同库时报 SQLITE_BUSY 而不是 VERSION_CONFLICT | v3 L03 | 改为 `.immediate()` | |
| R1-7 | SHOULD | `repositories.ts` 约 3709、`organize-job.ts:75` | 失败任务会永久堵住该 Space 的串行队列；`recordSpaceOutcome` 在 try 之外 | | 整个任务放进 try，或该任务类型不把 failed 视为阻塞 | 构造一次失败，后续任务仍能执行 |
| R1-8 | SHOULD | `local-state.ts:215, 223` | 带不同时区的 ISO 字符串按文本比较排序 | | 存 UTC 排序键或比较毫秒 | |
| R1-9 | SHOULD | `merge.ts:137-142` | 迟交的 join 会把成员从更晚的结论里挪走；可能留下 user_ids 为空的 content | 规格空白 | 登记 open-questions，交 designer | |
| R1-10 | SHOULD | `merge.ts:111` | 先判 resolve 再判「结论相同」，与 v3 流程顺序相反 | v3 §2.2.9 | 登记到 spec-alignment | |
| R1-11 | SHOULD | `organizer.ts:208` | 超长输出被截断而不是拒绝，可能截断决策原意 | v3 限长「拒绝」 | 改为重试或推迟 | |
| R1-12 | SHOULD | `service.ts:205` | 多 Space 检索要求每个 domain 在每个 Space 都登记 | PRD「匹配任一」 | 放宽 | |
| R1-13 | SHOULD | `organize-job.ts:163` | 重放提交时 added/updated 报 0，且推迟片段重复写入 | | | |
| R1-14 | SHOULD | `apply.ts:110` | resolve 后 conflict seq 从 1 重新计，`conflict:N` 引用可能指错 | | seq 对每条决策单调递增 | |
| R1-15 | SHOULD | `service.ts:66` | 删除不存在的 Space 返回成功 | | 返回 SPACE_NOT_FOUND | |
| R1-16 | NIT | `organize-job.ts:47`、`api.ts` | `recallQuery` 过于绕；`decodeURIComponent` 可抛 URIError 变 500；history_backfill 按 seq 而非 time 排序 | | | |

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| typecheck、单测 | 满足 | 上表 |
| 409 后库不变；幂等重放 | 部分满足 | store 层有全表快照比对；没有 pipeline 层重跑与 `batch_key` 去重的测试 |
| PRD 决策逐轮表 golden | 部分满足 | 第 1–4 轮与 resolve 覆盖；缺迟交 join、conflict_update、经验 golden、进展去重 |
| Space 串行 | 部分满足 | scope_seq 有测试；失败后队头阻塞未测 |
| 检索确定性 | 满足 | 两次相同调用比对 |
| 旧行不进普通召回 | 部分满足 | 迁移测试有；没有跑一次 L1 检索证明 |

## 需要 designer / 用户裁决

- R1-9：迟交的 join 应否移动成员？结论被移空后谁能改写？
- R1-10：resolve 与「结论相同」的判定顺序。

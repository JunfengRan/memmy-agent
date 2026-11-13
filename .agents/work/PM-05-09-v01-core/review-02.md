---
item: PM-05-09-v01-core
seq: 02
role: reviewer
app: Cursor
model: grok-4.7-high-fast
date: 2026-11-10
reviewed: handoff-02.md
range: 44dcbb1e..59547700
verdict: approved
---

# 评审 02：五项 MUST 已关闭，可以通过

复核在独立 worktree `/tmp/pm-review-w46`（`3fe76c95`，含 `59547700` 之后的 `edd8ef86`、`dfd9c193`）里进行，没有在主工作区跑测试。交接声称的修复在该提交上仍在。

## 复核验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过，exit 0 |
| `cd Memory && npx vitest run tests/service/project-memory` | 7 个文件、31 个测试全部通过。交接写的是 `59547700` 上 6 个文件、25 个测试；其后选题实验和 relativity 单测把套件扩到 31，本轮按 HEAD 重跑，没有失败 |

全量 `vitest --dir tests` 本轮没跑。交接里 `build-standalone.test.ts` 缺 Node 24.22.1 的那条失败不在本次命令里。

`59547700` 到 `3fe76c95` 里，鉴权、`pm_task_turns`、`draftAuthors`、`create/space` 没有被改回去。`organize-job.ts` 在并入 `mustConsider` 之后多了 `narrowCandidatesWithJev`（`edd8ef86`），路由只在 `MEMMY_DECISION_TOPIC=1` 时存在，测试里默认关闭，R1-3 的默认路径仍会把 `newTopicIds` 放进下一次候选。

## 上一轮 MUST 的关闭情况

| 意见 | 结果（已关闭 / 未关闭 / 转裁决） | 说明 |
| --- | --- | --- |
| R1-1 | 已关闭 | `openMemRoute()`（`api.ts:30`）去掉末尾斜杠后，`http.ts:269` 的 `openMemRouteWrites()` 和 `api.ts:286` 的分发用同一个结果。`http-contract.test.ts:162` 对 `delete/space/`、`add/message/`、`create/space//` 用只读 token 期望 403，包含在本轮 31 个通过的测试里 |
| R1-2 | 已关闭 | `pm_raw_turns` 仍按会话去重；`pm_task_turns`（`schema.ts:843`）把每个任务连到已有 turn。`local-state.ts:144` 写入关联，`taskTurns`（`local-state.ts:221`）按关联读。回填只在关联表为空时跑一次（`schema.ts:849`），`migrate()` 每次打开都会执行语句，已有 v10 库也会建表。回归测试 `organizes messages again for another space...` 在套件内通过。`edd8ef86`、`dfd9c193` 没改这个表 |
| R1-3 | 已关闭 | `TOPIC_SET_CHANGED` 把 `newTopicIds` 放进 `mustConsider`（`organize-job.ts:189`），下一次召回用 `getTopicsFull` 强制并入（`organize-job.ts:131`）。不存在的 id 会被 `getTopicsFull` 滤掉（`sqlite-store.ts:386`），不抛 `TOPIC_NOT_FOUND`，这种跳过可以接受。回归测试在套件内通过 |
| R1-4 | 已关闭 | 用户消息的作者固定为发言人 `roleId`（`organizer.ts:283`）；Agent 回复只采信本批发言人，否则回退到前一条用户消息（`organizer.ts:284`）。`approvedBy` 不直接相信模型：改写仍要求与现行结论的 `userIds` 相交（`merge.ts:149`）。回归测试把 user_b 的消息标成 user_a，结论进 `conflicts`，在套件内通过 |
| R1-5 | 已关闭 | `create/space` 见到 `space_id` 返回 `INVALID_PARAMS`（`api.ts:360`）；`service.createSpace` 每次生成新 id（`service.ts:57`）。`http-contract.test.ts:128` 覆盖传 id 得 40001、同名两次得到两个 id |

上一轮 SHOULD（R1-6～R1-15）和 NIT（R1-16）未在本轮复核范围。R1-9、R1-10 仍登记为 Q-09、Q-10，本轮不改它们的状态。

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R2-1 | SHOULD | `docs/project-memory/spec-alignment.md:21`、`docs/project-memory/spec-alignment.md:22` | §2.2.9 仍写「作者与 approved_by 未校验」，§2.2.10 仍写「TOPIC_SET_CHANGED 未带 newTopicIds」。这两句描述的是 R1-3、R1-4 修复前的行为。`dfd9c193` 给 §2.2.10 追加了 Q-15、Q-16，没有删掉旧句 | AGENTS.md「文档随代码」。对齐表会被后面的评审当成缺口清单 | 这两格改成现在的行为：作者由会话推出，认可人必须和现行结论相交才能改写；`TOPIC_SET_CHANGED` 会把 `newTopicIds` 放进下一次候选。deferred 事务、Q-15、Q-16 可以留着 | 读这两行，不再出现已经修好的否定句 |

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| typecheck 通过；`tests/service/project-memory` 全部通过 | 满足 | 上表，31/31 |
| 条件写：409 后库不变；同一幂等键重放不产生副本（store 层） | 部分满足 | 沿用 review-01：store 层有全表快照比对。本轮没有新开 pipeline 层重跑测试的意见 |
| PRD「决策的维护」逐轮表 golden 通过（split 除外） | 部分满足 | 沿用 review-01。本轮套件仍包含 `decision-golden.test.ts` 且通过，没有补迟交 join、经验 golden |
| 同一 Space 串行；检索确定性 | 部分满足 | 沿用 review-01。失败后队头阻塞仍是未处理的 R1-7 |
| project 行不再进入普通 L1 召回（迁移层面） | 部分满足 | 沿用 review-01，本轮没有另跑 L1 检索 |
| 评审 MUST 全部关闭 | 满足 | R1-1～R1-5 已关闭，本轮没有新的 MUST |
| 数据集 v2 上跑出首批数（见 metrics.md） | 满足 | `metrics.md` 的 R-20261105-01、R-20261105-02。handoff-02 自己没重跑；R-20261105-02 由 PM-03 在含 `59547700` 的服务上写入 |

## 需要 designer / 用户裁决

无。R1-9、R1-10 已在 Q-09、Q-10，本轮没有新问题。

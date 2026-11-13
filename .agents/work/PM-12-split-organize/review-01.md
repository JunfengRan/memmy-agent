---
item: PM-12-split-organize
seq: 01
role: reviewer
app: Cursor
model: claude-sonnet-5-5-medium
date: 2026-11-10
reviewed: handoff-01.md
range: 6a6e194c..018c169a
verdict: approved   # approved | changes-requested | blocked
---

# 评审 01：拆分实现与规格一致，无 MUST，数据集 v2 复测未完成属已知事实

## 复核验证

在独立 worktree（`git worktree add /tmp/pm-review-pm12 018c169a`）里重跑。worktree 没有 `node_modules`，把主工作区 `Memory/node_modules` 和根 `node_modules` 软链进去，源码和测试都是 018c169a 的。跑完已 `git worktree remove --force`。

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | exit 0 |
| `cd Memory && npx vitest run tests/service/project-memory` | exit 0；8 个文件、36 个测试全部通过。与 handoff 的 8 文件 36 测试一致 |
| `docs/project-memory/metrics.md` 在 6a6e194c..018c169a 的改动 | 无。没有 PM-12 产品回放的新分数。R-20261110-01、R-20261110-02 是金标灌库检索延迟和阅读模型上限，不是 PM-12 的产品回放，handoff 也没有引用它们 |

## 上一轮 MUST 的关闭情况

无。

| 意见 | 结果（已关闭 / 未关闭 / 转裁决） | 说明 |
| --- | --- | --- |
| 无 | 不适用 | 第一轮 |

## 意见

对 handoff「请 reviewer 重点看」5 条的核对：

1. VERSION_CONFLICT 只重跑判断（`organize-job.ts:261`）：`judgeReady = false`，`extracted` 和 `assigned` 保留；`organize-pipeline.test.ts` 的并发写测试断言第二批 extract 1 次、assign 1 次、judge 2 次。成立。
2. TOPIC_SET_CHANGED 清归属、留抽取、newTopicIds 进 mustConsider（`organize-job.ts:265`）：成立。`resolveMergeCandidates` 与 `keepMustConsider` 都保证 mustConsider 不受并集上限 20 约束；`TOPIC_SET_CHANGED` 测试断言 extract 只多一次（来自播种批）。
3. `organize/assign.ts`：请求体候选只有 `topic_id`、`domain`、`topic_summary`、`topic_description`；未知 `topic_id` 进 deferred（`unknown_topic`），不新建。成立。
4. `merge/merge.ts`：basis 以 `opBases` 返回在 `MergeOutcome` 旁，没有写进 ChangeSet 的 op；`details` 只进 `progress_json`，有测试断言 `get/status` 不返回。成立。
5. 默认路径不调用决策模型：`deps.decision` 缺省时 `narrowCandidatesWithJev` 直接返回候选；选题实验在 M04 之前收窄，且 mustConsider 在收窄之后补回。成立。

红线核对：模型调用只在 M02、M04、M05；排序用最好名次加 topicId 字典序，确定；OCC 最多 3 次、不重放旧 ChangeSet；归类失败推迟而不是保守新建。无违反。

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | SHOULD | `docs/project-memory/ROADMAP.md` PM-12 行 | 状态写成 done，但该行的验收「归类准确率、重复主题率有数」没有数。括号里已写明复测未完成，但状态字面仍是 done，扫表的人会漏看 | item.md 验收「数据集 v2 复测」未勾；AGENTS.md「文档随代码」要求条目状态如实 | 阅读模型网关恢复后补跑数据集 v2，把 R-ID 写进 metrics.md 和该行；在此之前把状态写成「实现完成，待复测」一类的中间态，或在 PM-13 前置里列出这项复测 | 复测后 `metrics.md` 出现带 PM-12 提示词版本（extract 0.2.0、assign 0.2.0、judge 0.2.0）的新行，G-02/03/04/08/09 状态随之更新 |
| R1-2 | NIT | `docs/project-memory/decisions/0007-split-organize-stages.md` 决定 1 | 「模型如果标了 `restatement` 就收下」没有说明收下之后是否影响 `dropped` 计数以外的行为 | ADR-0005 #3 与 PM-15 | 在 PM-15 的 ADR 里说明与 recall_log 比对时如何处理模型自标的 `restatement` | PM-15 评审时核对 |

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| `npm --prefix Memory run typecheck` 通过 | 是 | 本次重跑 exit 0 |
| `cd Memory && npx vitest run tests/service/project-memory` 通过（8 个文件，36 个测试） | 是 | 本次重跑 exit 0，8 文件 36 测试 |
| 三个提示词带版本号，旧 `prompts/organize.ts` 已删除 | 是 | diff 中新增 `prompts/extract.ts`、`assign.ts`、`merge-judge.ts`，`prompts/organize.ts` 删除 |
| 每个任务只抽取一次；`TOPIC_SET_CHANGED` 不重抽；`VERSION_CONFLICT` 不重抽、不重归类 | 是 | `organize-job.ts` 的 `extracted` 缓存与 `case` 分支；`organize-pipeline.test.ts` 的 extract / assign / judge 次数断言 |
| `get/status` 不返回 `details` | 是 | `organize-stages.test.ts` 的 progress_json 用例 |
| 默认路径不调用决策模型 | 是 | `decision` 缺省即不调用；`decision-golden.test.ts` 在 diff 内且通过 |
| 数据集 v2 复测 | 否，已知事实 | 阅读模型 claude-haiku-5-5 网关 503；handoff 如实写「未完成」「没有新指标」，`metrics.md` 无改动，未把没跑的评测说成跑了，不构成 MUST |

## 需要 designer / 用户裁决

无。

---
item: 20261106-review-triage
seq: 01
role: reviewer
app: Cursor
model: grok-4.7-high-fast
date: 2026-11-10
reviewed: handoff-01.md
range: 64c5397c..dfd9c193
verdict: approved
---

# 评审 01：分诊和 relativity 修复可以通过

代码复核在独立 worktree `/tmp/pm-review-w46`（`3fe76c95`，含 `dfd9c193`）里进行。项目记忆测试与 PM-05 的 review-02 是同一次运行，没有再跑一遍。

## 复核验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过，exit 0。与 PM-05 review-02 同一次，worktree 为 `3fe76c95` |
| `cd Memory && npx vitest run tests/service/project-memory` | 7 个文件、31 个测试全部通过。含 `search.test.ts` 的 `filters relativity on each topic's own relevance and keeps the list monotonic`。与 PM-05 review-02 同一次，不重复计数 |

评测未跑，与交接一致：回放不传 `relativity`。

`assignRelativity`（`search.ts:112`）先按四位小数的自身相关度过滤阈值，再取累计最小值作为显示值。保留项的显示值不会低于阈值，列表不上升。用例是弱 0.4、强 0.9、噪声 0.2，阈值 0.5 时只留下 strong，显示 0.9（`search.test.ts:92`）。`recallQuery` 改为 `clampText`（`organize-job.ts:51`），按码点截断。

对照 v3 只核了对交接结论有影响的几条，没有展开 PM-12 及以后的实现：

- Add-1：`idempotencyKey` 仍是 Space、会话、本批 hash（`organize-job.ts:106`），与 v3 §4.8 的幂等键一致。任务批次键在推断时间上写成 null（`service.ts:230`），所以缺 `chat_time` 的同一句话会拿回旧任务。偏差在批次键，不在 `idempotency_key`。Q-15 的提议和 v3 §2.2.2 的到达时间去重一致，网络重试和「两次到达是两条消息」之间的差别值得留给 designer。
- Add-2：`commitAttempts` 是 3（`limits.ts:20`），`VERSION_CONFLICT` 和 `TOPIC_SET_CHANGED` 共用这一次循环（`organize-job.ts:118`），与 v3 §2.3.1「次数 < 3」一致。失败路径在 `runOrganizeJob` 的 catch 里返回 failed，不写 deferred。失败批次无法重交是另一件事，Q-16 和「重放返回原 task_id」有张力，交给 designer 合适。
- Add-3：v3 §4.5 写明相关草稿丢弃、不为已删除主题重建。分诊表说不改，和规格一致。
- Search-3：单调性是 v3 §3.2.5 的验收。阈值改到每条主题自己的相关度上，显示值仍是累计最小值，单调性还在。

Q-15～Q-21 的提议没有把 v3 已经写死、又落在本工作项范围内的改动推给 designer。PM-12、PM-13、PM-16、PM-19～PM-22 的实现不在本项范围。Q-18、Q-19 在随后的 `c6284d95` 里改成暂缓，和本交接「先登记」不冲突。

`spec-alignment.md:22` 仍写着「TOPIC_SET_CHANGED 未带 newTopicIds」。这句在 `59547700` 之后已经不成立；`dfd9c193` 只在同一格追加了 Q-15、Q-16。记在 PM-05 review-02 的 R2-1，这里不另开一条。

## 上一轮 MUST 的关闭情况

无。

| 意见 | 结果（已关闭 / 未关闭 / 转裁决） | 说明 |
| --- | --- | --- |
| 无 | — | 第一轮 |

## 意见

无新意见。

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| relativity 阈值按每个主题自身相关度过滤，返回列表仍单调（`search.test.ts`）；旧逻辑下该用例失败 | 满足 | `assignRelativity` 先滤自身相关度再取累计最小值。本轮 31 个测试含这条单测且通过。交接里「改回先累计再过滤则新用例失败」本轮没有再拆代码复现，现行实现和该用例的断言一致 |
| typecheck 通过；`tests/service/project-memory` 全部通过 | 满足 | 上表，与 PM-05 review-02 同一次 |
| 每条意见有结论和去向 | 满足 | `item.md` 分诊表 17 行都有结论和去向。抽查的 Add-1、Add-2、Add-3、Search-3 与 v3 和当前代码一致 |
| 用户确认 Add-3、Search-2、Search-5 的不同意见（11/06：Add-3、Search-5 按 v3 不改；Search-2 挂 Q-19 等 designer） | 满足 | 分诊表写了这三条。Search-2 在 Q-19；Q-19 后来被标成暂缓，仍不是改检索契约 |
| 提交并写 handoff（`dfd9c193`，handoff-01.md） | 满足 | `64c5397c..dfd9c193` 含 `search.ts`、`organize-job.ts`、`search.test.ts`、Roadmap、Q-15～Q-21、对齐表两行、ADR-0005 补记，以及本工作项的 `item.md` |

## 需要 designer / 用户裁决

无。需要设计决定的点已经在 Q-15～Q-21。

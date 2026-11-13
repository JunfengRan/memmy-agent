---
item: 20261111-trace-rca
seq: 01
role: reviewer
app: Cursor
model: grok-4.7
date: 2026-11-11
reviewed: handoff-01.md
range: 81008be7..6a41fcb2
verdict: approved
---

# 评审 01：追踪不进产品契约，错题证据对得上档案

## 复核验证

亲自跑了 selftest 和 typecheck。评测重跑的完整性看了 `trace/` 里的计数，并抽查了 q04、q06、q07、q14、q15、q16、q42 的进度字段，和归因里的丢弃原因一致。q04 的金标整句 `locations` 为空，conflicts 里的同义句被词面门槛滤掉，分类 `search_entry_filter` 成立。

| 命令 | 结果 |
| --- | --- |
| `node selftest.mjs` | 22/22 通过 |
| `npm --prefix Memory run typecheck` | 通过 |

## 上一轮 MUST 的关闭情况

无。

| 意见 | 结果（已关闭 / 未关闭 / 转裁决） | 说明 |
| --- | --- | --- |
| 无 | — | 第一轮 |

## 意见

无 MUST。追踪记录在请求开始时取上下文，避免慢响应被打到下一个任务上。用量 JSONL 仍不含提示词。

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| 未设追踪库时行为不变 | 是 | `createLiveTrace` 在路径为空时返回 null；selftest 原有用例仍过 |
| 不写请求头、不进 git | 是 | `buildTraceRecord` 只留 model、messages 和三个生成参数；`runs/` 已忽略 |
| 排序一致 | 是 | selftest 与 vitest |
| 错题有归因 | 是 | `docs/project-memory/rca/2026-11-11/` |

## 需要 designer / 用户裁决

Q-36：哪些助手回复算约定、哪些算局部实现。回复前不改 M02。

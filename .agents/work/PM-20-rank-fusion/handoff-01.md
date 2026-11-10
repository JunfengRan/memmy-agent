---
item: PM-20-rank-fusion
seq: 01
role: developer
app: Cursor
model: grok-4.7-xhigh-fast
date: 2026-11-10
branch: dev-project-memory-add-search-dev
base: 44f1dedd
head: b78996ac
to: reviewer
status: ready-for-review
---

# 交接 01：三路按名次融合

## 结论

三路召回按名次做 RRF（k=60），不再比较各路原始分数。relativity 是本次融合分除以本次最高分，返回列表按输出顺序单调。公开结果没有 `score`。列表名仍是 `user_memory` 和 `agent_memory`。过期向量仍让整次项目召回退回词法。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `retrieve/fuse.ts` | 跨路 RRF、阈值、MMR、截断 | 同一输入必须同一输出 | v3 §3.2.5、Q-01、Q-20 |
| `retrieve/search.ts`、`recall-paths.ts` | 路内排序后交给融合；召回记录只记返回的主题 | 融合前丢掉没有快照的主题 | v3 §3.2.5 |
| 测试 | 分数放大不改变结果；单调；没有 score | 验收 | v3 §3.5 |
| Q-29、Q-30 | 列表名和整次退词法待回复 | 规格没定名；§3.5.1 要求整次降级 | Q-29、Q-30 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过，exit 0（交接前重跑） |
| `cd Memory && npx vitest run tests/service/project-memory tests/service/retrieval/recall-candidates.test.ts` | 16 个文件、135 个测试通过、1 个既有 todo |

评测：未跑。提示词未改。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| relativity 被压在较窄区间，0.99 只可能留下第一名 | Q-01，spec-alignment |
| 平手顺序是用户记忆、agent 记忆、project | spec-alignment |
| 列表名未改成 memory_detail_list | Q-29 |
| 一条过期向量仍让整次退词法 | Q-30，ADR-0005 #11 |
| 条目裁剪仍只用词法 | ADR-0005 #6 未全部收回 |

## 评审回应

无。

## 请 reviewer 重点看

1. `Memory/src/service/project-memory/retrieve/fuse.ts` — 融合只用名次。
2. 阈值在 MMR 之前，展示值仍按输出顺序取累计最小。
3. 只查 project 时第一名不变。
4. `sqlite-store.ts` 的过期向量逻辑没有改。
5. `recall_log.via` 仍是 `turn_start`。

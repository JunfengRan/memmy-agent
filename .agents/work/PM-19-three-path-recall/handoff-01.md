---
item: PM-19-three-path-recall
seq: 01
role: developer
app: Cursor
model: grok-4.7-xhigh-fast
date: 2026-11-10
branch: dev-project-memory-add-search-dev
base: 31f59624
head: 6ad531fa
to: reviewer
status: ready-for-review
---

# 交接 01：三路召回

## 结论

`search/memory` 会并行召回用户记忆、agent 的 L1/Skill 和 project。请求了但失败的路写入 `degraded`。只请求 project 时，主题列表和召回记录与原来一致。跨路融合、relativity 和 `memory_detail_list` 还没做。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `retrieve/recall-paths.ts` | 三路并行，超时和失败只降级那一路 | 缺一路不能假装没有记忆 | v3 §3.2.3 |
| `retrieval-service.ts` `recallCandidates` | 复用现有检索，关掉模型过滤、改写和墙钟 | 同一输入必须同一输出 | Q-20 |
| `plugin-algorithms.ts` | 可选关掉 MMR，按相关度取前 K | ② 路不能再被墙钟和 MMR 打乱 | Q-20 |
| `api.ts` | 解析 `include_memory_view` | 本机视图名 | Q-28 |
| ADR-0005 补记、Q-20、Q-28 | 三路已收回；融合仍是 PM-20 | 记录提议 | ADR-0005 #6 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过，exit 0（交接前重跑） |
| `cd Memory && npx vitest run tests/service/project-memory tests/service/retrieval/recall-candidates.test.ts` | 15 个文件、123 个测试通过、1 个既有 todo |

评测：未跑。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| 用户记忆的视图名是 `user_memory`；降级通道名按路 | Q-28 |
| ② 路不调模型、不用墙钟；融合仍未做 | Q-20，PM-20 |
| ③ 路一条过期向量仍让整次退成词法 | ADR-0005 #11，PM-20 |

## 评审回应

无。

## 请 reviewer 重点看

1. `Memory/src/service/project-memory/retrieve/recall-paths.ts` — 请求了的路要么有结果，要么在 `degraded`。
2. `Memory/src/service/retrieval/retrieval-service.ts` 的 `recallCandidates` — 不发 chat 请求，不读墙钟。
3. 只请求 project 时，现有 search 测试仍通过。
4. `preference` 等云端种类返回 `MODE_UNSUPPORTED`，不算降级。
5. `get/status` 和 add 路径没有被这次检索改动带偏。

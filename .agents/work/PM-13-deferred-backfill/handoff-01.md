---
item: PM-13-deferred-backfill
seq: 01
role: developer
app: Cursor
model: grok-4.7-xhigh-fast
date: 2026-11-10
branch: dev-project-memory-add-search-dev
base: c6f1f842
head: 7bc8ca04
to: reviewer
status: ready-for-review
---

# 交接 01：同一会话回填推迟片段

## 结论

同一调用方会话、同一 Space 的下一次整理会把未解决的推迟片段和本批一起再判。模型用 `df<id>` 认领后删除原行，时间和作者取自原来的那一轮。`topic_unavailable` 和清空前受理的行不再进入抽取。单测通过。回填率没有新的评测数字，G-01 仍是 fixing。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `store/sqlite/local-state.ts` | `pendingDeferred`、`settleDeferred`、`forgetDeferred` | 认领后删行，失败不写 | v3 §2.2.7 |
| `prompts/extract.ts`、`organize/extract.ts` | 提示词升到 `pm-extract-v0.2.1`，输入带原始轮次和 `df<id>` | 模型要能认领旧片段 | v3 §2.2.7 |
| `organize/organizer.ts`、`assign.ts`、`merge/merge.ts` | 草稿带 `backfillOf`，穿过归属和合并 | 重试不能丢掉认领关系 | v3 §2.3.1 |
| `pipeline/organize-job.ts` | 抽取前装载，完成时结算；幂等键不含回填 id | 崩溃重放仍能删行 | v3 §2.2.10 |
| `service.ts` | 清空 Space 时丢掉推迟行 | 清空前的内容不能写回 | v3 §4.5 |
| `open-questions.md` Q-22、ADR-0005 补记 | 记下上限 10、清空围栏、未指向主题的片段仍回填 | 规格没写这些细节 | Q-22 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过，exit 0（交接前重跑） |
| `cd Memory && npx vitest run tests/service/project-memory` | 10 个文件、65 个测试全部通过 |

评测：未跑。阅读模型网关 2026-11-10 返回 503。`metrics.md` 没有新记录。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| 每次最多回填最近 10 行 | Q-22 |
| 删除具体主题之前就推迟、且从未指向主题的片段仍然回填 | Q-22 |
| `domain_unresolved` 可以回填进本次请求的 domain | Q-22 |
| 幂等键不含回填 id | PM-16，有意不改 |

## 评审回应

无。

## 请 reviewer 重点看

1. `Memory/src/service/project-memory/pipeline/organize-job.ts:214` — 结算发生在任务完成时，失败路径不调用。
2. `Memory/src/service/project-memory/pipeline/organize-job.ts:202` — 幂等键不含回填 id，重放仍能删行。
3. `Memory/src/service/project-memory/store/sqlite/local-state.ts:294` — `pendingDeferred` 排除 `topic_unavailable` 和清空前受理的行。
4. `Memory/src/service/project-memory/organize/extract.ts` — 每个 ref 只留第一条草稿，未知 ref 丢弃。
5. `Memory/src/service/project-memory/service.ts:184` — 清空 Space 会丢掉推迟行。

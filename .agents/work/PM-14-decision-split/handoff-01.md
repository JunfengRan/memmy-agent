---
item: PM-14-decision-split
seq: 01
role: developer
app: Cursor
model: grok-4.7-xhigh-fast
date: 2026-11-10
branch: dev-project-memory-add-search-dev
base: 8be9055a
head: bb2f0a70
to: reviewer
status: ready-for-review
---

# 交接 01：补上决策 split

## 结论

决策现在有 `split`。`conflict_update`、`resolve` 和「已告知」的规则没有改，只加了 golden。内容作者转入已有分歧、从而把 content 成员挪空的路径没有改，记在 Q-23，对应用例是 `it.todo`。评测未跑。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `contract/types.ts`、`store/sqlite/apply.ts`、`sqlite-store.ts` | `split` op；原 id 保留一次，其余新建 | 历史只追加，原行不能删 | v3 §2.2.9 |
| `merge/merge.ts`、`merge/judge.ts`、`prompts/merge-judge.ts` | 判断提示词升到 `pm-judge-v0.3.0`；split 排在「结论相同」之前 | 与 resolve 同一顺序 | v3 §2.2.9、Q-10 |
| `organize/organizer.ts` | 透传 split，保留 `backfillOf` | 不拆掉 PM-13 | — |
| `decision-golden.test.ts`、`store-commit.test.ts` | conflict_update、resolve、informed 半边、split 回滚 | 验收要求 golden | v3 §2.2.9 |
| ADR-0005 补记、Q-23 | 第 1 条由 PM-14 收回；G-06 的 join 路径不改 | 规格没写成员被挪空时怎么办 | Q-23 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过，exit 0（交接前重跑） |
| `cd Memory && npx vitest run tests/service/project-memory` | 10 个文件、76 个测试通过、1 个 todo |

评测：未跑。阅读模型网关 2026-11-10 返回 503。`metrics.md` 没有新记录。判断提示词升了版本，复测仍欠着。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| 保留原 id 的是 `from` 含 `content` 的那一项，否则第一项；每一片 history 都写入原内容和全部 conflict | ADR-0005 2026-11-10 补记；spec-alignment §2.2.9 |
| 内容作者加入已有 conflict 时仍走 join，可能挪空 content | Q-23，未改代码 |
| 复述过滤仍未接到整理任务 | PM-15 |

## 评审回应

无。

## 请 reviewer 重点看

1. `Memory/src/service/project-memory/store/sqlite/apply.ts` — split 必须包含原 id 恰好一次，否则 STRUCTURE_VIOLATION，整次提交回滚。
2. `Memory/src/service/project-memory/merge/merge.ts` — split 与 resolve 都在「结论相同」之前。
3. `Memory/src/service/project-memory/merge/judge.ts` — split 与 resolve 同时出现时只留 resolve；有效项少于 2 时 split 为空。
4. Q-23 的用例是 `it.todo`，join 行为没有变。
5. `backfillOf` 仍从抽取穿到合并。

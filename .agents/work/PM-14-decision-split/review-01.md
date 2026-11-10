---
item: PM-14-decision-split
seq: 01
role: reviewer
app: Cursor
model: claude-sonnet-5-5-medium
date: 2026-11-10
reviewed: handoff-01.md
range: 8be9055a..bb2f0a70
verdict: approved
---

# 评审 01：split 实现符合 v3 §2.2.9 与 Q-10，无 MUST

## 复核验证

在独立 worktree（bb2f0a70，node_modules 软链）里重跑，已移除 worktree。

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | exit 0 |
| `cd Memory && npx vitest run tests/service/project-memory` | exit 0；10 个文件，76 通过，1 todo，与 handoff 一致 |
| `git diff 8be9055a..bb2f0a70 -- docs/project-memory/metrics.md` | 无改动，没有拿新分数冒充；判断提示词升到 `pm-judge-v0.3.0` 后的复测仍欠着，handoff 已写明 |

## 上一轮 MUST 的关闭情况

无（第一轮）。

| 意见 | 结果 | 说明 |
| --- | --- | --- |
| — | — | — |

## 重点 5 条核对

1. `store/sqlite/apply.ts` 的 `applySplit`：少于 2 片、没有 conflict、原 id 出现次数不是 1、片内重复、内容为空或超长、新 id 已存在，都抛 STRUCTURE_VIOLATION。`sqlite-store.ts` 里与 staged 决策、库内 id 一并查重，抛错在同一事务内，整笔回滚；`store-commit.test.ts` 有对应用例。每一片 history 都写入原内容和全部 conflict，只追加，没有删行，符合「history 只追加」。
2. `merge/merge.ts`：split 与 resolve 都排在 `sameAs` 之前，条件同为 informed、非迟交、有 conflict。informed 仍由 `conflictsShown` 与判断返回的 informed id 同时成立得出（第 343 行）。
3. `merge/judge.ts`：`resolve` 解析成功时 `split` 置 null；`parseSplit` 少于 2 片返回 null；`from` 只收真实存在的 conflict 序号。
4. Q-23 为 `it.todo`，没有改 join；符合 handoff 范围。
5. `organizer.ts` 透传 `split`，`backfillOf` 未动。

红线核对：没有新增模型调用点（只改 M05 判断提示词），排序无变化；split 不改时间更晚的决策（`!late`）；提示词升了版本；示例用推送重试，不取自评测集领域；改动在 `project-memory/` 内，没有碰 `memory-service.ts`。

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | SHOULD | `merge/merge.ts:140-160`（`splitDecision`） | 保留原 id 的片取「第一个引用 `content` 的片，否则第一片」。若模型把 `content` 对应的片排在后面、且另一片 `from` 为空，成员归属会按 resolver 算，行为只由模型给的顺序决定。ADR-0005 补记已写明规则，但没有用例覆盖「content 片不在第一位」。 | v3 §2.2.9（不推断成员）；`decision-golden.test.ts` | 补一个 content 片排第二的 golden，固定保留 id 与 userIds | `npx vitest run tests/service/project-memory/decision-golden.test.ts` |
| R1-2 | SHOULD | `merge/merge.ts:151` | `authors[0]!` 在草稿无作者时会把 `undefined` 传给 `displayName`。与 resolve 分支（第 179 行）写法相同，属已有模式，不是本次新引入，但 split 多了一处。 | 防御性 | 抽取作者为空时的统一处理，或在入口断言 | 加一个无 userIds 的草稿用例 |
| R1-3 | NIT | `judge.ts` `parseSplit` | 内容为空的片被静默丢弃，可能让 3 片变 2 片。可以接受，建议在注释里写明。 | — | 可选 | — |

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| conflict_update：作者改自己的 conflict，content 不变，无 history | 满足 | `decision-golden.test.ts` 新用例，76 通过 |
| conflict_update 带加入者 | 满足 | 同上 |
| 已告知后 resolve pick "new" / "content" | 满足 | 同上 |
| 检索展示过分歧后 split；未检索则不 split，走 rewrite | 满足 | `merge.ts:204` 要求 informed；golden 覆盖 |
| had_conflicts 与 informed id 缺一不 resolve；草稿等于 conflict 时仍 resolve | 满足 | golden 覆盖 |
| 超长片、已有 id、缺保留 id、只有一片、无 conflict 的 split 整笔不写 | 满足 | `store-commit.test.ts` 新增 89 行 |
| G-06 join 清空 content（Q-23） | 不要求，已按 it.todo 记录 | Q-23 |
| 评测未跑 | 已如实记录，不计 MUST | `metrics.md` 无改动 |

## 需要 designer / 用户裁决

无。Q-23（内容作者 join 已有分歧时挪空 content）仍待 designer 答复。

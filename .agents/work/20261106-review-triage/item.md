---
id: 20261106-review-triage
status: ready-for-review
owner: reviewer（待接手）
roadmap: PM-12、PM-13、PM-16、PM-19～PM-22（只登记）；relativity 阈值修复无对应条目
branch: dev-project-memory-add-search-dev
updated: 2026-11-06
---

# v0.1 add / search 评审意见分诊

## 目标

用户转来 17 条 add / search 评审意见。逐条对照 v3 与 Roadmap：已排期的写明在哪个条目、哪一周做；与 v3 冲突的写明依据，交用户确认；需要设计决定的写进 open-questions；其余直接修。

## 范围

- 包含：relativity 阈值修复、`recallQuery` 写法（NIT）、Roadmap / open-questions / 对齐表 / ADR-0005 补记。
- 不包含：PM-12、PM-13、PM-16、PM-19～PM-22 的实现。

## 规格出处

- 架构文档 v3 §2.2.2、§2.2.6、§2.2.10、§2.3.1、§3.2.2–§3.2.5、§3.3.4–§3.3.5、§3.5、§4.5、§4.10、§5.3
- ADR-0005；open-questions Q-01、Q-15～Q-21

## 分诊结果

| # | 意见 | 结论 | 去向 |
| --- | --- | --- | --- |
| Add-1 | 幂等键只看内容 | `idempotency_key` 的写法与 v3 §2.2.10 一致；同会话同角色同时间同内容按重放处理，符合 §2.2.2 去重口径。真正的偏差在任务批次键：缺 `chat_time` 时推断时间不进批次键，同一成员再次发同样的文字会拿回旧任务 | PM-16（W46），Q-15 |
| Add-2 | TOPIC_SET_CHANGED 重试成本高、失败时 deferred 不落盘 | 3 次共用预算是 v3 §2.3.1 的写法；成本高是因为 M02 / M04 合在一次调用（ADR-0005 #2）。失败时不写 deferred 符合「失败不写任何内容」，真正的缺口是失败批次无法重交 | PM-12（只重跑 M04）、PM-16（W46），Q-16 |
| Add-3 | TOPIC_NOT_FOUND 不重新归类 | 与 v3 冲突：§4.5 规定「相关草稿丢弃，不为已删除的主题重建」。不改；PM-13 回填时要排除 `topic_unavailable` | PM-13（W46） |
| Add-4 | `recallQuery` 写法（NIT） | 已改用 `clampText`。不用 `String.slice`：它按 UTF-16 截断，会切开代理对 | 已修 |
| Add-5 | 召回漏掉候选会新建重复主题 | K=10 是 v3 §2.3.2 的上限；merge 召回已是词法 + 向量 + 小空间补最近主题。真正的偏差是 v0.1 整批只出一条 query，v3 §2.2.6 要求每条草稿一条 | PM-12（W46）；重复主题率由 PM-17 的相似名称对照组测 |
| Search-1 | 按时间窗口检索 | v3 没有此入口，按规则不算缺口 | Q-18 |
| Search-2 | 决策级 source_refs | 与 v3 冲突：§3.2.2 规定检索不返回 `sources`，§5.3 的 `decisions` 表没有会话字段。现有路径是 `get_memory_by_id` → 主题 `sources` → `get_message` | Q-19 |
| Search-3 | relativity 累计最小值把更相关的主题滤掉 | 确认是缺陷。单调性是 v3 §3.2.5 的要求，保留；阈值改为按每个主题自身相关度过滤 | 已修；归一方法 PM-20（W47） |
| Search-4 | recall_log.via 一律 turn_start | 确认。ADR-0005 #9 只覆盖 `session_start`，已补记 | PM-21（W47），Q-17 |
| Search-5 | 多 Space 并行搜索 | 与 v3 冲突：`search_memory` 的入参是 `space_ids`，§3.2.2「只在传入空间检索」，§4.10 支持多空间；检索范围由宿主绑定（§3.3.5）。不改 | 用户确认按 v3 保留（11/06） |
| Search-6 | 两套排序策略不能直接拼接 | 同意；v3 §3.5.1 只按名次融合 | PM-19 / PM-20（W47），Q-20 |
| Search-7 | contextBudget 未生效 | 确认，但在旧的 agent memory 检索（`retrieval-service.ts`），不在项目记忆里；v3 的预算在 M10（`budget_tokens`） | PM-19 / PM-22（W47），Q-20 |
| Search-8 | 工具名与数据对不上 | 确认：`memmy-memory search` 查个人记忆，`search_project_memory` 未注册 | PM-21 / PM-22（W47） |
| Search-9 | 显式检索被记成一轮开始 | 同 Search-4 | PM-21（W47），Q-17 |
| Search-10 | 没有渐进展开 | `level=summary|body`、`expand(...)`、代码锚点、`_index.md` 来自历史方案，v3 没有采纳，不算缺口。v3 的渐进式披露是会话开始索引 + 每轮记忆 + 工具检索 + `get_memory_by_id`；决策带全部 `history` 与 `conflicts` 是 §3.2.5 的要求 | PM-21（W47） |
| Search-11 | had_conflicts 会改变之后的整理 | 有意：v3 §3.2.5 把 recall_log 用于判定「已告知」。实现还要求 M02 的 `informed` 信号（`merge.ts` 中两者同时成立），只召回不算 | 不改 |
| Search-12 | 向量静默降级 | 返回体带 `degraded` 符合 v3 §3.2.3；缺的是宿主可见的渲染 | PM-22（W47），Q-21 |

## 验收标准

- [x] relativity 阈值按每个主题自身相关度过滤，返回列表仍单调（`search.test.ts`）；旧逻辑下该用例失败
- [x] typecheck 通过；`tests/service/project-memory` 全部通过
- [x] 每条意见有结论和去向
- [x] 用户确认 Add-3、Search-2、Search-5 的不同意见（11/06：Add-3、Search-5 按 v3 不改；Search-2 挂 Q-19 等 designer）
- [x] 提交并写 handoff（dfd9c193，handoff-01.md）

## 相关工作项

- [PM-05-09-v01-core](../PM-05-09-v01-core/item.md)

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-06 | in-progress | developer / Cursor（Claude Opus） | item.md |
| 2026-11-06 | ready-for-review | developer / Cursor（Claude Opus） | handoff-01.md |

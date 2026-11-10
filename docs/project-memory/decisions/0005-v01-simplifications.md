# ADR-0005：v0.1 相对 v3 的简化

- 日期：2026-11-05
- 状态：已采纳（W46 起逐项收回）
- 规格出处：v3 §2.2、§3.2、§5.1

## 背景

W45 的目标是端到端可跑的基础版本，用来暴露问题。以下简化是有意的，每项写明计划收回的 Roadmap 条目。

## 决定

| # | 简化 | v3 要求 | 收回 |
| --- | --- | --- | --- |
| 1 | 决策 op 不实现 `split`，store 无 `split_into` | §2.2.9 七种 op | PM-14 |
| 2 | M02 与 M04 合为一次模型调用；`TOPIC_SET_CHANGED` 时连抽取一起重跑 | 只重跑 ⑦⑧⑨ | PM-12 |
| 3 | 不按 recall_log 丢弃复述，不输出带 7 类原因的 `dropped`；recall_log 只用于判定「已告知」 | §2.2.5、§3.4 | PM-15 |
| 4 | `deferred_segments` 只存不回填 | §2.2.7 | PM-13 |
| 5 | 不记录每个 op 的判定依据 `basis` | §2.2.7 | PM-12 |
| 6 | 检索只做 project 一路，不与 ① 用户、② agent 两路融合，不返回 `memory_detail_list`；条目裁剪只用词法 | §3.2.3、§3.2.5 | PM-19、PM-20 |
| 7 | 新主题只在恰好能确定一个 domain 时创建，否则以 `domain_unresolved` 推迟 | 与 v3 一致，记录在此便于评测解读 | — |
| 8 | 不实现云端 Store；删除围栏只有 `local_queue`；`user_id` / `agent_id` 数组返回 `MODE_UNSUPPORTED` | §5.2 | PM-24 |
| 9 | recall_log 只有 `turn_start` 路径（按 Q-03 不实现 start_conversation） | §3.1 | 按 Q-03 不收回 |
| 10 | Store 侧不做 C01 不变式校验，信任 op 格式 | §2.2.10 C01 | PM-16 |
| 11 | 只要有一条过期向量，整次召回退化为词法 | §5.1.3 | PM-20 |
| 12 | 旧 `/api/v1` 上的 project 分支直接删除，没有兼容期 | — | 不收回（ADR-0002） |

## 影响

数据集 v2 上的 split、复述、推迟回填、三路召回相关指标在收回前会偏低，评测记录的备注里要注明本 ADR。

## 补记（2026-11-06）

第 9 条「按 Q-03 不收回」只覆盖 `via=session_start`。工具检索的 `via=tool`（v3 §3.3.5）不在 Q-03 范围内，v0.1 也一律记成 `turn_start`，由 PM-21 收回，入口字段见 open-questions Q-17。

## 补记（2026-11-10）

第 4 条（`deferred_segments` 只存不回填）由 PM-13 收回。同一会话的下一次整理会带上产生该行的原始轮次，模型用 `deferred_ref` 认领；写入后删除原行。`topic_unavailable` 与清空前受理的行不回填。上表第 4 行保持原样。细则见 open-questions Q-22。ADR-0007 收尾时仍写第 4 条有效，自本补记起以 PM-13 收回为准。

## 补记（2026-11-10，PM-14）

第 1 条（决策 op 不实现 `split`，store 无 `split_into`）由 PM-14 收回。`DecisionOp` 增加 `split`：`splitInto` 里原 `decisionId` 恰好出现一次，这一行改写成对应的那一项，其余 id 新建。保留原 id 的是 `from` 含 `content` 的那一项；没有这样的项时用第一项。原内容与每一条 conflict 写入每一片的 history，reason 相同，conflicts 清空。上表第 1 行保持原样。ADR-0007 仍写第 1 条有效，自本补记起以 PM-14 收回为准。

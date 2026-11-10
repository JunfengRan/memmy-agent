# ADR-0007：归类拆成三次模型调用

- 日期：2026-11-10
- 状态：已采纳
- 规格出处：v3 §2.2.5、§2.2.6、§2.2.7、§2.2.9、§2.3.1、§2.3.2
- 收回：ADR-0005 第 2 条、第 5 条。ADR-0005 只追加，它的表不改；由本 ADR 声明这两条收回。

## 背景

v0.1 把 M02 抽取、M04 归属，以及 M05 需要的「同一问题 / 同一结论 / 认可 / 裁决」合成一次 `pm-organize-v0.1.0`。`TOPIC_SET_CHANGED` 时连抽取一起重跑。写入动作也不记 `basis`。候选召回是整批消息拼成一条 query，召回漏掉的主题会被当成新工作。

## 决定

一次整理按下面的顺序走。抽取每个任务只做一次。`commitAttempts` 仍是 3。

1. M02 `pm-extract-v0.2.0`（`prompts/extract.ts`、`organize/extract.ts`）。输入是本批消息、上下文、项目指令和参与者，不包含候选主题。输出草稿（种类、决策类别、内容、`message_idx`、原因，以及认可 / 告知 / 裁决信号）、`state_hints`、`dropped`（不写入的 7 类原因；模型如果标了 `restatement` 就收下）和 `deferred`（`work_unresolved`）。作者仍按发言人从原文推导，不采信模型填写的 `user_ids`。复述与 `recall_log` 的比对是 PM-15，这里不做。
2. M03（`organize/candidates.ts`）。没有草稿就不召回，也不调用 M04 / M05。有草稿时每条草稿一条 query，`qid` 是草稿 id，文本是草稿内容。各 query 的结果按最好名次取并集，再截到 20 条（`PROJECT_MEMORY_LIMITS.mergeCandidateCap`）。`mustConsider` 里的主题即使掉出这 20 条也保留。召回返回的 `degraded` 放进 M04 的输入，并写入该 Space 的任务详情。
3. M04 `pm-assign-v0.2.0`（`prompts/assign.ts`、`organize/assign.ts`）。候选只有 `topic_id`、`domain`、`topic_summary`、`topic_description`。不发送 `topic_name`，也不发送条目。输出归入、新建或推迟，并带上 `basis.independent_delivery` 与 `basis.affects_existing_decisions`。模型给出的未知 `topic_id` 记为推迟，不改成新主题。
4. 全量读只拉 M04 归入的既有主题。
5. M05 判断 `pm-judge-v0.2.0`（`prompts/merge-judge.ts`、`merge/judge.ts`）。一次尝试里，对归入既有主题的草稿调用一次。草稿全部新建时不调用。输出同一问题、同一结论、认可、裁决、经验是否同一件事、经验是否变化、已告知，以及摘要和描述的改写。
6. `merge/merge.ts` 仍是确定性的。写下去的每个 op 在 ChangeSet 旁边带回 `basis`：`{ draftId, hit, checked }`。这个 basis 不放进 ChangeSet 的 op，存储层只落 op。`assignments.basis`、`dropped`、`degraded` 和这些 op basis 放进 `pm_tasks.progress_json` 里该 Space 的 `details`。表结构不变。`get/status` 的 `taskView` 不返回 `details`。
7. `TOPIC_SET_CHANGED`：不重新抽取。重跑召回、M04、全量读和 M05。`mustConsider` 把围栏带回的新主题 id 送进下一次 M04。
8. `VERSION_CONFLICT`：不重新抽取，也不重新归类。重读之后只重跑 M05 判断和确定性合并。
9. `TOPIC_NOT_FOUND`：这些主题按 `topic_unavailable` 跳过，再合并一次，不再抽取。
10. 选题实验仍在这份候选列表上、M04 之前收窄，默认关闭。默认路径不调用决策模型。

## 和 v3 的两处差异

1. 摘要和描述的改写放在 M05 判断这一次调用里，发生在确定性合并之前。v3 §2.2.7 的顺序是条目动作定稿之后再改写。这一版接受这个差异，避免为改写再增加一次模型调用。
2. 每条 query 的 `topic_k` 仍是 10。多条 query 的并集再截断到 20。v3 §2.2.6 写的是每次召回取 Top-K，没有这层并集上限。`mustConsider` 不受这层上限约束。

## 影响

ADR-0005 第 2 条（M02 与 M04 合成一次调用，主题集合变化时连抽取重跑）和第 5 条（不记录每个 op 的 `basis`）由本 ADR 收回。第 1 条 `split`、第 3 条复述过滤、第 4 条推迟回填仍然有效。

G-02、G-03、G-04、G-08、G-09 的预定修复是这次拆分。没有数据集 v2 的新数字之前，这些缺口保持打开。

## 替代方案

- 继续一次调用：`TOPIC_SET_CHANGED` 会重复抽取，候选也只能整批一条 query。否决。
- 摘要改写在合并之后单独再调一次模型：更接近 v3 的顺序，但每次冲突重试都多一次调用。这一版不采用。

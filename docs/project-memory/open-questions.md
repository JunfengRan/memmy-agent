# 待决问题

规格 TBD、规格之间的矛盾、实现中发现的问题。每条写我们的提议；有回复后改状态并在对齐表落地。周报汇总状态为 `待回复` 的条目。

状态：`待回复` / `按提议实现` / `暂缓` / `已关闭`。`暂缓` 表示初始版本（11/27 交付）完成前不处理，不进周报的待回复清单。

| ID | 问题 | 出处 | 提议 | 状态 |
| --- | --- | --- | --- | --- |
| Q-01 | RRF 常数 k、各信号权重、relativity 归一化方法未给出 | v3 §3.2.5、§3.5.4 R-3 | k=60（与现有 `assignChannelRrf` 一致）；relativity = 融合分 / 本次最高分；通过评测调参后回填 | 按提议实现 |
| Q-02 | 条目没有对外 ID | v3 §6.5 #1 | 条目返回 `id`（`dec_` / `exp_` / `tl_` 前缀） | 按提议实现 |
| Q-03 | 会话开始：v3 写 `start_conversation`，PRD 11/03 已删除 | v3 §3.1、PRD 修订 11/03 | 不实现 `start_conversation`。会话 ID 由调用方在 `add_message`（及同一会话的 `search_memory`）中自行提交，MemOS 不分配；会话开始的主题索引按 `space_id` 调 `get_memory`。v3 中依赖 start_conversation 的「本轮开始」、recall_log 分组都以调用方提交的会话 ID 为键 | 已关闭（11/04 用户决定） |
| Q-04 | `create_space` 入参：SDK 规格要求传 `space_id`，PRD 11/03 改为 `space_name` 且由 MemOS 生成 id | PRD 修订 11/03、SDK §create_space | 按 PRD 11/03 实现：必填 `space_name`，`space_id` 由 MemOS 生成，每次调用都新建 | 已关闭（11/04 用户决定） |
| Q-05 | ChangeSet 上限（≤20 topic、≤200 条目 op）未定 | v3 §6.5 #3 | 先按此上限，超出按 topic 拆分 | 按提议实现 |
| Q-06 | 决策多于 30 条时「同一问题」判定的输入规模 | v3 §6.5 #4 | v0.1 全量；W46 评估是否先在主题内召回前 10 条再判定（全量读仍读全部） | 按提议实现（11/04 用户确认） |
| Q-07 | recall_log 保留期 | v3 §5.3 | 7 天 | 按提议实现 |
| Q-08 | 归类准确率、重复主题率等 `[TBD]` 指标在 11/6 前要首批数，但现有数据集只有 7 个 topic，阈值无统计意义 | v3 §2.2 | v0.1 报首批数并注明样本量；W46 扩到约 50 个 topic | 按提议实现 |
| Q-09 | 迟交的 join 是否应把成员从更晚的结论里挪走；挪空后 content 的 user_ids 为空，之后谁能改写 | v3 §2.2.9 不变式 1；评审 PM-05-09 R1-9 | v0.1 维持现状；提议：迟交只追加，不移动成员 | 待回复 |
| Q-10 | 「已告知后裁决」与「结论相同」的判定顺序：v0.1 先判 resolve | v3 §2.2.9 流程图；评审 R1-10 | 按 v0.1 顺序，请确认 | 待回复 |
| Q-11 | 数据集主题分组与「约定 vs 执行步骤 / 局部实现」的边界（`tp_ledger_repo` 是否拆分、`t_write_main` / `t_write_secret` 是否为约定、`dec_cat_sku` / `dec_cat_dup` 是否属局部实现） | v3 §2.2.5、§2.2.7；评审 PM-03 R1-8 | 维持当前金标，在 README「规格含糊处」登记 | 待回复 |
| Q-12 | 转述的认可算不算「会话体现了认可」：成员 C 说「已和用户B 确认」，B 本人没有在该会话发言 | v3 §2.2.9；PM-05-09 handoff-02 | v0.1 计为认可（golden 用例如此），合并时仍要求认可人是现行结论的成员 | 待回复 |
| Q-13 | oracle 的主题摘要和描述取最终状态，不随提问时刻变化，q01、q03 因此用到了未来信息；金标作被测系统 answers.llm 只有 0.826 | v3 §3.3.4；gaps-v01 E-02 | 数据集 v2.1（PM-17）里让 oracle 按 `askedAt` 重推摘要要点；或在 README 登记为已知上限。评委、阅读模型不改 | 待回复 |
| Q-14 | q17 标准答案是「已修好，只跳过金额列为空的行」，但提问时金标状态里 `dec_empty` 仍有未解决的 conflict，按模板回答「尚未确定」是对的 | v3 §2.2.9；gaps-v01 E-03 | 改标准答案为同时说明修复与未决分歧，或让 q17 的期望条目只指向进展 `tl_bug` 并在 mustInclude 里去掉结论 | 待回复 |
| Q-15 | `chat_time` 缺失时算不算重放。v3 §2.2.2 规定缺失时回落为到达时间并按 `(conversation_id, role, chat_time)` 去重，两次到达就是两条消息；v0.1 的任务批次键（`service.ts` `batchKey`）把推断时间去掉了，同一会话里同一成员再次发送同样的文字（如「继续」）会拿回旧 `task_id`，本次内容不整理 | v3 §2.2.2、§2.2.10 `idempotency_key`；20261106-review-triage Add-1 | 按 v3：推断时间进入批次键，缺 `chat_time` 的提交不做任务级去重；网络重试要幂等，由 SDK 补 `chat_time`（SDK 规格本来就要求宿主带时间）。`idempotency_key` 维持 v3 写法（Space + 会话 + 本批 hash），同会话同角色同时间同内容的再次提交按重放处理是有意的 | 待回复（PM-16 实现） |
| Q-16 | 失败的批次能否重新提交。v0.1 中 `VERSION_CONFLICT_RETRY_EXHAUSTED`、`MODEL_CALL_FAILED` 的批次整批不写；同一批消息再提交时按批次键拿回那个 `failed` 任务，没有恢复途径 | v3 §2.2.11「同一批消息重放返回原 task_id」、§2.3.1；review-triage Add-2 | 失败原因可重试（commit 阶段冲突超限、模型调用失败）的批次再提交时新建任务；Space / 领域类失败仍返回原任务。失败尝试里的 `deferred` 不落盘（v3：失败不写任何内容）。`TOPIC_SET_CHANGED` 与 `VERSION_CONFLICT` 按 v3 共用 3 次预算不变，成本由 PM-12（只重跑 M04）降下来 | 待回复（PM-16 实现） |
| Q-17 | 检索怎么告诉 Local 是工具检索。v3 §3.3.5 要求工具检索写 `via=tool`、不算本轮开始，但 `search_memory` 的入参里没有表示入口的字段；v0.1 一律写 `turn_start` | v3 §3.2.5、§3.3.5、§6.5 #12；review-triage Search-4/9 | SDK → Local 的请求体加一个本机字段 `recall_via`（`turn_start` / `tool`，缺省 `turn_start`），不进 SDK 公开参数，由 SDK 的工具处理函数填写 | 待回复（PM-21 实现） |
| Q-18 | 按时间窗口检索。v3 的 `search_memory` 对项目记忆只有 `query` / `space_ids` / `domains` 三个范围参数，没有时间窗口或「某时刻的状态」入口；`filter` 只原样带给 ① 路 | v3 §3.2.2；review-triage Search-1 | v3 未定义，不算缺口。若需要，提议 `filter.time_range` 只作用于条目的 `time`，`history` 仍全量返回；由 designer 决定是否进 v3 | 暂缓（11/09 用户决定：初始版本完成后再议） |
| Q-19 | 决策级来源。v3 的 `decisions` 表没有会话字段，`search_memory` 明确不返回 `sources`；Agent 从一条决策只能经 `get_memory_by_id` 拿到主题级 `sources`，再用 `get_message` 读原文，无法定位到具体哪次会话 | v3 §3.2.2、§4.3、§5.3；review-triage Search-2 | 维持 v3。若采纳，需改表结构（`decisions` / `decision_history` / `decision_conflicts` 加 `conversation_id`）和检索契约，走 ADR | 暂缓（11/09 用户决定：初始版本完成后再议） |
| Q-20 | ② agent memory 一路的排序与项目一路不同：现有检索有 LLM 过滤、分层和按墙钟的时效，`contextBudget` 也未生效（`retrieval-service.ts` 中 `void budget`）。M09 要「同一输入结果完全一致」 | v3 §3.2.3、§3.2.5、§3.5.1–3.5.3；review-triage Search-6/7 | M09 只按名次（RRF）融合，不比原始分数；② 路在融合时关掉 LLM 过滤、不用墙钟时效，只取候选与名次。预算按 v3 放在 M10（`budget_tokens`），不复用旧 `contextBudget` | 待回复（PM-19 / PM-20 实现） |
| Q-21 | 降级对宿主可见。`degraded` 在返回体里（符合 v3 §3.2.3），但模板三没有对应的渲染，宿主技能会把词法结果当作完整召回 | v3 §3.2.3、§3.3.4；review-triage Search-12 | 模板三在 `degraded` 非空时加一行固定提示（如「本次未用向量召回，结果可能不全」）；search 技能写明遇到降级时可换说法再查一次 | 待回复（PM-22 实现） |
| Q-22 | 推迟片段如何在后续消息里回填，以及已删除主题、清空围栏、domain 未定的片段要不要再判 | v3 §2.2.7、§4.5 | 同一会话、同一 Space 的下一次整理把产生该行的原始轮次和 `df<id>` 交给 M02，模型认领 ref 后删除原行，上限 10 条。`topic_unavailable` 不回填。清空前受理的行不回填。片段在某个具体主题被删除之前就推迟、且从未指向主题时仍然回填；已删除的主题不在召回结果里，不改写旧的 topic id，M04 若新建主题则允许。验收「已删除的主题被重建 = 0」只覆盖 `topic_unavailable` 这一路。`domain_unresolved` 可以回填进本次请求指定的 domain，因为 domain 按每次调用选择 | 按提议实现 |
| Q-23 | 内容作者加入一条已有 conflict，且这次会把 content 的成员全部移走时，content 的 user_ids 被挪空，相同结论也不会合并 | v3 §2.2.9 不变式 1；gaps-v01 G-06 | 草稿不是迟交时改为发出 rewrite，让相同结论合并，user_ids 取并集。当前 join 行为不改 | 待回复 |

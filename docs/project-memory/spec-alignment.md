# 规格对齐表

对齐版本见 [spec-snapshots.md](spec-snapshots.md)。状态：`未开始` / `v0.1 简化` / `已对齐` / `待重新对齐`（规格变化后由 `pm-spec-sync` 标记）/ `偏离`（必须链接 ADR 或 open-questions）。

## 一、模块与接口

| v3 出处 | 内容 | 代码位置 | 状态 | 测试 / 评测 | 备注 |
| --- | --- | --- | --- | --- | --- |
| §1.6.1、§1.6.3 | `/api/openmem/v1/` 下的路径 | server/http.ts → project-memory/api.ts | 部分对齐：Space 4 / domain 4 / add / get status / search / get memory / get memory by id / delete memory 已实现 | `tests/service/project-memory/http-contract.test.ts` | 写权限按原始路径判断，末尾斜杠可绕过（review R1-1）；旧实现已删（ADR-0002） |
| §4（Space、domain 管理） | create/get/update/delete space；domains 增删改查 | store/、service.ts | 已对齐（create 仍接受 space_id，待按 Q-04 收紧） | | review R1-5 |
| §5.1.2 | ProjectMemoryStore 接口 | store/store.ts | 已对齐 | | 云端实现未做（ADR-0005 #8） |
| §5.1.5 | 错误码 | contract/errors.ts | 已对齐 | http 契约测试 | |
| §5.3 | SQLite 表 | storage/schema.ts v10 | 已对齐（分表前缀 `pm_`） | 迁移测试 | |
| §2.2.1–2.2.2 M01 | 采集、raw_turns、剥离注入块、返回 task_id | organize/collect.ts、service.ts、pipeline/ | 部分对齐 | task-resubmit.test.ts；restatement-pipeline.test.ts | 已剥离带属性的 `<memos_context>`。同一 Space、同一 domain 集合里已完成任务整理过的消息只作上下文（Q-27）。跨 Space 复用同一批消息会丢（review R1-2）。`chat_time` 缺失回落到秒精度到达时间，同一秒的同文提交仍是一条任务（Q-24） |
| §2.2.3 | 会话上云 | — | 未开始 | | 本期只做 cloud store 适配 |
| §2.2.4 | Space / domain 校验 | contract/ | 未开始 | | |
| §2.2.5 M02 | 抽取：是否写入、回复拆分、字段判定 | organize/extract.ts、prompts/extract.ts（pm-extract-v0.2.2）；organize/restatement.ts；pipeline/organize-job.ts | 部分对齐（独立调用；同一会话的推迟片段可随本批进入抽取；dropped 收 7 类原因；复述与 recall_log 比对已接入） | 数据集 v2 add 指标；organize-stages.test.ts；deferred-backfill.test.ts；restatement-pipeline.test.ts | ADR-0005 #2 由 ADR-0007 收回；ADR-0005 #3 由 PM-15 收回 |
| §2.2.6 M03 | 归类用候选召回 | organize/candidates.ts、sqlite-store.ts | 部分对齐（每条草稿一条 query，topic_k=10，degraded 透传 M04；并集再截到 20） | organize-stages.test.ts | 并集上限见 ADR-0007 |
| §2.2.7 M04 | 归入 / 新建 / 推迟，摘要描述改写 | organize/assign.ts、prompts/assign.ts（pm-assign-v0.2.0）；pipeline/organize-job.ts；store/sqlite/local-state.ts | 部分对齐（只看摘要和描述，basis 写入任务详情；摘要改写在 M05 判断调用里；同一会话下一次整理回填推迟片段，`topic_unavailable` 与清空前受理的行不回填，见 Q-22） | organize-stages.test.ts；deferred-backfill.test.ts | ADR-0007；ADR-0005 #4 由 PM-13 收回；Q-22；选题实验默认关闭（ADR-0006） |
| §2.2.8 | 全量读 | sqlite-store.ts；organize-job.ts 只读已归入的主题 | 已对齐 | decision golden | §2.3.2 两段读取 |
| §2.2.9 M05 | 决策 7 种 op、经验 4 种 op、轨迹 | merge/judge.ts（pm-judge-v0.3.0）、merge/merge.ts、store/sqlite/apply.ts | 部分对齐：判断独立调用，规则合并仍确定性；`split` 已实现。保留原 id 的一项（`from` 含 `content`，否则第一项）以及每一片 history 都写入原内容和全部 conflict，是实现提议。op basis 在 ChangeSet 旁返回，不写入 op。作者由会话推出；认可人要和现行结论相交才改写。等于 history、又不等于当前内容或任一 conflict 的草稿不会回到当前：迟交不写；非迟交且无原因、无裁决信号则丢为 restatement（Q-26） | decision-golden.test.ts；store-commit.test.ts；restatement-pipeline.test.ts | ADR-0005 #1 由 PM-14 收回；保留 id 与分片 history 待确认；R1-4 已在 review-02 关闭；摘要改写在判断调用内，ADR-0007；Q-26 |
| §2.2.10 | ChangeSet、条件写、结果码 | apply.ts、organize-job.ts、service.ts | 部分对齐：deferred 事务。`TOPIC_SET_CHANGED` 会把 `newTopicIds` 放进下一次候选。推断的 `chat_time` 进入批次键（Q-15）；可重试失败新建任务（Q-16） | store-commit.test.ts；task-resubmit.test.ts | R1-3 已在 review-02 关闭；R1-6 |
| §2.2.11 | get_task_status | api.ts、store/sqlite/local-state.ts | 已对齐。可重试失败再提交会新建任务（Q-16），不再总是返回原 task_id | http 契约测试；task-resubmit.test.ts | 任一 Space 不可重试则仍返回原任务（Q-25） |
| §2.3 | OCC、Space 内串行、删除围栏 | pipeline/、repositories.ts | 部分对齐 | concurrency.test.ts | 失败任务阻塞队头（R1-7）；只有 local_queue 围栏 |
| §3.2.1 | 会话开始索引（get_memory） | api.ts | 已对齐（按 space_id 读） | | 无 start_conversation（Q-03） |
| §3.2.2–3.2.3 M08 | search_memory 三路召回 | retrieve/recall-paths.ts；retrieval-service.ts `recallCandidates`；retrieve/search.ts 负责 project 路排序 | 部分对齐：① 用户记忆、② L1/Skill、③ project 都返回候选。任一路失败写入 `degraded`（Q-28）。跨路融合见 §3.2.5。`memory_detail_list` 等 Q-29 | recall-paths.test.ts；recall-candidates.test.ts；http-contract.test.ts；search.test.ts | ADR-0005 #6 的三路部分由 PM-19 收回；Q-28。项目向量降级名仍是 `vector` |
| §3.2.4 | L01 召回（FTS5 + 向量） | sqlite-store.ts | 已对齐 | search.test.ts | 有任一过期向量即整体退词法（Q-30，PM-20 不改这段） |
| §3.2.5、§3.5 M09 | RRF、MMR、条目裁剪、截断、recall_log | retrieve/fuse.ts；retrieve/search.ts；retrieve/recall-paths.ts | 部分对齐：跨路 RRF 已按名次融合，不透传各路原始分数。relativity 是融合分 / 本次最高分，四位小数后名次差压在 61/(60+rank)，再按输出顺序取累计最小值。名次相同按 user_memory、agent_memory、project 打破。条目裁剪仍只用词法。截断不在返回体里标明。列表名仍是 `user_memory` / `agent_memory`，等 Q-29。recall_log 只记实际返回的主题，via 缺省 `turn_start`（Q-17，PM-21） | fuse.test.ts；search.test.ts；recall-paths.test.ts；http-contract.test.ts | RRF k=60（Q-01）；Q-29、Q-30；ADR-0005 #6 的融合部分由 PM-20 收回，词法裁剪和 `memory_detail_list` 仍在；#11 不收回。Decisions 选题默认关闭（ADR-0006） |
| §3.3 M10 | 注入模板 1–4、检索工具 | — | 未开始 | 渲染 golden | v3 放在 SDK；W47 |
| §3.4 | 三层剥离 | organize/collect.ts；organize/restatement.ts；pipeline/organize-job.ts | 部分对齐：第 2 道 M01 剥离带属性的 `<memos_context>`；第 3 道 M02 按本会话 recall_log 丢弃复述。第 1 道 SDK `strip_injected` 未做 | restatement.test.ts；restatement-pipeline.test.ts | 经验与轨迹没有单独的召回 id，比对用主题行上的当前内容（ADR-0005 补记） |
| §5.2 | 云端存储服务接口 | — | 未开始 | mock 契约测试 | W48（PM-24） |

## 二、与 PRD / SDK 规格的差异（按架构文档执行）

来自 v3 §6.4，以及我们对比两份产品文档时发现的差异。按 [ADR-0001](decisions/0001-authority-order.md) 以架构文档为准。

| # | 主题 | PRD / SDK 写法 | 架构文档写法（执行） | 出处 |
| --- | --- | --- | --- | --- |
| 1 | 领域 | MemOS 自动识别领域，跨领域内容拆开归类 | 调用方指定 domain；新建主题只在恰好一个 domain 时进行，否则推迟（`domain_unresolved`） | v3 §6.1 #12、§6.4 #1 |
| 2 | 比对位置与顺序 | 云端按提交顺序串行比对 | 本机比对；OCC 代替全局顺序；本机 Space 内串行 | v3 §6.4 #2 |
| 3 | local_config | 只有写入需要 | 读取项目记忆也需要 | v3 §6.4 #3 |
| 4 | 经验历史 | 经验不保留历次内容 | 经验带只追加的 `history`，无 `conflicts` | v3 §6.1 #11、§6.4 #9 |
| 5 | 已告知 | 未定义判定方式 | `recall_log` 显示返回过带冲突的决策 + M02 输出 `informed` 信号 | v3 §2.2.9、§6.4 #7 |
| 6 | 无法确定所指工作 | 等后续消息 | 依赖 `conversation_id`；没有时不整理 | v3 §6.4 #8 |
| 7 | 多轮拆分 | SDK 按用户消息拆 | Local 拆，SDK 只发一个请求 | v3 §6.4 #15 |
| 8 | 混排 | 与其他种类统一排序 | 按种类分列表返回，总数受 `memory_limit_number` 约束 | v3 §6.4 #14 |
| 9 | 原样提交 | 原样提交消息 | 例外：剥离 `<memos_context>` | v3 §6.4 #11 |
| 10 | 会话开始 | PRD 11/03 删除 `start_conversation`，改为按 `space_id` 调 `get_memory` | v3 仍写 `start_conversation` | 不实现 start_conversation；会话 ID 由调用方在 add/search 中提交（Q-03，11/04 决定）；待 v3 更新 |
| 12 | resolve 顺序 | v3 流程先判「结论相同」再判已告知 | v0.1 先判 resolve | v3 §2.2.9；open-questions Q-10 |
| 11 | create_space | PRD 11/03：传 `space_name`，`space_id` 由 MemOS 生成；SDK 规格仍要求传 `space_id` | v3 未写明 | 按 PRD 11/03 实现（Q-04，11/04 决定） |

# Roadmap

交付日 **2026-11-27（周五）**。范围：Local 全链路（SQLite Store 完整实现）；云端 Store 做 HTTP 适配，用 mock 服务做契约测试；之后在本地服务或测试机上做一次小范围云端测试。12/7–12/18 的联调评测不在本计划内。

状态：`todo` / `doing` / `done` / `blocked` / `moved`（移到其他周时写明去向）。每个条目写规格出处和验收。

## W45（11/3–11/6）M0：基础版本 v0.1，用来暴露问题

目标：端到端可跑，11/6 技术评审前拿到首批数，并据此修订文档。

| ID | 条目 | 出处 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| PM-01 | 治理落地：AGENTS.md、技能、docs/project-memory | — | 新会话能加载规则；4 个技能可见 | done |
| PM-02 | 评测清理：数据集只留一份，生成物移出 git | — | `git status` 不跟踪生成物 | done（9aabf84b） |
| PM-03 | 评测数据集 v2：语料补成员身份、金标按 v3 重推、冲突改为按作者、题目清理 | v3 §2.2.5–2.2.9 | `load-eval-set` 校验通过 | done（9aabf84b；评审 3 项 MUST 已在 672919d5 修复，待 review-02，见 .agents/work/PM-03-eval-dataset-v2） |
| PM-04 | 评测脚本 v2：runner 只调规格接口，scorer 按 topic 计数、拆分 trap、独立评委 | v3 §3.2 | oracle 全 1、empty 全 0 | done（同上） |
| PM-05 | contract/ 与 schema v10 建表 | v3 §5.1.5、§5.3 | typecheck 通过，迁移测试 | done（44dcbb1e） |
| PM-06 | SQLite Store：Space/domain、topic 读写、L03 条件写（revision、topic_seq、幂等键） | v3 §5.1.2、§2.2.10 | 409 后库不变；幂等重放无副本 | done（44dcbb1e） |
| PM-07 | add v0.1：raw_turns → Space 串行任务 → 一次 LLM 调用完成 M02+M04 → M05（add/join/rewrite/conflict_append，经验带 history，轨迹追加）→ ChangeSet → 条件写，冲突重合并 ≤3 次 | v3 §2.1–2.3 | PRD 决策维护逐轮表 golden 通过 | done（44dcbb1e；split 未做，见 ADR-0005） |
| PM-08 | search v0.1：project 一路，FTS5 + 向量，RRF + MMR + 时效/本会话优先，按 topic 截断，附 history/conflicts；get_memory、get_memory_by_id、get_task_status | v3 §3.2.2–3.2.5 | 检索确定性测试；topic_detail_list 形状 | done（44dcbb1e；只做 project 一路） |
| PM-09 | 删除旧实现（memories 表里的 project 行和 /api/v1 分支） | ADR-0002 | 普通 L1 召回不再出现 project 行 | done（44dcbb1e） |
| PM-10 | 跑 v2 评测出首批数；问题清单进 open-questions；ADR-0005 列出 v0.1 简化；W45 周报 | — | metrics.md 有第一行 | done（R-20261105-01～04；缺口清单 gaps-v01.md；周报 weekly/2026-W45.md） |

## W46（11/9–11/13）M1：按问题修订文档，补全 add

| ID | 条目 | 出处 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| PM-11 | 根据 v0.1 问题清单修订对齐表，起草给架构文档的修改意见 | — | open-questions 有提议和回复状态 | done（[spec-change-requests.md](spec-change-requests.md)；对齐表随 PM-12～PM-23 更新） |
| PM-11a | 关闭 v0.1 评审 MUST：代码 5 项（PM-05-09 review-01 R1-1～R1-5）、评测 3 项（PM-03 review-01 R1-1～R1-3） | .agents/work | 下一轮 review 全部关闭 | done（review-02 approved，无未关闭 MUST；59547700、672919d5） |
| PM-11b | 跟踪 v0.1 缺口：`gaps-v01.md` 的 G-01～G-12、E-02～E-05 逐条确认归属条目与状态（E-01、E-06 已关闭）；E-02、E-03 的数据集修订走 PM-17 | gaps-v01.md | 每条缺口有证据、归属条目与状态 | done（每条有证据、归属和状态。G-07 并入 Q-23。E-02、E-03 在 R-20261110-02 关闭。E-04 仍开：上限 0.903） |
| PM-12 | M02 / M04 拆开：add 技能、topic 技能独立提示词（收回 G-02、G-03、G-04、G-08、G-09）。同时：M03 按草稿各出一条 query（v0.1 整批一条，召回漏掉候选会新建重复主题）；merge 召回的 `degraded` 透传给 M04；`TOPIC_SET_CHANGED` 只重跑 M04，不再重跑抽取（review-triage Add-2、Add-5） | v3 §2.2.5、§2.2.6、§2.2.7 | 归类准确率、重复主题率有数；进展 R 与经验 F1 不再为 0 | done（实现与单测完成；数据集 v2 复测未完成：阅读模型 claude-haiku-5-5 网关 503，缺口未复测） |
| PM-13 | 推迟机制：deferred_segments 与后续回填（收回 G-01）。`topic_unavailable`（主题已被删除）的片段不回填，否则等于为已删主题重建（review-triage Add-3） | v3 §2.2.7、§4.5 | 推迟内容回填 ≥90%；已删除的主题被重建 0 | done（实现与单测完成；评测未跑：阅读模型网关 2026-11-10 返回 503） |
| PM-14 | 决策补全 conflict_update / resolve / split；informed 由 recall_log + M02 信号判定（收回 G-06、G-10） | v3 §2.2.9 | 决策 op golden 全过 | done（决策 op golden 与条件写单测通过；评测未跑） |
| PM-15 | 迟交规则、按 conversation_id 去重、复述过滤（收回 G-05） | v3 §2.2.3、§3.4 | 迟交改写更晚决策 = 0；旧版当当前 = 0 | done（实现与单测完成；评测未跑） |
| PM-16 | TOPIC_SET_CHANGED 重做、幂等键、任务失败原因。含：`chat_time` 缺失时的批次键（Q-15）；失败批次可重新提交（Q-16）；热点 Space 并发新建耗尽 3 次预算的情形写进并发用例（review-triage Add-1、Add-2） | v3 §2.2.2、§2.2.10、§2.2.11 | 并发验收表；缺 `chat_time` 的两次同文提交各自整理；冲突超限的批次重交后能写入 | done（实现与单测完成；未跑在线评测） |
| PM-17 | 数据集 v2.1：多成员、多空间、多 domain、迟交、推迟、重复提交、闲聊负样本、相似名称对照组，约 50 个 topic；同时修 E-02（oracle 摘要随时间变化）、E-03（q17 答案与金标状态）、E-04（阅读模型样本） | v3 §2.2.7 验收 | 能测重复率与错误合并率；金标作被测系统时 answers.llm = 1 | doing（重复率与错误合并率已可测。R-20261110-02：金标上限 answers.llm 0.903，不是 1。错题 q03、q24、q25。阅读模型换成网关上仍在的 claude-haiku-4-5-20251001） |
| PM-18 | 11/13 交付评测集方案（PRD 待办 3） | PRD 待办 3 | 方案文档 | done（[eval-set-scheme.md](eval-set-scheme.md)；v2.1 即 e5f03e43） |

## W47（11/16–11/20）M2：search 补全与渐进式披露

| ID | 条目 | 出处 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| PM-19 | M08 三路召回：①用户记忆 ②agent L1/Skill ③project，降级标记 degraded。② 路的 LLM 过滤、分层、墙钟时效和失效的 `contextBudget` 按 Q-20 处理（review-triage Search-6、Search-7） | v3 §3.2.3 | 三路齐全或标记降级 100% | done（三路召回单测通过；跨路融合和 memory_detail_list 仍是 PM-20；未跑评测） |
| PM-20 | M09 跨路 RRF、relativity 归一化、条目裁剪。三路只按名次融合，不拼接各路分数；relativity 改为 Q-01 的融合分归一（v0.1 用词法 / 向量相关度，阈值已改为按每个主题自身的相关度过滤，review-triage Search-3） | v3 §3.2.5、§3.5 | 确定性 100%；relativity 单调 | done（跨路按名次 RRF 与 relativity 单调性单测通过；列表名等 Q-29；过期向量整次退词法不改，见 Q-30；未跑评测） |
| PM-21 | 渐进式披露：会话开始 get_memory 索引、每轮 memories、工具 search_project_memory、get_memory_by_id。工具检索写 `via=tool`、不算本轮开始（Q-17）；宿主技能改查 `/api/openmem/v1/search/memory`，不再落到个人记忆（review-triage Search-4、Search-8、Search-9） | v3 §3.1–3.3 | 每轮注入 ≤ 全量的 30%；工具检索的召回记录 `via=tool` 100% | done（`via=tool` 与工具绑定单测通过；每轮注入 ≤ 全量 30% 未在实况回放上测量，见 Q-31。检索算法未改。模板 1–3 留给 PM-22） |
| PM-22 | 注入模板 1–4、strip_injected、search 技能。`degraded` 非空时模板与技能里可见（Q-21，review-triage Search-12） | v3 §3.3、§3.4 | 注入块回写 M02 = 0；降级结果渲染出提示 100% | done（闭合注入块回写 M02 的单测为 0，`strippedBlocks` 记在任务详情；降级非空时有命中和无命中都渲染固定提示。Claude / Codex / Cursor 宿主钩子未接。非项目记忆段落不渲染。Memmy agent 在 hook.ts 里做了会话指南+索引和每轮模板三。Q-21 状态未改） |
| PM-23 | 检索延迟与 Recall@K | v3 §3.6 | 单路 P95 ≤800 ms，总 ≤1.2 s | done（S+stub，测于 `127cca7e`：第 3 路 P95 0.741 ms，总 P95 1.462 ms，渲染 P95 0.008 ms，超时 0。金标灌库 Recall@1/3/9 0.581/0.968/0.968，不入索引。流水线 Recall 与 HTTP P95 未跑：阅读模型网关 2026-11-10 返回 503。L 只作参照） |

## W48（11/23–11/27）M3：云端契约与验收

| ID | 条目 | 出处 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| PM-24 | cloud store HTTP 适配 + mock 契约测试。C01 不变式校验从 PM-16 移到本条 | v3 §5.2 | 同一批查询两种存储 Recall@K 差 ≤5% | todo |
| PM-25 | 小范围云端测试（本地服务或测试机） | — | 端到端跑通 | todo |
| PM-26 | 100 次故障注入 | v3 §2.2.10 | 半成功 = 0 | todo |
| PM-27 | 对照 v3 §2.4、§3.6 验收表逐项核对；文档定稿；PR | — | 验收表逐项有结论 | todo |
| — | 11/26–11/27 缓冲 | | | |

## 风险

- W45 很紧。11/5 add 没跑通时，search v0.1 先只做 FTS + RRF，向量移到 W46。
- 规格每周在变。每次变化走 `pm-spec-sync`，变化大的条目在周五重排。
- 数据集小（7 个 topic），1–2% 级别的阈值在 v2.1 之前没有统计意义。

## 变更记录

| 日期 | 变化 | 原因 |
| --- | --- | --- |
| 2026-11-10 | PM-17 仍是 doing：v2.1 阅读上限 R-20261110-02 为 answers.llm 0.903（28/31） | 网关没有 claude-haiku-5-5，改用 claude-haiku-4-5-20251001，温度 0。错题 q03、q24、q25，不把上限写成 1 |
| 2026-11-10 | PM-17：q17 标准答案改为同时说明丢行原因和未决分歧。阅读上限仍未复跑 | 阅读模型 claude-haiku-5-5 仍返回 503。这是 v2.1 内的小改，不另冻数据集 |
| 2026-11-10 | PM-11、PM-11b 改为 done。修改意见在 spec-change-requests.md。缺口表每条有归属和状态 | 对齐表已随各条目更新。G-07 并入 Q-23。E-02 的数据集部分已进 v2.1 |
| 2026-11-10 | PM-23 改为 done：S+stub 第 3 路 P95 0.741 ms，总 P95 1.462 ms，渲染 P95 0.008 ms，超时 0。金标灌库 Recall 不入索引。流水线 Recall 与 HTTP P95 未跑（阅读模型网关 2026-11-10 返回 503） | 不改检索排序、超时和返回字段。语料规模见 Q-35 |
| 2026-11-10 | PM-22 改为 done：模板 1–3、回写剥离和降级提示。宿主钩子只接了 Memmy agent | 单测通过，没有新指标。不改检索排序，不改 Q-21 |
| 2026-11-10 | PM-21 改为 done：工具检索写 `via=tool`，宿主技能改查项目记忆。30% 比例未在实况回放上测量（Q-31） | 单测通过，没有新指标。不渲染模板 1–3（PM-22），不改检索算法 |
| 2026-11-10 | PM-20 改为 done：M09 按名次融合三路，relativity 用融合分归一。列表名等 Q-29，过期向量整次退词法不改（Q-30） | 单测通过，没有新指标。不实现 PM-21、PM-22 |
| 2026-11-10 | PM-19 改为 done：M08 并行召回用户记忆、L1/Skill 和 project，失败写入 degraded。不融合、不返回 memory_detail_list | 单测通过，没有新指标。融合留在 PM-20 |
| 2026-11-10 | PM-18 改为 done：评测集方案写在 docs/project-memory/eval-set-scheme.md | PRD 待办 3。可跑数据仍是 dataset/ 一份，v2 冻在 history/v2。q17、阅读上限和 q40–q47 的题型留在 PM-17 |
| 2026-11-10 | PM-15 改为 done：复述过滤接到整理任务；history 不再写回当前；同 Space 同 domain 已完成的消息不再抽取。评测未跑 | 单测通过，没有新指标 |
| 2026-11-10 | PM-17 改为 doing：数据集 v2.1 入库，v2 冻在 history/v2。阅读上限和 q17 答案还没做 | 用户要求大版本替换时留下上一版数据集 |
| 2026-11-10 | PM-16 改为 done：推断时间进入批次键；可重试失败新建任务；并发用例补齐。C01 校验改到 PM-24 | 单测通过，没有新指标。未跑在线评测 |
| 2026-11-10 | PM-14 改为 done：补上 `split`，并为 conflict_update、resolve、informed 补了 golden。评测未跑 | 单测通过，没有新指标。G-06 的 join 路径未改，见 Q-23 |
| 2026-11-10 | PM-13 改为 done：同一会话的下一次整理回填推迟片段；`topic_unavailable` 与清空前的行不回填 | 单测通过。评测未跑：阅读模型网关 2026-11-10 返回 503，没有新指标 |
| 2026-11-10 | PM-12 改为 done：M02 / M04 / M05 拆成三次调用。归类准确率等待复测 | 单测通过。评测回放到阅读模型时，claude-haiku-5-5 网关返回 503，没有新指标 |
| 2026-11-10 | PM-11a 改为 done。review-02 确认 8 项 MUST 已关闭，没有新的 MUST | 评审在 3fe76c95 上复核通过 |
| 2026-11-09 | Q-18、Q-19（时间窗口检索、决策级来源）改为暂缓；PM-11b 去掉已完成的 E-01 对照 | 用户决定初始版本完成后再议；收窄 W46 范围 |
| 2026-11-09 | W45 周报补全；PM-10 改 `done`；PM-11a 仍等 review-02，W46 计划不变 | 补写上周周报，规格复核无变化 |
| 2026-11-06 | 评审意见分诊（`.agents/work/20261106-review-triage`）：relativity 阈值改为按自身相关度过滤，`recallQuery` 改用 `clampText`；其余各条并入 PM-12、PM-13、PM-16、PM-19～PM-22 的范围与验收；需要裁决的写成 Q-15～Q-21 | 用户转来一组 add / search 评审意见 |
| 2026-11-06 | 主题归属实验改为 `gpt-6-luna` 的 chat completions 选择题（网关无 `/v1/decisions`），配置读 `~/.openai.env`，产品开关默认关闭。单独评测见 metrics R-20261106-01 | 用户要求用内部中转上的 gpt-6-luna 做选题实验，评测后不要挡住主开发 |
| 2026-11-03 | 初版 | 用户要求 W45 先出基础版本 |
| 2026-11-05 | 修正过期状态（PM-03、PM-10）；新增 PM-11b 与 `gaps-v01.md`（实现缺口 G-01～G-12、评测缺口 E-01～E-06）；PM-12～PM-15、PM-17 条目标明收回哪些缺口；增加金标作被测系统的阅读模型上限（R-20261105-03）和旧实现同口径对照（R-20261105-04：answers.llm 0.565，对 v0.1 的 0.609） | 用户要求核对项目状态，并解释 v1 的 95% 与 v2 的 60% 的差异：口径变了为主，v0.1 也有真实缺口 |
| 2026-11-05 | PM-11a 提前开工：8 项评审 MUST 修复并交接，复测见 metrics R-20261105-02 | 用户要求先修 MUST |
| 2026-11-05 | W45 收尾：v0.1 与数据集 v2 合入；评审各给出 changes-requested；新增 PM-11a 关闭评审 MUST | 两个独立会话完成开发，收尾会话评审与评测 |
| 2026-11-04 | 增加多 Agent 交接规范（`.agents/`）；metrics 记录改为每条收录全部指标 | 多个应用的 Agent 以 designer / developer / reviewer 接力 |
| 2026-11-04 | W45 增加评测基线：旧实现 + main 对照，被测模型改为 deepseek；token 限流与检索 LLM 过滤在评测配置中关闭 | 用户要求先有可比基线 |

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
| PM-10 | 跑 v2 评测出首批数；问题清单进 open-questions；ADR-0005 列出 v0.1 简化；W45 周报 | — | metrics.md 有第一行 | doing（v0.1 在 v2 上已出两组数（R-20261105-01/02），金标上限已测（R-03）；缺口清单见 gaps-v01.md；旧实现在 v2 上的同口径对照已跑，见 R-20261105-04） |

## W46（11/9–11/13）M1：按问题修订文档，补全 add

| ID | 条目 | 出处 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| PM-11 | 根据 v0.1 问题清单修订对齐表，起草给架构文档的修改意见 | — | open-questions 有提议和回复状态 | todo |
| PM-11a | 关闭 v0.1 评审 MUST：代码 5 项（PM-05-09 review-01 R1-1～R1-5）、评测 3 项（PM-03 review-01 R1-1～R1-3） | .agents/work | 下一轮 review 全部关闭 | doing（8 项已修复并交接：59547700、672919d5；待 review-02） |
| PM-11b | 登记并跟踪 v0.1 缺口：`gaps-v01.md` 的 G-01～G-12、E-01～E-06；跑旧实现同口径对照；E-02、E-03 的数据集修订走 PM-17 | gaps-v01.md | 每条缺口有证据、归属条目与状态；E-01 有数 | doing（清单已建，E-01 已关闭） |
| PM-12 | M02 / M04 拆开：add 技能、topic 技能独立提示词（收回 G-02、G-03、G-04、G-08、G-09）。同时：M03 按草稿各出一条 query（v0.1 整批一条，召回漏掉候选会新建重复主题）；merge 召回的 `degraded` 透传给 M04；`TOPIC_SET_CHANGED` 只重跑 M04，不再重跑抽取（review-triage Add-2、Add-5） | v3 §2.2.5、§2.2.6、§2.2.7 | 归类准确率、重复主题率有数；进展 R 与经验 F1 不再为 0 | todo |
| PM-13 | 推迟机制：deferred_segments 与后续回填（收回 G-01）。`topic_unavailable`（主题已被删除）的片段不回填，否则等于为已删主题重建（review-triage Add-3） | v3 §2.2.7、§4.5 | 推迟内容回填 ≥90%；已删除的主题被重建 0 | todo |
| PM-14 | 决策补全 conflict_update / resolve / split；informed 由 recall_log + M02 信号判定（收回 G-06、G-10） | v3 §2.2.9 | 决策 op golden 全过 | todo |
| PM-15 | 迟交规则、按 conversation_id 去重、复述过滤（收回 G-05） | v3 §2.2.3、§3.4 | 迟交改写更晚决策 = 0；旧版当当前 = 0 | todo |
| PM-16 | TOPIC_SET_CHANGED 重做、幂等键、任务失败原因。含：`chat_time` 缺失时的批次键（Q-15）；失败批次可重新提交（Q-16）；热点 Space 并发新建耗尽 3 次预算的情形写进并发用例（review-triage Add-1、Add-2） | v3 §2.2.2、§2.2.10、§2.2.11 | 并发验收表；缺 `chat_time` 的两次同文提交各自整理；冲突超限的批次重交后能写入 | todo |
| PM-17 | 数据集 v2.1：多成员、多空间、多 domain、迟交、推迟、重复提交、闲聊负样本、相似名称对照组，约 50 个 topic；同时修 E-02（oracle 摘要随时间变化）、E-03（q17 答案与金标状态）、E-04（阅读模型样本） | v3 §2.2.7 验收 | 能测重复率与错误合并率；金标作被测系统时 answers.llm = 1 | todo |
| PM-18 | 11/13 交付评测集方案（PRD 待办 3） | PRD 待办 3 | 方案文档 | todo |

## W47（11/16–11/20）M2：search 补全与渐进式披露

| ID | 条目 | 出处 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| PM-19 | M08 三路召回：①用户记忆 ②agent L1/Skill ③project，降级标记 degraded。② 路的 LLM 过滤、分层、墙钟时效和失效的 `contextBudget` 按 Q-20 处理（review-triage Search-6、Search-7） | v3 §3.2.3 | 三路齐全或标记降级 100% | todo |
| PM-20 | M09 跨路 RRF、relativity 归一化、条目裁剪。三路只按名次融合，不拼接各路分数；relativity 改为 Q-01 的融合分归一（v0.1 用词法 / 向量相关度，阈值已改为按每个主题自身的相关度过滤，review-triage Search-3） | v3 §3.2.5、§3.5 | 确定性 100%；relativity 单调 | todo |
| PM-21 | 渐进式披露：会话开始 get_memory 索引、每轮 memories、工具 search_project_memory、get_memory_by_id。工具检索写 `via=tool`、不算本轮开始（Q-17）；宿主技能改查 `/api/openmem/v1/search/memory`，不再落到个人记忆（review-triage Search-4、Search-8、Search-9） | v3 §3.1–3.3 | 每轮注入 ≤ 全量的 30%；工具检索的召回记录 `via=tool` 100% | todo |
| PM-22 | 注入模板 1–4、strip_injected、search 技能。`degraded` 非空时模板与技能里可见（Q-21，review-triage Search-12） | v3 §3.3、§3.4 | 注入块回写 M02 = 0；降级结果渲染出提示 100% | todo |
| PM-23 | 检索延迟与 Recall@K | v3 §3.6 | 单路 P95 ≤800 ms，总 ≤1.2 s | todo |

## W48（11/23–11/27）M3：云端契约与验收

| ID | 条目 | 出处 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| PM-24 | cloud store HTTP 适配 + mock 契约测试 | v3 §5.2 | 同一批查询两种存储 Recall@K 差 ≤5% | todo |
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
| 2026-11-06 | 评审意见分诊（`.agents/work/20261106-review-triage`）：relativity 阈值改为按自身相关度过滤，`recallQuery` 改用 `clampText`；其余各条并入 PM-12、PM-13、PM-16、PM-19～PM-22 的范围与验收；需要裁决的写成 Q-15～Q-21 | 用户转来一组 add / search 评审意见 |
| 2026-11-06 | 主题归属实验改为 `gpt-6-luna` 的 chat completions 选择题（网关无 `/v1/decisions`），配置读 `~/.openai.env`，产品开关默认关闭。单独评测见 metrics R-20261106-01 | 用户要求用内部中转上的 gpt-6-luna 做选题实验，评测后不要挡住主开发 |
| 2026-11-03 | 初版 | 用户要求 W45 先出基础版本 |
| 2026-11-05 | 修正过期状态（PM-03、PM-10）；新增 PM-11b 与 `gaps-v01.md`（实现缺口 G-01～G-12、评测缺口 E-01～E-06）；PM-12～PM-15、PM-17 条目标明收回哪些缺口；增加金标作被测系统的阅读模型上限（R-20261105-03）和旧实现同口径对照（R-20261105-04：answers.llm 0.565，对 v0.1 的 0.609） | 用户要求核对项目状态，并解释 v1 的 95% 与 v2 的 60% 的差异：口径变了为主，v0.1 也有真实缺口 |
| 2026-11-05 | PM-11a 提前开工：8 项评审 MUST 修复并交接，复测见 metrics R-20261105-02 | 用户要求先修 MUST |
| 2026-11-05 | W45 收尾：v0.1 与数据集 v2 合入；评审各给出 changes-requested；新增 PM-11a 关闭评审 MUST | 两个独立会话完成开发，收尾会话评审与评测 |
| 2026-11-04 | 增加多 Agent 交接规范（`.agents/`）；metrics 记录改为每条收录全部指标 | 多个应用的 Agent 以 designer / developer / reviewer 接力 |
| 2026-11-04 | W45 增加评测基线：旧实现 + main 对照，被测模型改为 deepseek；token 限流与检索 LLM 过滤在评测配置中关闭 | 用户要求先有可比基线 |

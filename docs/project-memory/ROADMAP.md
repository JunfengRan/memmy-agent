# Roadmap

交付日 **2026-11-27（周五）**。范围：Local 全链路（SQLite Store 完整实现）；云端 Store 做 HTTP 适配，用 mock 服务做契约测试；之后在本地服务或测试机上做一次小范围云端测试。12/7–12/18 的联调评测不在本计划内。

状态：`todo` / `doing` / `done` / `blocked` / `moved`（移到其他周时写明去向）。每个条目写规格出处和验收。

## W45（11/3–11/6）M0：基础版本 v0.1，用来暴露问题

目标：端到端可跑，11/6 技术评审前拿到首批数，并据此修订文档。

| ID | 条目 | 出处 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| PM-01 | 治理落地：AGENTS.md、技能、docs/project-memory | — | 新会话能加载规则；4 个技能可见 | done |
| PM-02 | 评测清理：数据集只留一份，生成物移出 git | — | `git status` 不跟踪生成物 | todo |
| PM-03 | 评测数据集 v2：语料补成员身份、金标按 v3 重推、冲突改为按作者、题目清理 | v3 §2.2.5–2.2.9 | `load-eval-set` 校验通过 | todo |
| PM-04 | 评测脚本 v2：runner 只调规格接口，scorer 按 topic 计数、拆分 trap、独立评委 | v3 §3.2 | oracle 全 1、empty 全 0 | todo |
| PM-05 | contract/ 与 schema v10 建表 | v3 §5.1.5、§5.3 | typecheck 通过，迁移测试 | todo |
| PM-06 | SQLite Store：Space/domain、topic 读写、L03 条件写（revision、topic_seq、幂等键） | v3 §5.1.2、§2.2.10 | 409 后库不变；幂等重放无副本 | todo |
| PM-07 | add v0.1：raw_turns → Space 串行任务 → 一次 LLM 调用完成 M02+M04 → M05（add/join/rewrite/conflict_append，经验带 history，轨迹追加）→ ChangeSet → 条件写，冲突重合并 ≤3 次 | v3 §2.1–2.3 | PRD 决策维护逐轮表 golden 通过 | todo |
| PM-08 | search v0.1：project 一路，FTS5 + 向量，RRF + MMR + 时效/本会话优先，按 topic 截断，附 history/conflicts；get_memory、get_memory_by_id、get_task_status | v3 §3.2.2–3.2.5 | 检索确定性测试；topic_detail_list 形状 | todo |
| PM-09 | 删除旧实现（memories 表里的 project 行和 /api/v1 分支） | ADR-0002 | 普通 L1 召回不再出现 project 行 | todo |
| PM-10 | 跑 v2 评测出首批数；问题清单进 open-questions；ADR-0005 列出 v0.1 简化；W45 周报 | — | metrics.md 有第一行 | todo |

## W46（11/9–11/13）M1：按问题修订文档，补全 add

| ID | 条目 | 出处 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| PM-11 | 根据 v0.1 问题清单修订对齐表，起草给架构文档的修改意见 | — | open-questions 有提议和回复状态 | todo |
| PM-12 | M02 / M04 拆开：add 技能、topic 技能独立提示词 | v3 §2.2.5、§2.2.7 | 归类准确率、重复主题率有数 | todo |
| PM-13 | 推迟机制：deferred_segments 与后续回填 | v3 §2.2.7 | 推迟内容回填 ≥90% | todo |
| PM-14 | 决策补全 conflict_update / resolve / split；informed 由 recall_log + M02 信号判定 | v3 §2.2.9 | 决策 op golden 全过 | todo |
| PM-15 | 迟交规则、按 conversation_id 去重、复述过滤 | v3 §2.2.3、§3.4 | 迟交改写更晚决策 = 0 | todo |
| PM-16 | TOPIC_SET_CHANGED 重做、幂等键、任务失败原因 | v3 §2.2.10、§2.2.11 | 并发验收表 | todo |
| PM-17 | 数据集 v2.1：多成员、多空间、多 domain、迟交、推迟、重复提交、闲聊负样本、相似名称对照组，约 50 个 topic | v3 §2.2.7 验收 | 能测重复率与错误合并率 | todo |
| PM-18 | 11/13 交付评测集方案（PRD 待办 3） | PRD 待办 3 | 方案文档 | todo |

## W47（11/16–11/20）M2：search 补全与渐进式披露

| ID | 条目 | 出处 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| PM-19 | M08 三路召回：①用户记忆 ②agent L1/Skill ③project，降级标记 degraded | v3 §3.2.3 | 三路齐全或标记降级 100% | todo |
| PM-20 | M09 跨路 RRF、relativity 归一化、条目裁剪 | v3 §3.2.5、§3.5 | 确定性 100% | todo |
| PM-21 | 渐进式披露：会话开始 get_memory 索引、每轮 memories、工具 search_project_memory、get_memory_by_id | v3 §3.1–3.3 | 每轮注入 ≤ 全量的 30% | todo |
| PM-22 | 注入模板 1–4、strip_injected、search 技能 | v3 §3.3、§3.4 | 注入块回写 M02 = 0 | todo |
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
| 2026-11-03 | 初版 | 用户要求 W45 先出基础版本 |

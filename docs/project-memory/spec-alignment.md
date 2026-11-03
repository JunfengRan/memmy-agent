# 规格对齐表

对齐版本见 [spec-snapshots.md](spec-snapshots.md)。状态：`未开始` / `v0.1 简化` / `已对齐` / `待重新对齐`（规格变化后由 `pm-spec-sync` 标记）/ `偏离`（必须链接 ADR 或 open-questions）。

## 一、模块与接口

| v3 出处 | 内容 | 代码位置 | 状态 | 测试 / 评测 | 备注 |
| --- | --- | --- | --- | --- | --- |
| §1.6.1、§1.6.3 | `/api/openmem/v1/` 下 19 个方法的路径 | server/http.ts → project-memory/service.ts | 未开始 | HTTP 契约测试 | 旧实现挂在 `/api/v1/memory/*`，按 ADR-0002 删除 |
| §4（Space、domain 管理） | create/get/update/delete space；domains 增删改查 | store/、service.ts | 未开始 | | |
| §5.1.2 | ProjectMemoryStore 接口 | store/ | 未开始 | | |
| §5.1.5 | 错误码 | contract/ | 未开始 | | |
| §5.3 | SQLite 表 | storage/schema.ts v10 | 未开始 | 迁移测试 | |
| §2.2.1–2.2.2 M01 | 采集、raw_turns、剥离注入块、返回 task_id | organize/、pipeline/ | 未开始 | | |
| §2.2.3 | 会话上云 | — | 未开始 | | 本期只做 cloud store 适配 |
| §2.2.4 | Space / domain 校验 | contract/ | 未开始 | | |
| §2.2.5 M02 | 抽取：是否写入、回复拆分、字段判定 | organize/ + prompts/ | 未开始 | 评测 add 指标 | |
| §2.2.6 M03 | 归类用候选召回 | store/sqlite L01 | 未开始 | | |
| §2.2.7 M04 | 归入 / 新建 / 推迟，摘要描述改写 | organize/ + prompts/ | 未开始 | 重复主题率、错误合并率 | |
| §2.2.8 | 全量读 | store/sqlite L02 | 未开始 | | |
| §2.2.9 M05 | 决策 7 种 op、经验 4 种 op、轨迹 | merge/ | 未开始 | PRD 逐轮表 golden | |
| §2.2.10 | ChangeSet、条件写、结果码 | store/sqlite L03、pipeline/ | 未开始 | 条件写单测、故障注入 | |
| §2.2.11 | get_task_status | pipeline/ | 未开始 | | |
| §2.3 | OCC、Space 内串行、删除围栏 | pipeline/、store/ | 未开始 | 并发验收表 | |
| §3.2.1 | 会话开始索引（get_memory） | service.ts | 未开始 | | |
| §3.2.2–3.2.3 M08 | search_memory 三路召回 | retrieve/ | 未开始 | Recall@K | |
| §3.2.4 | L01 召回（FTS5 + 向量） | store/sqlite | 未开始 | | |
| §3.2.5、§3.5 M09 | RRF、MMR、条目裁剪、截断、recall_log | retrieve/ | 未开始 | 确定性测试 | |
| §3.3 M10 | 注入模板 1–4、检索工具 | inject/ | 未开始 | 渲染 golden | v3 放在 SDK |
| §3.4 | 三层剥离 | organize/、inject/ | 未开始 | | |
| §5.2 | 云端存储服务接口 | store/cloud | 未开始 | mock 契约测试 | 服务端不在本仓库 |

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
| 10 | 会话开始 | PRD 11/03 删除 `start_conversation`，改为按 `space_id` 调 `get_memory` | v3 仍写 `start_conversation` | 待 v3 更新；见 open-questions Q-03 |
| 11 | create_space | PRD 11/03：传 `space_name`，`space_id` 由 MemOS 生成；SDK 规格仍要求传 `space_id` | v3 未写明 | 按 PRD 11/03 实现；见 open-questions Q-04 |

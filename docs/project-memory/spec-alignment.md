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
| §2.2.1–2.2.2 M01 | 采集、raw_turns、剥离注入块、返回 task_id | organize/collect.ts、pipeline/ | 部分对齐 | | 未剥离 `<memos_context>`；跨 Space 复用同一批消息会丢（review R1-2） |
| §2.2.3 | 会话上云 | — | 未开始 | | 本期只做 cloud store 适配 |
| §2.2.4 | Space / domain 校验 | contract/ | 未开始 | | |
| §2.2.5 M02 | 抽取：是否写入、回复拆分、字段判定 | organize/organizer.ts + prompts/organize.ts | 部分对齐（与 M04 合成一次调用，ADR-0005 #2） | 数据集 v2 add 指标 | 不输出 dropped 原因 |
| §2.2.6 M03 | 归类用候选召回 | sqlite-store.ts | 已对齐（topic_k=10，纯词法兜底） | | |
| §2.2.7 M04 | 归入 / 新建 / 推迟，摘要描述改写 | organize/organizer.ts | 部分对齐（推迟只存不回填） | 数据集 v2 topics 指标 | ADR-0005 #4；Decisions 主题实验默认关闭（ADR-0006） |
| §2.2.8 | 全量读 | sqlite-store.ts | 已对齐 | decision golden | |
| §2.2.9 M05 | 决策 7 种 op、经验 4 种 op、轨迹 | merge/merge.ts | 部分对齐：缺 `split`；作者与 approved_by 未校验 | decision-golden.test.ts | review R1-4、ADR-0005 #1 |
| §2.2.10 | ChangeSet、条件写、结果码 | apply.ts、organize-job.ts | 部分对齐：deferred 事务、TOPIC_SET_CHANGED 未带 newTopicIds | store-commit.test.ts | review R1-3、R1-6 |
| §2.2.11 | get_task_status | api.ts | 已对齐 | http 契约测试 | |
| §2.3 | OCC、Space 内串行、删除围栏 | pipeline/、repositories.ts | 部分对齐 | 并发单测 | 失败任务阻塞队头（R1-7）；只有 local_queue 围栏 |
| §3.2.1 | 会话开始索引（get_memory） | api.ts | 已对齐（按 space_id 读） | | 无 start_conversation（Q-03） |
| §3.2.2–3.2.3 M08 | search_memory 三路召回 | retrieve/search.ts | 部分对齐：只有 project 一路 | 数据集 v2 search 指标 | ADR-0005 #6 |
| §3.2.4 | L01 召回（FTS5 + 向量） | sqlite-store.ts | 已对齐 | search.test.ts | 有任一过期向量即整体退词法 |
| §3.2.5、§3.5 M09 | RRF、MMR、条目裁剪、截断、recall_log | retrieve/search.ts | 部分对齐：条目裁剪只用词法 | 确定性测试 | RRF k=60（Q-01）；Decisions 选题默认关闭（ADR-0006） |
| §3.3 M10 | 注入模板 1–4、检索工具 | — | 未开始 | 渲染 golden | v3 放在 SDK；W47 |
| §3.4 | 三层剥离 | — | 未开始 | | W46（PM-15） |
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

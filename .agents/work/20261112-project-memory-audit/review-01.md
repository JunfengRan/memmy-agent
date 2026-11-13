---
item: 20261112-project-memory-audit
seq: 01
role: reviewer
app: Codex
model: GPT-6
date: 2026-11-12
reviewed: PM-05-09、PM-12～PM-23 的交接与评审及 11/11 收尾记录
range: 5e4d0920
verdict: changes-requested
---

# 评审 01：默认路径的边界缺陷需要修补

## 复核验证

当前工作区干净，分支与 origin 均为 5e4d0920。亲自重跑：Memory typecheck 通过；项目记忆、recall-candidates、CLI 和 openmem-cloud-client 共 22 文件，204 passed、1 todo；Memmy agent typecheck 通过，hook、client-tools、interactive-deadline 共 3 文件、59 passed。现有测试通过不能覆盖下列反例；developer 阶段先补失败用例。

## 意见

位置均指基线源码；不把待决设计改为实现任务。

| 编号 | 级别 | 位置 | 问题、依据与要求 | 验证 |
| --- | --- | --- | --- | --- |
| R1-1 | MUST | `Memory/src/service/project-memory/inject/strip.ts:17-46` | 非贪婪正则遇到同名嵌套块提前结束，外层尾部旧内容及闭标签残留。违反 v3 §3.4。剥掉完整闭合外层，保留未闭合文字的既有 Q-34 行为 | 同名嵌套、session 内 index、分块消息与工具参数回归；M02 请求无旧内容 |
| R1-2 | MUST | `App/memmy-agent/src/memmy-memory/hook.ts:929-955` | project 检索只在发请求前判轮次，响应后直接写消息；忽略已取消、已替换或超时轮次，且未共享交互剩余预算。违背宿主已有生命周期规则与 PM-22 不阻塞承诺 | 悬挂 transport、取消、新轮次替换、迟到响应不得注入；正常命中、空结果、降级与失败覆盖 |
| R1-3 | MUST | `Memory/src/service/project-memory/store/sqlite/local-state.ts:283-308`、`pipeline/organize-job.ts:167`、`inject/render.ts:111` 与 App 副本 | ISO 时区不同仍按字面值排序、过滤；上下文可能引用未来消息，历史折叠及最新进展选错。v3 §2.2.2 的带时区时间及 §3.3.4 的时间顺序要求按实际时刻处理 | 跨 UTC 日界和正负偏移的任务顺序、上下文边界、最新成员名、渲染测试；日期显示仍截原字符串 |
| R1-4 | MUST | `Memory/src/service/project-memory/api.ts:345` | `decodeURIComponent` 对畸形编码抛 URIError，用户输入变成 HTTP 500。按 §5.1.5 返回 INVALID_PARAMS，保持正常 ID 与不存在主题错误 | GET/POST 畸形编码 40001，合法编码正常，缺失主题 404 |
| R1-5 | MUST | `Memory/src/service/project-memory/store/sqlite/sqlite-store.ts:492-532` | 文档声明索引失败后主题仅词法，但内容更新没有撤销旧向量；异步旧索引写回也只检查主题存在，可覆盖新内容的向量。需在提交时使变更内容对应的旧向量失效，并在异步写回校验内容哈希及当前模型 | 文档向量化失败保留词法；旧请求晚到不能覆盖新向量；模型切换、删除后不写回；不改变 Q-30 整次退词法政策 |
| R1-6 | SHOULD | `docs/project-memory/README.md`、`ONBOARDING.md` | 入口先指向背景与实验，Agent 容易漏读协作记录；需区分 Agent 必经初始化与面向人的背景材料 | 入口链接与明确顺序核对 |
| R1-7 | SHOULD | `docs/project-memory/spec-alignment.md` §2.2.11；PM-16 review R1-1/R1-2 | 新重提任务只统计重跑 Space，说明不足；连续失败重提缺测试 | 记录汇总口径，连续两次重提回归；不改公开响应 |

## 覆盖与保留边界

- 请求与权限：归一化写路由和只读 token 用例仍在；Space/domain 校验、宿主绑定、recall_via 契约沿用，R1-4 修错误输入。
- 整理：抽取缓存、每草稿召回、M04 未知主题推迟、M05 作者与认可、迟交及 history 保护、split、OCC 三次重合并已对照代码和现有用例。Q-09/Q-11/Q-12/Q-23/Q-36 等未裁决项不修改。
- 本地存储：事务、幂等、删除围栏、推迟结算与任务重提有测试；R1-3/R1-5 补时间和向量异步边界。C01、云端与故障注入仍属 PM-24～PM-26。
- 检索：三路超时降级、确定性融合、阈值、实际返回主题的 recall_log 已核对；Q-28 缺省、Q-29 列表名、Q-30 整次回退和 Q-31 比例不改。
- 注入：历史 PM-22 R1-1 的 project_index 转义实际上已补（源码和现有测试），不重复报缺陷。宿主覆盖不足由 R1-2 补齐；不收敛跨包渲染副本，本轮以一致性测试防漂移。
- 进度：PM-12 实现完成与质量未达标必须分开；经验 F1 仍为 0。PM-13 回填评测已有证据；PM-21 注入占比、三类外部宿主钩子仍未验收。旧评审和指标不改写。
- 已知 worker failed 会阻塞后继的记录需核对实际失败状态含义，不能简单跳过可重试任务破坏 Space 串行。本轮不擅改共享 worker 的失败恢复语义。
- 初始化只改本仓库入口，不改全局配置，不读取历史方案冒充规格。实验脚本的 v2/v2.1 版本限制仍如实保留。

## 验收结论

5 项 MUST，2 项 SHOULD。先交 developer 修补，再提交独立 reviewer；本次审核不表示全功能达标，也不接替 PM-27 验收。无新增设计裁决。

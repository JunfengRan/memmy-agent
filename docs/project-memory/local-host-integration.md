# 本机项目记忆接入与 Add / Search 实现

本文描述当前已交付的 Memmy / Codex 本机接入，代码基线 b7cb8c56，设计见 [ADR-0012](decisions/0012-codex-local-project-bridge.md)。它是实现说明，不替代 standard 规格。

## 宿主如何接入

Memmy 的集成安装器向 Codex 用户目录安装 `hooks/memmy-resume-hook.mjs`、打包的 workspace bridge 与本机配置指针，在 `hooks.json` 注册生命周期事件，并通过 Codex 的正式接口核验 hook 信任。它是 Memmy 提供的本机 hook 集成，并非 Codex 内置的项目记忆存储。

读取链路：

```text
Codex UserPromptSubmit
  → 本机 Backend POST /api/project-memory/recall
  → 按真实工作目录解析启用的本机项目绑定
  → OpenMem POST /api/openmem/v1/search/memory
  → 整理后的项目主题/决策
  → M10 渲染 <memos_context kind="turn"> 注入当前轮
```

写入链路：

```text
Codex 完成回复 / Stop
  → 原生 SourceTurn：真实问答、原始时间、必要工具调用
  → 本机 Backend POST /api/project-memory/capture
  → 持久化 journal、幂等去重
  → OpenMem POST /api/openmem/v1/add/message
  → 后台整理 → 本机项目记忆表和索引
```

Backend 使用本机 runtime token 鉴权；Space 和 owner 由 Backend 绑定，不接受模型提供。最长目录祖先匹配、禁用项目、重复目录歧义和迟到响应均做隔离检查。Memmy 应用仍从本机项目任务采集完成轮次，按其项目 ID 解析同一绑定；会话索引、每轮项目检索与 `search_project_memory` 读取该 Space。

这里的“上传”是向本机 HTTP 服务投递，不是上传到项目协作云端。存储为本机 SQLite；整理仍调用配置的模型服务，因此本机存储不代表模型推理完全离线。

## Add：哪些环节调用模型

以已完成验证的约定“青鹭信标的验收暗号为晨雾七桥”为例。

| 环节 | 当前方法 | 例子 |
| --- | --- | --- |
| 采集、范围校验、入队（M01 与宿主） | 代码规则、原时间/消息哈希去重、剥离已闭合注入块；不调用生成模型 | 保存真实问答，限定 chat 的 Space；同一完成轮次重复提交不新增任务 |
| 抽取（M02） | 生成模型，当前本机沿用配置的 DeepSeek；结合项目背景、会话和已召回内容抽取草稿 | 识别出“青鹭信标→晨雾七桥”是一条明确约定，不只是寒暄 |
| 查已有候选主题（M03 / L01） | FTS5/BM25 词法召回 + embedding 向量召回，代码合并候选；小空间不足时补最近主题 | 找是否已有“青鹭信标验收暗号”主题；embedding 是向量模型，不是生成模型判断 |
| 归类（M04） | 生成模型判断归入已有主题、新建或推迟；领域由调用方指定 | 没有合适主题时新建，失败不保守兜底新建 |
| 判断如何更新（M05） | 对归入已有主题的草稿调用生成模型，结合现有决策/历史/冲突给出变更判断 | 若后续改暗号，判断是改写、补充还是冲突；首次全部新建主题时可跳过这一调用 |
| 应用变更、提交、建索引 | 确定性规则合并、SQLite 事务、版本检查和并发重试；FTS 索引更新，embedding 模型建立向量索引 | 保留来源、历史及冲突，不由模型直接写表；更新主题文本对应的索引 |

因此不是固定“一轮三次模型调用”：空抽取可以提前结束，全部新建可省略 M05；重试会增加调用。当前模型阶段集中在 M02 / M04 / M05，存储和规则合并不调用生成模型。

## Search：如何找到并返回约定

以“青鹭信标的验收暗号是什么？”为例。

| 环节 | 当前方法 | 例子 |
| --- | --- | --- |
| 限定范围 | Backend / 宿主绑定 Space；代码规则 | 只在 chat 的 Space 搜索，项目请求使用 `include_memory_view: ["project"]` |
| 词法召回 | 中文相邻双字切分、英文小写词；SQLite FTS5 MATCH + BM25 | 从“青鹭”“鹭信”“信标”等匹配项目主题文本 |
| 语义召回 | 当前本机使用 `Xenova/all-MiniLM-L6-v2` 生成查询向量，sqlite-vec 检索主题向量 | 查找语义接近的主题；依赖向量模型，不调用 DeepSeek 生成候选或改写问题 |
| 融合与过滤 | RRF 融合词法/向量名次，加确定性的更新时间/会话信号；条目用词面重合门槛裁剪；再做相关度过滤和 MMR 去冗余 | 选出青鹭主题及相关决策；向量命中主题不保证其中所有决策都被返回 |
| 返回与注入 | 代码按模板和 token 预算渲染，不调用生成模型 | 输出含“晨雾七桥”的 `<memos_context>`；工具路径渲染 `kind="tool"` |
| 最后回答用户 | 当前宿主的聊天模型 | Codex 或 Memmy 的 Agent 根据上述记忆生成自然语言答案，这是宿主回答，不是 Search 模型重排 |

默认项目 Search 不做生成模型重排。`decisions/` 的主题选择实验默认关闭，不把该实验写成日常路径。接口还支持个人/Agent 等召回通道，但当前项目桥接请求只启用 project 视图。向量不可用时会退到词法并报告降级；不能把降级结果当成完整召回。

会话开始的项目索引另走主题列表读取和模板渲染，不等同于每轮 Search；不必为读取索引调用生成模型。

## 如何确认不是其他记忆通道

项目记忆、个人 L1/L2 和协作轨迹并不是同一条路径：

- 项目记忆返回整理后的 topic、决策、经验、轨迹及相关历史/冲突，来源保留为溯源信息。项目原文在采集时作为整理输入，不代表检索时直接把整段原始聊天回灌。
- 个人记忆仍由原有 hook 流程独立采集和召回，可能与项目记忆共同出现在上下文。新增项目桥接没有全局关闭 L1/L2。
- 项目协作轨迹共享使用另一套协作接口；本轮保持云端写锁，不依赖协作轨迹共享完成项目检索。

不能仅因回答正确，或模型自述“来自项目记忆”，就判定链路通过。应核对项目主题所属 Space、原生来源会话、整理任务状态、实际注入/工具结果及 `recall_log` 的入口。

[独立评审](../../.agents/work/20261113-codex-memmy-project-bridge/review-01.md)已核对：Memmy 写入的青鹭约定，在全新 Codex 会话中形成完整项目注入块并正确回答，日志为 `via=turn_start`；Codex 写入的银杉约定，在全新 Memmy 会话中由真实 `search_project_memory` 工具返回并正确回答，日志为 `via=tool`。两个主题均保留原生写入来源。早期仅命中 L1 的回答未计入项目验收。

这些证据确认项目记忆实际参与并提供答案依据；本轮没有屏蔽其他通道做严格消融，因此不宣称宿主完全未参考个人记忆，也不宣称任意当前会话的答案都只来自项目记忆。详见 [真实验证记录](../../.agents/work/20261113-codex-memmy-project-bridge/validation-01.md)和 [metrics R-20261113-03](metrics.md)。

## 本机使用与限制

让 Memmy 本机项目与 Codex 项目使用同一个真实目录，通过 Memmy 现有集成安装流程更新 Codex hooks；Backend 为本机项目建立并保存 Space 绑定。保持 Memmy Backend 和 Memory 服务运行，在两端正常完成对话，等待整理后从另一端的新会话提问。

显式查询：

```sh
cd /path/to/project
memmy-memory project search "要查的项目约定" --source codex
```

未显式指定 Space 时按当前目录或 `--cwd` 解析绑定；不需要设置全局 Space 环境变量。显式 `--space-id` / `MEMMY_PROJECT_SPACE_IDS` 的旧 CLI 能力保留。

- 不自动补导历史 Codex 会话；失败/取消或没有有效回复的轮次不提交。
- 整理异步，历史任务积压可能造成明显等待。Backend 入队后有持久恢复/重试；请求到达 Backend 前失败，目前没有 hook 持久 outbox。
- Memmy 个人召回若耗尽既有共享交互预算，每轮项目 Search 会按超时保护跳过；项目索引和显式工具已真实验证，不能外推每次自动检索都成功。
- 开发版需准备本地 embedding 模型。此次本机使用已有离线缓存修复了缺失的模型目录；重装 Electron 资源后需重新准备，配置、缓存、数据库和密钥不提交。
- 原 release 前端及云端上传锁保持；本轮未做原生窗口点击验收或质量 benchmark。

## 实现入口

- Backend：`App/backend/src/services/project-memory-service.ts`、`adapters/inbound/local-api/routes/projects.ts`。
- Codex hook / bridge：`App/backend/src/adapters/outbound/skill-writer/`，Memory 自带集成在 `Memory/src/agent-source/integration/`。
- Add：`Memory/src/service/project-memory/pipeline/organize-job.ts`、`organize/`、`merge/`。
- Search：`Memory/src/service/project-memory/store/sqlite/sqlite-store.ts`、`retrieve/search.ts`、`retrieve/fuse.ts`、`inject/render.ts`。

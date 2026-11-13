---
item: 20261113-project-memory-desktop
seq: 01
role: reviewer
app: Codex / independent sub-agent
model: GPT-6
date: 2026-11-13
reviewed: handoff-01.md
range: a32c5fd0..2481e6ae
verdict: changes-requested
---

# 评审 01：基础闭环可运行，失败采集与配置恢复重试需修补

## 复核验证

独立阅读协议、工作项、交接、现行规格对应章节、ADR-0010，以及合并对 release 的增量与应用接入 diff。未修改实现。四侧类型检查按顺序执行全部 exit 0。

独立重跑：

- Memory：交接所列项目记忆、recall-candidates、token-usage-outbox、job-policy-registry、cli-command-map，25 文件，233 passed、1 todo。
- Backend：合并交接所列 7 个相关文件（服务、路由、协作、指令、Memory client），128 passed。
- Agent：交接所列 12 文件，185 passed。
- Frontend：交接所列 4 文件，30 passed。
- 额外真实 Memory 服务级反例：新建 in-memory MemoryDb，ProjectMemoryService 的 llm.isConfigured=false 时受理同一组带稳定时间的消息并处理任务，得到 failed / MODEL_NOT_CONFIGURED；补配置（isConfigured=true）后原消息再次 addMessage，返回同一 task_id 和 failed。脚本在忽略的 runs/20261113-desktop/review-retry.ts。此反例独立复现，不依赖 Backend 的 mock。

未独立重跑浏览器或迁移脚本；开发者已记录的桩冒烟证据仅按其限制引用，不外推真实模型效果、Electron 安装或云端成员共享。

## 上一轮 MUST

无。

## 意见

| 编号 | 级别 | 位置（交付基线） | 问题、依据与要求 | 验证 |
| --- | --- | --- | --- | --- |
| R1-1 | MUST | App/backend/src/services/project-memory-service.ts:33–42 | parser 只排除 row.status，但实际 Agent 的 saveTurn 把模型失败标在 assistant.model_error；恢复中断会写普通 assistant 文本 `Error: Task interrupted before a response was generated.`。两种记录都会被当作有最终回复的完成轮次整理，违反 ADR-0010 的失败/中断采集边界。应识别宿主真实格式并丢弃该轮，不把中断提示变成业务经验。 | 用保存格式的 model_error、恢复中断和前面已有工具步骤三种反例，确认不投递；正常轮次仍采集。 |
| R1-2 | MUST | App/backend/src/services/project-memory-service.ts:167–169、:215；Memory/src/service/project-memory/store/sqlite/local-state.ts:55–59 | UI 提示配置后重试，但 MODEL_NOT_CONFIGURED 不在可重提原因中；后端 retry 清 taskId 原样重交只能拿回原 failed 任务。上述真实服务反例已证实。应提供配置补齐后的有效重提，保持原消息与时间不变；不能绕开幂等伪造新输入，也不能顺带改变 Space/domain 不可重试语义。 | 真实 ProjectMemoryService：未配置失败 → 补齐配置 → 同消息重提得到新任务并完成；Backend 重试走同路径。 |
| R1-3 | SHOULD | App/backend/src/services/project-memory-service.ts:138–172 | tick 在全局 mutate 队列及跨进程配置锁内遍历所有 pending/running job，逐个等待 HTTP；大历史导入或服务慢时，关闭开关、重试等配置变更排在整个 backlog 后。建议投递采用有界批次，把网络等待移出全局配置锁，并在回写时检查绑定/任务版本；若本轮不收回，需要明确该可用性限制。 | 悬挂一个 add/status 请求时，关闭其他项目开关仍能及时完成；大导入不让控制操作等待整批网络调用。 |
| R1-4 | SHOULD | App/memmy-agent/src/memmy-memory/project-bindings.ts:9；Backend project-memory-service.ts:15、:80–84 | 所有原始投递消息与绑定共用一个 JSON 文件，Agent 前台每次读取都同步 readFile+JSON.parse 全量文件。历史越多，检索前的同步阻塞越大，无法被异步 deadline 中断。建议将只读小绑定与投递 journal 分离或做有界投影；若本轮保留，应说明尚无大历史规模验收。 | 大历史 journal 下，获取绑定不读取/解析正文，或有规模/延迟证据。 |

## 验收核对

分支基线、显式 Space 绑定、普通新轮次/历史导入去重、按会话空间及工具覆盖、主题/来源展示，均有代码及独立回归支持。失败轮次排除与配置恢复重试尚不满足，需 R1-1/R1-2 修补后复核。schema 与调度接线已检查，但不替代此前项目记忆审计和全量故障注入。

## 设计裁决

无新增设计裁决需求。原 20261112-project-memory-audit 状态保持不变。本结论不自行批准该审计。

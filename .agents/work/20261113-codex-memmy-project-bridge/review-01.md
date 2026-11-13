---
item: 20261113-codex-memmy-project-bridge
seq: 01
role: reviewer
app: Codex / independent sub-agent
model: GPT-6
date: 2026-11-13
reviewed: handoff-01.md、validation-01.md
range: a42c1443..b7cb8c56
validation: 38e386e0
verdict: approved
---

# 评审 01：本机 chat 项目双端互通通过独立复核

## 代码与单测复核

只读检查 Backend workspace recall/capture、两份原生 hook 与 runtime、共享 M10 渲染器、CLI cwd fallback、ADR-0012 及实际验证记录。未修改实现，未触碰密钥或用户模型配置。

预审发现的三项 MUST 已在正式代码 b7cb8c56 交付前修复：

| 预审问题 | 关闭依据 |
| --- | --- |
| 慢搜索期间目录归属变化后可能返回原父项目结果 | 响应后重新解析真实目录，完整比较 owner.id 与 Space；capture 进入持久事务后也重新解析；新增中途绑定子项目后丢弃迟到父项目响应的回归。禁用子项目不回落父项目。 |
| 外部原始 offset 时间可写入但 journal 只接受 Z，后续整个状态解析失败 | 持久 MessageSchema 允许 offset，原字符串保留；capture 后换服务实例读取并 tick 的回归通过。 |
| CLI cwd fallback 被误登记为 turn_start | BFF 受限 recallVia 枚举，CLI 明确 tool、prompt hook 明确 turn_start；domains/limit 转发有回归，Space/user 仍由 Backend 决定。 |

独立纯 Vitest：

- Memory local-project-bridge、cli-command-map：2 文件，46 passed。
- Backend project-memory-service、project-memory-routes、HTTP memory-client：3 文件，50 passed；加既有云写锁为 4 文件、52 passed。
- Backend memmy-resume-hook 模板：1 文件，16 passed。
- 合计交接所列 Backend 4 文件、66 passed，另外云写锁 2 项也通过。

按开发者要求，本轮不重建共享 dist，不影响运行中的真实实验。类型检查使用 handoff 中开发者已执行结果，本 reviewer 不将其写成亲自重跑。前端和生产云端 transport 锁与前一工作项相比无改动。

## 独立核对真实证据

除了读取忽略目录的 source-a/b.json、codex-injection-evidence.json、memmy-tool-evidence.json，还亲自只读解析对应原生完成文件及所选 journal/SQLite 记录；仅提取合成暗号命中、角色、ID、状态和入口，不打印个人正文或凭据。

- 同一 chat 绑定为 space_f641ecf022091925。Memmy 来源 websocket:8ee5115d-5734-4140-8f44-56eb6f91e6cf 与 Codex 来源 codex:01a1d392-7f5e-7962-8027-0bf0162a540f 的 journal 均 completed/error=null，真实 pm_tasks 两项也均 completed、error_json=null。
- Memmy 原生保存文件有真实用户约定和 finish_reason=stop 的助手完成回复；Codex 原生写入 rollout 有用户约定与 task_complete。不是手动伪造 add/message 作为宿主写入证据。
- Memmy → Codex：全新 Codex 会话 01a1d39b-d09f-7991-b100-712b0c82b57b 的原生 rollout 内，developer role 中存在完整闭合的 400 字符 `<memos_context kind="turn">` 项目块，含青鹭主题和合成暗号；无工具调用，最终答案命中。真实 pm_recall_log 为该 codex 会话、via=turn_start、topic_fb371750689945a3。
- Codex → Memmy：全新 Memmy 会话 websocket:99082023-5956-4a42-9886-01b0df18d5e0 的原生 JSONL 第 3 项为 search_project_memory 的 tool 消息，内含完整闭合 kind=tool 项目块、银杉主题与合成暗号；后续第 4 项为 finish_reason=stop 的正确答案。真实 recall_log 对该会话记录 via=tool、topic_1e40631ead3e4352。
- source-a/b 的归属均为同一 Space，来源 agent_id 分别是 memmy 与 codex，原生会话键与 journal/task 对应。

上述证据证明原生写入、真实后台整理与新会话跨端读取闭环，而不只是 CLI 查询成功或个人 L1 命中。

## 结论与保留边界

无未关闭 MUST，本工作项 approved，交 developer 收尾。CLI/工具与自动 hook 的范围、原时间和幂等实现可接受，原 release 前端及云端写锁保持。

批准范围不包括“每次 Memmy 自动项目检索都成功”：验证中 Memmy 自动回答只由项目索引支持，个人 L1 召回可能耗尽共享交互预算使每轮项目 search 跳过；显式工具检索已真实成功。后台积压造成的整理等待、Backend 离线前没有 hook 持久 outbox、journal 大规模同步读取等既有边界按交接保留。没有新增真实质量评测、原生窗口点击验收或云端存储实现声明。

本结论不追溯批准此前 20261112-project-memory-audit，也不改变未开发 PM 条目或待决算法语义。

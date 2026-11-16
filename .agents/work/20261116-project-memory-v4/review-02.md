---
item: 20261116-project-memory-v4
seq: 02
role: reviewer
app: Codex / independent sub-agent
model: GPT-6
date: 2026-11-16
reviewed: handoff-01.md、validation-01.md、review-01.md、metrics R-20261116-01
range: 7f4257b9..279d39b2
handoff: efe0fc33
verdict: approved
---

# 评审 02：本轮本机过渡重构通过正式复核

批准范围为用户确认的 memmy-agent 本机过渡重构：保留已有数据和双端接入，隔离管线/存储/模型边界，统一模板，退役召回记录并改按真实会话证据逐项裁决。无未关闭 MUST。此结论不批准完整纯云端 V4、全部模型质量或原生窗口/安装事件验收。

## 提交范围与上一轮意见

已确认代码提交 `279d39b218297fca56fab602504a64710bf7bd2e`，交接提交 `efe0fc33`。相对代码提交，当前 Memory、App、scripts、根 package.json 及本轮评测辅助代码没有差异；交接提交只增加 handoff。与 review-01 最后审查的实现一致，包含严格比较及明确裁决的 sameAs 兜底。未触碰另一任务的未跟踪工作项。

| 意见 | 结果 | 本次复核 |
| --- | --- | --- |
| R1-1 历史语义复述缺少表达通道 | 已关闭 | 提交包含 history:N 真实条目绑定、内容快照校验及 delegated 丢弃，含伪造引用反例。 |
| R1-2 部分裁决导致成员双归属 | 已关闭 | 与未告知项归属交叠时安全暂缓，意图保留、不改原快照；resolve/split 均有回归。 |
| R1-3 授权比较吞掉运算符 | 已关闭 | 证据相等只归一空白，保留符号/大小写；处理项快照严格相等，比较符号反例通过。 |
| 明确引文漏标当前项、明确裁决漏 resolve | 已关闭 | 严格引文匹配补全；仅明确信号、M05 sameAs、已告知且非迟交才兜底，不猜 new、不覆盖 split。最后工作区补丁已独立检查，正式范围回归再次通过。 |

## 亲自重跑提交代码

在 2026-11-16 15:10（上海时间）直接重跑 handoff 所列相关回归，三组有独立目录，不通过 npm 前置脚本改写源码：

| 工作目录及命令 | 实际结果 |
| --- | --- |
| Memory：`MEMMY_LOG_LEVEL=error npx vitest run tests/service/project-memory tests/local-project-bridge.test.ts tests/cli-command-map.test.ts tests/repository/sqlite-schema.test.ts tests/repository/worker-lease-schema.test.ts --silent --reporter=dot` | 27 文件，252 passed、1 个既有 todo。 |
| App/backend：`npx vitest run src/services/tests/project-memory-service.test.ts src/adapters/inbound/local-api/tests/project-memory-routes.test.ts src/adapters/outbound/memory-client/tests/http-memory-client.test.ts src/adapters/outbound/skill-writer/workspace-bridge/runtime.test.ts --silent --reporter=dot` | 4 文件，58 passed。 |
| App/memmy-agent：`npx vitest run tests/memmy-memory --silent --reporter=dot` | 10 文件，166 passed。 |

合计 476 项通过，未重复累计 review-01 的重跑。Memory 类型检查、模板生成一致性与空白检查的 reviewer 亲测见 review-01；developer 最终三处正式 typecheck 结果见 validation-01，不将其冒称本 reviewer 全部亲跑。

## 原始证据核验

亲自读取忽略目录 `eval/project-memory/runs/20261116-v4-smoke/` 的实际 JSON、相关脚本及只读 SQLite，而非只读交接中的数字：

- `current-final3/result.json`：8 个任务均 completed、17 次产品模型调用、8/8 明列硬检查通过。其提示词哈希与当前提交中的 extract/merge-judge 源文件一致。
- 核对 `after-resolution` 与历史前后快照、评委输出：已告知的 5 次成为当前，3 次归档、7 次仍为冲突；后续作者改为 9 次，5 次归档；Agent 历史换措辞后没有新增决策或挪动成员。最终 SQLite 实际为当前 9 次/成员 b、冲突 7 次/成员 c、历史含 3 和 5、8 个 completed 任务、召回记录 0 条，与对应 JSON 一致。
- `cross-host/result.json`：6/6；核对脚本确实经真实 Backend HTTP/journal、Memory 产品模型和宿主适配器，输入明确为合成保存 JSONL 与成功 SourceTurn。SQLite 来源分别为 memmy/websocket 与 codex 会话，原文没有注入哨兵。没有将其描述成 native UI 或已安装 hook 事件。
- `reopened-baseline/result.json`：5/5；另用产品同依赖 better-sqlite3 只读逐行比较基线与新打开副本的 8 类表，结果完全一致。旧库有 6 个任务和 3 条旧召回记录，后续读取没有改变旧记录。
- `judge-grounded-results.json`：gpt-4.1-mini、temperature=0、HTTP 200、843 tokens；核对 6/6 判定与逐字当前内容引用，实际数据相符。它是专项字段核验，不是全量质量评分。早期 HTTP400、错误评委判定和 final2 产品失败均保留且明确排除，没有将 completed 混同质量通过。

## 保留意见与验收边界

| 编号 | 级别 | 位置与实测 | 处理 |
| --- | --- | --- | --- |
| R2-1 | SHOULD，接受本轮保留 | `current-final3/result.json`：当前决策已先变为 5 次、后变为 9 次，但 `topic_description` 仍写重试 3 次；8 项硬检查没有覆盖描述同步。 | Developer 已接受并在 metrics、open-questions 与 validation 补充。用户本轮选择去日志、其他算法保持，因此不扩展为摘要生成质量专项；后续应补“裁决/改写后描述与当前结论一致”的真实回放及修复。不得把 8/8 写成完整主题状态或模型质量达标。 |

本轮真实历史复述由 M02 丢弃，不能单凭该回放声明 M05 same_history_as 的真实命中；后者已有专项单测。未运行 v2.1 全量评分，词法专项不证明向量质量；未进行原生 UI/安装事件、正式发布或 MemOS 云端部署验收。既有每轮共享预算、离线前未入队 outbox 与跨主题复述边界继续保留。

以上边界已如实登记，不构成本次用户限定的结构重构、无召回记录及旧数据兼容范围内未关闭 MUST。结论为 approved，交 developer 收尾。

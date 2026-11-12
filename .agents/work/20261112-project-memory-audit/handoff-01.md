---
item: 20261112-project-memory-audit
seq: 01
role: developer
app: Codex
model: GPT-6
date: 2026-11-12
branch: dev-project-memory-add-search-dev
base: 5e4d0920
head: 460f4f94
to: reviewer
status: ready-for-review
---

# 交接 01：审计修补已验证，等待独立复核

## 结论

已修复 review-01 的 5 项 MUST，并补上在线冒烟发现的 M05 缺少旧摘要描述输入；2 项 SHOULD 已回应。未自行判 approved。本地已实现链路能通过回归与针对性在线冒烟，不代表全量质量指标达标。PM-24～PM-27、待回复/暂缓项及默认关闭实验未动。

本轮随后提交初始化入口文档和本交接。普通推送结果在收尾 delivery 记录中追加；本文件不提前声称已推送。

## 改动与提交

| 提交 | 改动 | 依据 |
| --- | --- | --- |
| 3cbe57a5 | 按配对完整区间剥离嵌套块；raw turns/上下文/成员名按实际时刻排序；畸形 URI 返回参数错误；同事务使旧内容向量失效，异步回写校验当前内容哈希和模型；连续重提测试、汇总口径 | v3 §2.2.2、§3.4、§5.1.5；Store L05 的失败语义；Q-16/Q-25 |
| 66813231 | 判断输入补 current summary/description，提示词 pm-judge-v0.3.1；先失败的输入回归及 R-20261112-01 | v3 §2.2.7；ADR-0007 |
| 685e273b | 宿主索引和每轮 project 调用共享剩余交互预算，注入前检查轮次、取消与时限；两份渲染器按时刻排序，显示仍保留原日期；副本一致性和宿主测试 | v3 §3.3；宿主既有交互生命周期约束 |
| 460f4f94 | 验证 failed 队头先重排重试、成功后后继可租约；修正“永久阻塞”记录，未改共享 worker | v3 §2.3 Space 串行 |

没有公开字段、表结构或已定决策变化，因此没有新 ADR。未改变 M04 归属规则、确定性融合、词面门槛、Q-30 整次模型降级政策或 ADR-0007 的调用顺序。

## 验证

| 命令 | 实际结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过，exit 0（最终新增 worker 回归后重跑） |
| `cd Memory && npx vitest run tests/service/project-memory tests/service/retrieval/recall-candidates.test.ts tests/cli-command-map.test.ts tests/local-cloud-parity/openmem-cloud-client.test.ts` | 24 文件，214 passed、1 todo（Q-23 保留） |
| `npm --prefix App/memmy-agent run typecheck` | 通过，exit 0 |
| `cd App/memmy-agent && npx vitest run tests/memmy-memory` | 9 文件，107 passed |
| `node eval/project-memory/gold-add-memory/load-eval-set.mjs` | errors=[]；v2.1，113 traces、50 topics、31 questions |
| 在 gold-add-memory 运行 `node selftest.mjs` | 22/22 passed |
| `cd Memory && npx tsx ../eval/project-memory/latency/run-search-latency.ts --self-check` | 3 topics、2 rounds、q03、same JSON |
| 初始化入口及对齐/Roadmap 本地链接检查 | 6 份文档无失效目标 |
| `git diff --check` | 通过；生成物目录无被跟踪文件 |

先补回归时，旧实现 Memory 侧 6 项失败，App 侧 5 项失败；后续 M05 输入回归另有 1 项失败，均已通过。连续重提和 worker 排序是对既有正确行为的验证。App 测试曾因直接跨包导入触发 TS6059，已改为对共有渲染源码进行一致性检查并验证行为；最终 typecheck 通过。

在线验证见 [metrics R-20261112-01](../../../docs/project-memory/metrics.md#r-20261112-01)。两轮为合成的工程样例，不取金标领域。首轮暴露旧描述未更新；补齐输入后当前决策及描述均为五次、旧三次在 history。独立评委使用不同家族的 gpt-6-luna（ADR-0009 默认采样）。没有在线 embedding、回答模型、全量 v2.1 或生产 HTTP 传输验证；不把冒烟结果写入全量效果总表。原始输出和缓存均在忽略的 runs 下，没有密钥入库。

## 评审回应

| 意见 | 级别 | developer 回应 |
| --- | --- | --- |
| R1-1 | MUST | 已修复（3cbe57a5）。嵌套闭合块只计最外层删除区间；未闭合标签按既有 Q-34 行为保留。回归覆盖两种标签、不同类型嵌套、工具参数与未闭合外层 |
| R1-2 | MUST | 已修复（685e273b）。prompt/index 与 turn/search 均有总预算 race；响应后先验 signal/current/deadline，再写消息或缓存。覆盖 hanging、abort、supersede、正常命中、空/降级/异常 |
| R1-3 | MUST | 已修复（3cbe57a5、685e273b）。SQLite julianday、流水线 timeMs 和带时区渲染比较。Legacy 无时区的纯显示值保留字面顺序，避免依赖执行机时区 |
| R1-4 | MUST | 已修复（3cbe57a5）。GET/POST 的非法 URI 三种用例均 40001；合法编码缺失主题仍 404 |
| R1-5 | MUST | 已修复（3cbe57a5）。失败向量化、旧异步结果、模型切换、删除后回写有回归；不实现云端或 C01 |
| R1-6 | SHOULD | 已修复（本轮初始化文档提交）。AGENTS/README/ONBOARDING/DEVELOPMENT 区分 Agent 必经读取顺序与面向人的背景阅读，不改全局配置 |
| R1-7 | SHOULD | 已修复（3cbe57a5）。连续两次失败后第三次完成且重放不重复写入；文档明确只统计重跑 Space，旧成功结果查原 task_id |
| D1（finding-01） | MUST | 已修复（66813231）。目标主题旧摘要描述进 M05，提示词升版，在线冒烟发现并验证修补；质量外推限制见 metrics |

这些是 developer 修复声明，仍需独立 reviewer 逐项关闭，不修改 review-01 的原结论。

## 保留的问题和边界

- Q-09/Q-11/Q-12/Q-23/Q-28～Q-36 等待决语义不改；Q-18/Q-19 暂缓，Q-23 todo 保留。
- PM-12 的经验 F1、重复主题率仍以旧全量评测为准，未宣称改善或达标。
- 词面条目裁剪、缺省视图与列表名、旧向量模型整次回退、注入占比口径沿用已有记录。
- 三类外部宿主钩子、云端、C01、百次故障注入尚未进入本轮；worker dead_letter 与任务状态一致性没有作完整故障注入。
- 模板仍有跨包副本，本轮以一致性测试防漂移，不新增共享包；没有把实验脚本的 v2/v2.1 限制当成主产品缺陷。

## 请 reviewer 重点看

1. `Memory/src/service/project-memory/inject/strip.ts:19`：闭合区间配对和计数是否维持未闭合行为。
2. `Memory/src/service/project-memory/store/sqlite/sqlite-store.ts:497` 与 `:910`：同事务失效及异步哈希/模型检查。
3. `Memory/src/service/project-memory/merge/judge.ts:70` 与 `prompts/merge-judge.ts`：补旧文本的输入边界与 pm-judge-v0.3.1，不改变归属/作者规则。
4. `App/memmy-agent/src/memmy-memory/hook.ts:902` 与 `:935`：索引和每轮调用的剩余预算、取消及迟到副作用。
5. `Memory/src/service/project-memory/store/sqlite/local-state.ts:283`：julianday 过滤先于 LIMIT，及 Legacy 显示时间的处理边界。

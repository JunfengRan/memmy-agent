---
item: 20261116-project-memory-v4
seq: 01
role: developer
app: Codex
model: GPT-6
date: 2026-11-16
branch: dev-project-memory-add-search
base: 7f4257b9
head: 279d39b2
to: reviewer
status: ready-for-review
---

# 交接 01：V4 边界重构与召回记录退役

## 结论

代码、提示词、测试和文档已提交为 279d39b2，按用户确认范围保留本机部署、已有数据与 Memmy/Codex 接入。运行时不再读写召回记录，改为真实会话原文证据与逐项裁决。未部署或实现 MemOS 云端/Jev/L0/独立插件；未推送远端。

工作区独立代码复核的 MUST 已关闭，详见 review-01；该评审针对工作区，不自标最终提交 approved。本交接将代码与最终证据交 reviewer 绑定提交范围复核。

## 改动与规格

- pipeline/accept、prepare、organize、organize-job 分离受理、上下文/暂缓准备、阶段编排与结算；ProjectPipelineState/ProjectTaskRuntime 保持 SQLite 消息+任务+所有Space入队同事务。
- merge/apply 为存储无关纯应用；model/index 将向量化/补齐移出 SQLite，保留模型切换、内容hash和词法降级。
- M02 原文 disclosures、采纳来源；M05 逐项映射和 history:N 语义绑定；确定性合并限定 processedTargets。未告知项保留，成员归属冲突时安全暂缓。M02明确裁决+M05同结论绑定能兜底遗漏的冗余resolve标签。
- 模板唯一源，构建生成内置Agent和Backend资产，canonical剔除覆盖嵌套闭合与未闭合保留。
- 依据：V4 §2.2.8、§2.2.9、§3.4、§5.3/5.4；代码组织 §2.2/2.5、§3.4/4.3。本机过渡、原接口/日志表兼容与未开发范围见 ADR-0013。

## 实际验证

详见 validation-01 与 metrics R-20261116-01：

- 三处正式 typecheck 通过（Memory包含viewer）；Memory最终27文件252passed/1既有todo，Backend4文件58passed，内置Agent10文件166passed，共476项通过。
- 模板生成--check、两份hook构建与git diff --check通过。
- 固定真实模型专项：基线6批/15调用；最终8批/17调用，8/8强化硬断言。词法-only，不外推全量检索质量。
- 隔离双端adapter→真实Backend HTTP/journal→真实模型→两端注入器6/6；鉴权、去重、剔除、重启持久性均检查。
- 旧基线7f4257b9真实SQLite副本以新实现打开，8类表逐行不变、旧任务可读及主题可检索、旧日志不变，5/5检查。
- 不同家族gpt-4.1-mini/temp0核查实际DB字段，6/6判定且逐字引用验证通过；早期失败与错误评委结果保留并排除，详见metrics。

## 已知边界与偏离

ADR-0013：本机过渡部署、现有LLM与调度保留；本轮不做云端迁移或新产品待决项。旧内部ChangeSet缺少processedTargets仍兼容，生产管线显式带集合；对外无ChangeSet入口。

未跑v2.1全量质量评分、新一轮原生窗口/已安装native hook事件或发布安装验收。双端证据是合成原生格式输入经过真实适配/服务/模型，不伪称原生UI操作。保留原每轮共享预算、Backend离线前未入队outbox与跨主题复述局限。

## 评审回应

| 意见 | 回应 |
| --- | --- |
| R1-1 历史语义复述无法表达 | 279d39b2：history:N绑定真实历史内容快照，delegated丢弃；含伪造引用反例；reviewer已复核。 |
| R1-2 部分裁决成员双归属 | 279d39b2：归属交叠时保留快照并暂缓意图，两项回归；reviewer已复核。 |
| R1-3 授权比较吞掉运算符 | 279d39b2：只归一空白、保留符号，内容快照严格相等；反例与独立重跑通过。 |
| 真实回放漏content/resolve标签 | 279d39b2：严格逐字证据补全及已绑定sameAs兜底；保留失败final2，修复后final3 8/8。 |

## reviewer 重点

1. 新旧数据与队列payload的兼容，不恢复recall_log授权。
2. 部分裁决、split原ID的保留项、history事务和成员归属安全暂缓。
3. 真实评测范围不外推全量质量与原生窗口验收；最终提交范围与review-01一致。

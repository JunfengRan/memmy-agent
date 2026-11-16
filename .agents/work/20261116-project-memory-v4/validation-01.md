---
item: 20261116-project-memory-v4
role: developer
app: Codex
model: GPT-6
date: 2026-11-16
base: 7f4257b9
status: verified-with-boundaries
---

# 实现与验证记录

本轮沿已批准计划完成代码及文档；范围与过渡部署见 ADR-0013。真实模型专项见 metrics R-20261116-01，不把单测、合成适配回放或历史证据混写成新一轮原生窗口验收。

## 结构与兼容

同步受理的任务/消息/入队事务抽为 accept 与 SQLite task-runtime；ProjectPipelineState 解耦管线；worker 只负责结算，prepare/organize 分离。ChangeSet 应用在 merge/apply；IndexedProjectMemoryStore 负责模型编排，SQLite 仅查写向量。注入 render/prompts/strip 为唯一源，脚本生成 App/Backend 资产并检查漂移。

未改数据库版本和项目绑定/journal协议。旧 pm_recall_log 与历史数据保留但不读写；原合法 recall_via 兼容。Memmy、Codex 的归属、关闭、鉴权、重启、重试与项目隔离继续回归。没有部署 MemOS 云端、Jev、L0、新UI或独立插件。

## 行为修复与独立评审回应

- 原文 disclosures 校验真实 assistant 来源和引用，M05 对应当前目标；严格证据比较保留运算符/大小写，内容快照用严格相等。明确引用的相同文本确定性补全，语义改写由受约束模型对应。
- resolve/split 显式限定处理项，未告知或变化冲突保留；历史写入失败与成员/冲突/主题变更整体回滚。
- delegated 旧结论复述不加入成员；history:N 绑定真实历史快照支持非逐字复述。
- reviewer 的历史表达缺口、部分裁决双归属、符号比较三项 MUST 均已修复并独立复验。部分裁决存在成员归属冲突时安全暂缓，保留意图及原快照。
- 真实回放发现 M05 漏标 resolve：M02 明确信号 + M05 sameAs + 已告知 + 非迟交时确定性裁决，不猜新值、不覆盖 split。该补丁也已独立复核。

## 命令和证据

类型检查：npm --prefix Memory run typecheck；npm --prefix App/backend run typecheck；npm --prefix App/memmy-agent run typecheck。

相关回归：

```bash
cd Memory
MEMMY_LOG_LEVEL=error npx vitest run tests/service/project-memory tests/local-project-bridge.test.ts tests/cli-command-map.test.ts tests/repository/sqlite-schema.test.ts tests/repository/worker-lease-schema.test.ts --silent --reporter=dot
cd ../App/backend
npx vitest run src/services/tests/project-memory-service.test.ts src/adapters/inbound/local-api/tests/project-memory-routes.test.ts src/adapters/outbound/memory-client/tests/http-memory-client.test.ts src/adapters/outbound/skill-writer/workspace-bridge/runtime.test.ts --silent --reporter=dot
cd ../memmy-agent
npx vitest run tests/memmy-memory --silent --reporter=dot
```

模板一致性：node scripts/project-memory/sync-injection-assets.mjs --check；两份 workspace-bridge/build-runtime.mjs 均成功构建，无裸 import。git diff --check 通过。

真实评测命令（仓库根）：

```bash
node eval/project-memory/gold-add-memory/load-eval-set.mjs
MEMMY_LOG_LEVEL=error npx tsx eval/project-memory/runs/20261116-v4-smoke/smoke.ts baseline
MEMMY_LOG_LEVEL=error npx tsx eval/project-memory/runs/20261116-v4-smoke/smoke.ts current-final3
MEMMY_LOG_LEVEL=error npx tsx eval/project-memory/runs/20261116-v4-smoke/cross-host.ts cross-host
node eval/project-memory/runs/20261116-v4-smoke/judge-grounded.mjs
```

基线 6 批完成；最终 8 批、8/8硬检查，双端适配6/6，独立评委6/6。原失败final2完整保留。结果与局限见 metrics；最终代码完整回归计数在收尾记录追加，不用本文件虚构未完成命令。

## 验收边界

没有运行 v2.1 全量质量评分或新一轮 native UI/已安装 hook 事件。保留既有每轮召回共享预算与 Backend 离线前未投递 outbox 边界。任务内默认模型、用户日常配置和进程均未改。独立 reviewer 的代码复核通过不等同全部 V4 生产部署验收。

## 最终收尾结果

- Memory 正式 typecheck（含 viewer）：通过；Backend 与内置 Agent 正式 typecheck：通过。
- Memory 最终 27 文件 252 passed、1 个既有 todo；Backend 4 文件 58 passed；内置 Agent 10 文件 166 passed。共 476 项通过，未把重跑重复累计。
- 模板 --check、两份独立 hook 构建、git diff --check：通过。
- 旧版 SQLite 兼容副本：基线 7f4257b9 实际数据库复制后用新 MemoryDb、Store、状态类打开；8 类表逐行不变，旧任务可读、主题可检索、旧日志保持不变，5/5 检查通过。命令：`MEMMY_LOG_LEVEL=error npx tsx eval/project-memory/runs/20261116-v4-smoke/reopen-baseline.ts`。初版脚本误写旧表名 pm_conflicts、只读报错，改为实际 pm_decision_conflicts 后通过，未改源数据库。
- 独立 reviewer 已逐条关闭代码层 MUST，详见 review-01；该记录基于工作区，最终提交范围尚需正式交接复核，不自标 approved。

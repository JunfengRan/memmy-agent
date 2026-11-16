# 开发规范

规则摘要在仓库根 [AGENTS.md](../../AGENTS.md)，本文件写细则。

算法与失败样例见 [交接稿](algorithm-handoff.html)，实验名称与分支差异见 [实验说明](routing-experiments.html)。这里描述当前代码；ADR 中的初始版本号不必等于当前提示词版本。

## 开工顺序

先检查分支与工作区，读 `.agents/README.md`、`protocol.md` 及相关工作项全部交接与评审；再读本规范、spec-snapshots、现行 standard 对应章节、ADR、spec-alignment 与 open-questions。规格 SHA 不一致时先走 pm-spec-sync。面向人的背景文档不替代初始化必读项；默认关闭实验、未开发条目与待定项不自动进入修补范围。

评审先写 review，修补阶段切换为 developer。引用的修复代码提交后再写 handoff；未经独立 reviewer 复核不标 approved。

## V4 过渡实现（2026-11-16）

最高权威已更新为 standard V4 与配套代码组织设计，快照见 spec-snapshots。本轮交付范围按 ADR-0013：本机继续运行，不把 MemOS Python 目录结构机械搬到本仓库，不新增 SDK。

- pipeline/accept：同步受理并原子创建任务/入队；organize-job：worker 结算；organize：阶段编排与 OCC 重算；prepare：上下文、暂缓回填及审计组装。
- store/state：消息/任务状态端口；store/sqlite/task-runtime：本机队列装配；model/index：向量化与补齐；SQLite 只执行索引原语与存储。模型配置继续按调用时读取。
- merge/apply：存储无关的 ChangeSet 应用；merge/judge：带原文证据的逐项判断；organize/evidence：校验真实来源、逐字引文及采纳来源。
- 查询不写召回记录；旧 pm_recall_log 闲置保留。recall_via 兼容但无授权用途。不得恢复用“返回过”替代“助手在会话里告知过”。
- 注入资产改动后运行 node scripts/project-memory/sync-injection-assets.mjs；提交前运行同命令加 --check。只修改 Memory 的 render/prompts/strip 源码，不手改生成副本。

## 模块布局

```text
Memory/src/service/project-memory/
  contract/       实体、ChangeSet、召回契约与错误码
  store/          主题/管线状态/索引端口
    sqlite/       SQLite 表与索引原语、受理/队列事务适配
  model/          模型调用装配、查询向量化、文档向量补齐
  pipeline/       accept、prepare、organize、worker 结果结算
  organize/       会话采集、抽取、原文证据校验、候选及归类
  merge/          模型判断、确定性合并、纯 ChangeSet 应用
  retrieve/       项目排序与兼容三路混排（本机过渡）
  inject/         宿主注入渲染、剔除和工具协议
  prompts/        带版本号的产品提示词与模板
  decisions/      默认关闭的选题实验（不等同 V4 Jev）
  service.ts      门面及本机组合装配
```

M02 不读取记忆库；M03 召回摘要候选、M04 归类后全量读取目标主题，M05 判断并确定性组装 ChangeSet。条件写失败重新读取/判断，最多 3 次，不重放旧操作。新建主题围栏仍保留以兼容本机现有部署；尚未实现 V4 抽取并行/合并串行的两阶段调度。

## 可复用的现有代码

| 用途 | 位置 |
| --- | --- |
| 建表与迁移 | `Memory/src/storage/schema.ts`（`SCHEMA_VERSION`） |
| 按 scope 串行的任务租约 | `Memory/src/storage/repositories.ts` 中 `scope_key`/`scope_seq` 的租约查询；任务注册在 `Memory/src/service/worker/job-handlers.ts` |
| 抽取 → 候选 → 合并 → 写历史的流程参照 | `Memory/src/service/work-memory/work-memory-pipeline.ts` |
| 向量检索 | `Memory/src/storage/sqlite-vec-store.ts` |
| RRF、MMR、时效衰减 | `Memory/src/algorithm/plugin-algorithms.ts`（`assignChannelRrf`、`mmrSelect`、`priorityFor`） |
| LLM JSON 调用 | `Memory/src/model/llm.ts`（`completeJson`） |

## 编码规则

- ESM，导入带 `.js` 后缀；与 `Memory/src` 现有风格一致。
- 校验只在入口做一次（HTTP 层解析后交给 `contract/` 的校验函数），不在 client、http、service 三处重复。
- 模型输出一律经过 schema 校验；校验失败按任务内重试处理，重试用尽任务 `failed`，不写兜底数据。
- ID 在本机生成（v3 §2.2.10），topic 用 `topic_` 前缀，条目用 `dec_` / `exp_` / `tl_` 前缀。
- 时间统一 ISO 8601 带时区；条目 `time` 取消息的 `chat_time`。

## 测试

```bash
npm --prefix Memory run typecheck
cd Memory && npx vitest run tests/service/project-memory
```

- 每个模块一个测试文件，放在 `Memory/tests/service/project-memory/`，并在 `Memory/tests/service/README.md` 登记。
- golden 用例：PRD「决策的维护」逐轮表、「一个主题的演变」、v3 §2.2 / §3.2 的样例。
- 条件写必须测：409 后数据库不变、幂等重放不产生第二份、清空 conflicts 与写 history 同一事务。

## 评测

用 `pm-eval` 技能。数据集在 `eval/project-memory/gold-add-memory/`，生成物写 `eval/project-memory/runs/`。

```bash
cd Memory && MEMMY_MEMORY_PORT=18961 MEMMY_MEMORY_DB=/tmp/pm-eval/memory.sqlite npx tsx src/server/index.ts
```

每次评测在 [metrics.md](metrics.md) 追加一行：日期、commit、数据集版本、提示词版本、被测模型、评委模型、各项指标。

## 提交与 PR

- 工作分支 `dev-project-memory-add-search-dev`。
- 一个提交只做一件事；行为变化和文档更新放同一个提交。
- 提交前：typecheck、相关单测、必要时评测冒烟。
- PR 用 `memtensor-new-pr` 技能，先有 issue。

## 多 Agent 交接

designer / developer / reviewer 之间的交接按 [.agents/README.md](../../.agents/README.md) 和 [.agents/protocol.md](../../.agents/protocol.md) 进行：每个 Roadmap 条目对应一个工作项 `.agents/work/<PM-xx-短名>/`，developer 写 `handoff-NN.md`，reviewer 写 `review-NN.md`，designer 写 `design-NN.md` 或更新架构文档 / ADR。

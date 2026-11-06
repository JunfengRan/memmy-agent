# 开发规范

规则摘要在仓库根 [AGENTS.md](../../AGENTS.md)，本文件写细则。

## 模块布局

按 v3 §1.3 的模块编号组织，v3 §5.4.1 的 `project-memory-core/` 在本仓库对应 `Memory/src/service/project-memory/`。

```
Memory/src/service/project-memory/
  contract/   请求/响应类型、字段限长、错误码（v3 §5.1.5）、ChangeSet、RecallRequest/Result
  store/      ProjectMemoryStore 接口（v3 §5.1.2）
    sqlite/   L01 召回（FTS5 + sqlite-vec）、L02 全量读、L03 条件写、L05 向量化
    cloud/    云端存储服务的 HTTP 适配（/project/recall、topics:batchGet、commit）
  organize/   M01 采集与剥离注入块、M02 抽取、M04 归类与摘要描述改写
  merge/      M05 决策 op、经验 op、轨迹去重
  pipeline/   异步任务、Space 内串行、OCC 重试、任务状态
  retrieve/   M08 三路召回、M09 融合与组装
  decisions/  可选 OpenAI Decisions 主题归属，默认关闭（ADR-0006）
  inject/     注入模板与检索工具定义（v3 §3.3）
  prompts/    产品侧技能与提示词，带版本号
  service.ts  对外门面
```

| v3 模块 | 目录 | 说明 |
| --- | --- | --- |
| M01 会话采集 | organize/ | 写 `raw_turns`，剥离 `<memos_context>` |
| M02 抽取 | organize/ | add 技能；不读存储 |
| M03 候选召回 | store/ + organize/ | `recall(purpose="merge")`，topic_k=10，entry_k=0 |
| M04 归类与摘要 | organize/ | topic 技能；归入 / 新建 / 推迟。可选 Decisions 收窄候选，默认关闭 |
| M05 条目合并 | merge/ | 决策 7 种 op、经验 4 种 op、轨迹追加 |
| M08 多路召回 | retrieve/ | ①用户 ②agent ③project |
| M09 混排组装 | retrieve/ | RRF → MMR → 条目裁剪 → 附 history/conflicts → 截断 → recall_log。可选 Decisions 把选中 topic 提前，默认关闭 |
| M10 注入组装 | inject/ | v3 规定在 SDK；本仓库先实现模板与工具定义，供 Memmy 宿主和 SDK 共用 |
| L01–L05 | store/sqlite/ | |

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

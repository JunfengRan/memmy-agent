---
item: PM-05-09-v01-core
seq: 01
role: developer
app: Claude Code（独立会话「Build project memory v0.1」；该会话结束时没有写交接，本文件由收尾会话根据代码与实测补写）
model: claude-opus-5-5
date: 2026-11-05
branch: dev-project-memory-add-search-dev
base: 459a2972
head: 44dcbb1e
to: reviewer
status: ready-for-review
---

# 交接 01：v0.1 独立模块、异步整理与 project 一路检索

## 结论

v0.1 端到端可用：建 Space 和 domain 后，`add/message` 返回 task_id，后台按 Space 串行整理，`get/status` 可查；`search/memory` 返回 `topic_detail_list`，决策附 history 和 conflicts。旧实现已删除。尚未实现 split、三路召回、注入模板和云端 Store。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `storage/schema.ts` | v10：新增 `pm_*` 表、FTS、history 只追加触发器；旧 project 行软删除 | 独立存储 | v3 §5.3 |
| `project-memory/contract/` | 类型、限长、错误码 | 单点校验 | §5.1.5 |
| `project-memory/store/` | `ProjectMemoryStore` 接口与 SQLite 实现（召回、全量读、条件写、apply） | Store 抽象 | §5.1.2、§2.2.10 |
| `project-memory/organize/` | 采集 raw turns；一次模型调用完成抽取 + 归类 | v0.1 简化 | §2.2.5、§2.2.7 |
| `project-memory/merge/merge.ts` | 决策 add/join/rewrite/conflict_append/conflict_update/resolve；经验 add/update/history；进展去重 | M05 | §2.2.9 |
| `project-memory/pipeline/organize-job.ts` | worker 任务、OCC 重合并 ≤3、任务状态 | 异步 + OCC | §2.2.10、§2.3 |
| `project-memory/retrieve/search.ts` | FTS5 + 向量，RRF，MMR，时效，按 topic 截断 | M09 | §3.2.5 |
| `project-memory/api.ts`、`service.ts` | `/api/openmem/v1/` 路由与门面 | | §1.6 |
| `server/http.ts`、`memory-service.ts`、`types.ts` | 删旧实现，改为薄委托 | ADR-0002 | |
| `storage/repositories.ts`、`worker/job-handlers.ts` | `project_memory_organize` 任务按 scope 串行 | | §2.3 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过 |
| `cd Memory && npx vitest run tests/service/project-memory tests/storage/token-usage-outbox.test.ts` | 7 个文件、24 个测试全部通过 |
| `cd Memory && npx vitest run --dir tests`（全量） | 1473 通过、1 失败：`tests/build-standalone.test.ts`「No available node version satisfies 'v24.22.1'」，与本次改动无关（本机 pkg 工具链缺该版本） |

评测：见 metrics.md 中数据集 v2 的首条记录。

## 与规格的偏离和简化

见 [ADR-0005](../../../docs/project-memory/decisions/0005-v01-simplifications.md)。

## 评审回应

无（第一轮）。

## 请 reviewer 重点看

1. `Memory/src/service/project-memory/merge/merge.ts` — rewrite / conflict_append 的作者判定
2. `Memory/src/service/project-memory/pipeline/organize-job.ts` — OCC 重试与 TOPIC_SET_CHANGED
3. `Memory/src/service/project-memory/store/sqlite/sqlite-store.ts` — 条件写事务
4. `Memory/src/server/http.ts` — `/api/openmem/v1` 的读写权限

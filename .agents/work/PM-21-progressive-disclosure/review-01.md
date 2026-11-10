---
item: PM-21-progressive-disclosure
seq: 01
role: reviewer
app: Cursor
model: claude-sonnet-5-5-medium
date: 2026-11-10
reviewed: handoff-01.md
range: 3bbdf07a..eaefb0cc
verdict: approved
---

# 评审 01：工具检索记成 via=tool，实现与 ADR-0008 一致，无 MUST

## 复核验证

在独立 worktree（`/tmp/pm-review-pm21`，eaefb0cc，软链 node_modules）重跑，结束后已 `git worktree remove --force`。

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 退出码 0 |
| `cd Memory && npx vitest run tests/service/project-memory tests/cli-command-map.test.ts` | 退出码 0；17 个文件、179 通过、1 todo，与 handoff 一致 |
| `npm --prefix App/memmy-agent run typecheck` | 退出码 0 |
| `cd App/memmy-agent && npx vitest run tests/memmy-memory/client-tools.test.ts tests/memmy-memory/hook.test.ts` | 退出码 0；2 个文件、48 通过，与 handoff 一致 |
| `diff -q` Memory 与 App/backend 的 `memmy-default.ts`、`memmy-plugin.ts` | 均无差异（退出码 0）；`memmy-default.md` 只在 backend 一份 |

评测：handoff 写未跑。`git diff --stat 3bbdf07a..eaefb0cc` 不含 `docs/project-memory/metrics.md`，没有新分数冒充。30% 比例未测，已记在 Q-31 和 ADR-0008「影响」。

## 上一轮 MUST 的关闭情况

无。

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | SHOULD | `App/memmy-agent/src/memmy-memory/tools.ts:44`、`:287-291` | `SEARCH_PROJECT_MEMORY_FIELDS` 与结果包装是手抄 Memory 的 `PROJECT_MEMORY_TOOL_FIELDS`、`wrapToolResult`，两边漂移没有测试守着 | ADR-0008；v3 §3.3.5（模型只见 query / domains） | 在 memmy-agent 测试里断言字段名与 `<memos_context v="1" kind="tool">` 外层，或在 PM-22 渲染模板 3 时合并两处 | client-tools 测试里加一条字段与外层断言 |
| R1-2 | SHOULD | `Memory/src/cli/commands.ts:205-231` | 空间只来自 `--space-id` / `MEMMY_PROJECT_SPACE_IDS`，handoff 已列 Q-32。`--limit` 允许宿主调大 `memory_limit_number`，超出默认 3 | v3 §3.3.5 工具默认 3；ADR-0008 | 在 SKILL / project-search.md 里说明 `--limit` 是人工覆盖，模型路径不暴露；或等 Q-32 回复后再定 | 读 `references/project-search.md` |

## 重点 5 条核对

| 关注点 | 结论 | 证据 |
| --- | --- | --- |
| 1 非法 `recall_via` 不写召回记录 | 满足 | `api.ts` 的 `recallVia` 在调用 service 之前抛 `INVALID_PARAMS`；`http-contract.test.ts` 覆盖，179 通过 |
| 2 模型传来的 space / user / conversation 被覆盖 | 满足 | `bindProjectToolRequest` 只读 `args.query`、`args.domains`；`inject-tool.test.ts` 通过 |
| 3 `withApiPrefix` 对 `/api/` 不再加前缀 | 满足 | `http.ts` 对 `/api` 与 `/api/*` 原样返回，其余加 `/api/v1`；`cli-command-map.test.ts` 通过 |
| 4 没有空间不回落 `/memory/search` | 满足 | `projectSearchRequest` 无空间直接抛错；宿主 `registerMemmyMemoryTools` 无空间不注册工具，`projectSearchBody` 也抛错 |
| 5 两份模板一致 | 满足 | `diff -q` 无差异 |

红线：改动只在 `api.ts` 的入参解析与 `inject/tool.ts`，没有在存储层或云端加模型调用；`openmem-cloud-client.ts` 转发前删除 `recall_via`，符合 ADR-0008；`search.ts` 只改注释，排序逻辑未动，确定性不受影响。`memory-service.ts` 与 `server/http.ts` 无改动。

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| `recall_via=tool` 每行 `via=tool`；缺省 `turn_start`；非法 400 不写；缺 `conversation_id` 不写 | 满足 | `api.ts` `recallVia`；http-contract 测试通过 |
| 模型的 `space_ids` / `user_id` / `conversation_id` 被覆盖；默认 limit 3；外层 `kind="tool"` | 满足 | `inject/tool.ts`、`tools.ts` `projectSearchBody` |
| `via=tool` 不调 `/turns/start`；行进入 `recalledIds` / 已告知 | 满足 | ADR-0008；相关测试通过 |
| CLI 打 `/api/openmem/v1/search/memory`，无 space 不打 `/memory/search` | 满足 | `commands.ts`、`http.ts` |
| `get/memory/:id` 保持 `topic_detail_list` 信封 | 满足 | http-contract 契约测试通过，handoff 偏离表已列 |
| 未绑定不注册工具；绑定时请求体含 `recall_via: tool` | 满足 | `registerMemmyMemoryTools`；client-tools 测试 |
| 30% 比例未在实况回放测量 | 如实声明 | handoff、ADR-0008、Q-31 |
| 交接 | 满足 | handoff-01.md；eaefb0cc 已提交 |

模板 1–3 未渲染属 PM-22，不计入。

## 需要 designer / 用户裁决

无。Q-31、Q-32 仍待 designer 回复，不阻塞本项。

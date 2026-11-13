---
item: PM-21-progressive-disclosure
seq: 01
role: developer
app: Cursor
model: grok-4.7-xhigh-fast
date: 2026-11-10
branch: dev-project-memory-add-search-dev
base: 3bbdf07a
head: eaefb0cc
to: reviewer
status: ready-for-review
---

# 交接 01：工具检索记成 via=tool

## 结论

问项目的检索可以走 `memmy-memory project search` 和 `search_project_memory`，召回记录写 `via=tool`。没有绑定空间时不检索、也不注册工具。个人记忆的 `memmy-memory search` 不变。每轮注入占全量的比例没有在实况回放上量过。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `api.ts` | 本机字段 `recall_via` | HTTP 之前一律记成一轮开始 | Q-17、ADR-0008 |
| `inject/tool.ts` | 工具只暴露 query / domains，宿主填绑定和 `recall_via=tool` | 模型不能改检索范围 | v3 §3.3.5 |
| CLI 与两份宿主模板 | 项目问题走 openmem search | 原先落到个人记忆 | review-triage Search-8 |
| `App/memmy-agent` | 有绑定时注册 `search_project_memory` | 同上 | Q-32 |
| ADR-0008 | 本机字段，收回 ADR-0005 #9 的工具一半 | 契约变化 | ADR-0008 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过 |
| `cd Memory && npx vitest run tests/service/project-memory tests/cli-command-map.test.ts` | 17 个文件、179 通过、1 个既有 todo |
| `npm --prefix App/memmy-agent run typecheck` | 通过 |
| memmy-agent `client-tools` 与 `hook` 测试 | 2 个文件、48 通过 |
| 两份安装模板 `diff -q` | 无差异 |

评测：未跑。30% 比例未测，Q-31 仍待回复。检索算法未改。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| `get/memory/:id` 仍包在 `topic_detail_list` 里 | spec-alignment §4.3 |
| 空间只来自环境变量或 `--space-id` | Q-32 |
| 30% 口径未在回放上测量 | Q-31 |
| 模板 1–3 未渲染 | PM-22 |

## 评审回应

无。

## 请 reviewer 重点看

1. `Memory/src/service/project-memory/api.ts` — 非法 `recall_via` 不写召回记录。
2. `inject/tool.ts` — 模型传来的 space / user / conversation 被宿主覆盖。
3. `Memory/src/cli/http.ts` — 已是 `/api/` 的路径不再被加上 `/api/v1`。
4. 没有空间时不会回落到 `/memory/search`。
5. 两份模板内容一致。

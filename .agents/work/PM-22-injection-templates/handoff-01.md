---
item: PM-22-injection-templates
seq: 01
role: developer
app: Cursor
model: grok-4.7-xhigh-fast
date: 2026-11-10
branch: dev-project-memory-add-search-dev
base: f7eb0022
head: e980bf77
to: reviewer
status: ready-for-review
---

# 交接 01：注入模板和回写剥离

## 结论

模板一到三可以渲染。降级非空时有一句固定提示。闭合的注入块在进 M02 之前会被剥掉。工具结果默认是渲染文本，`--raw` 才是 JSON。Memmy agent 在已绑定空间时写入会话索引和每轮模板三。Claude、Codex、Cursor 的宿主钩子没有接。Q-21 的状态没有改。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `prompts/inject.ts`、`inject/render.ts` | 模板一到三，降级提示固定 | 宿主要看见降级 | v3 §3.3、Q-33 |
| `inject/strip.ts`、`collect.ts` | 闭合块剥离并计数；未闭合原样留下 | 注入不能写回 | v3 §3.4、Q-34 |
| `inject/tool.ts`、CLI、App 工具 | 工具结果走模板三 | 原先是 JSON | v3 §3.3.5 |
| `hook.ts` | 绑定空间后注入指南、索引和每轮记忆 | 渐进式披露 | v3 §3.1 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过 |
| `cd Memory && npx vitest run tests/service/project-memory tests/cli-command-map.test.ts tests/local-cloud-parity/openmem-cloud-client.test.ts` | 20 个文件、197 通过、1 个既有 todo |
| memmy-agent `tsc --noEmit` | 通过 |
| hook 与 client-tools | 2 个文件、48 通过 |
| 两份模板 `diff -q` | 无差异 |

评测：未跑。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| 无命中但降级时只注入提示 | Q-33 |
| 未闭合标签不删 | Q-34 |
| Q-21 文案改成覆盖整路失败，状态仍待回复 | Q-21 |
| 非项目记忆段落和三类宿主钩子不渲染 | spec-alignment |

## 评审回应

无。

## 请 reviewer 重点看

1. `inject/render.ts` — 降级提示在闭合标签之前，字段里的字面标签被换成全角。
2. `inject/strip.ts` — 只删闭合块。
3. 工具默认输出不再是 JSON。
4. 检索失败不挡住 Memmy 的这一轮。
5. Q-21 状态列没有被改成已关闭。

---
item: 20261111-closeout-eval
seq: 06
role: developer
app: Cursor
model: grok-4.7-high-fast
date: 2026-11-11
branch: dev-project-memory-add-search-dev
base: 47355fa0
head: 47355fa0
to: reviewer
status: ready-for-review
---

# 交接 06：v2.1 写入陈列页

无交付提交。`git rev-parse --short HEAD` 是 `47355fa0`。`item.md` 按本切片允许的文件没有改，工作项状态仍是 `in-progress`。

## 结论

同事页是 `docs/project-memory/add-showcase.html`。卡片只来自运行 B（`2026-11-11T04-21-01-504Z`）的 `final`：58 个主题，决策 61、经验 0、时间线 5。图和表的主题数、B³ 精确率、B³ 召回、F1、拆开、误并、条目 F1 直接读三份 `report.json`，没有重算。

逐主题的拆开 / 误并没有标。同一空间里，去掉空白后与金标必写条目的 `content` 完全相等，并且一对一，才算匹配。运行 B 这样对上 2 条（`dec_wh_mark`、`dec_fleet_wash`），拆开超额 0，误并超额 0。报告是拆开 9、误并 3。合计对不上，所以卡片上没有逐主题标记；9 和 3 写在跷跷板一节。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `eval/project-memory/gold-add-memory/build-add-showcase.mjs` | 新增。读运行 B 终态、金标和三份评分，生成自包含 HTML | 给同事看这次实际写下的主题，以及粗细取舍 | 本工作项范围；页面不是产品行为 |
| `docs/project-memory/add-showcase.html` | 由上面的脚本生成 | 陈列页 | 同上 |
| `.agents/work/20261111-closeout-eval/handoff-06.md` | 本交接 | 交给 reviewer | `.agents/protocol.md` |

## 路径

| 角色 | 目录 |
| --- | --- |
| 陈列（运行 B） | `eval/project-memory/runs/2026-11-11T04-21-01-504Z/` |
| 运行 A | `eval/project-memory/runs/2026-11-11T04-08-59-655Z/` |
| 旧实现 | `eval/project-memory/runs/2026-11-11T03-56-46-995Z/` |
| 金标 | `eval/project-memory/gold-add-memory/dataset/gold.json` |

重新生成：

```bash
node eval/project-memory/gold-add-memory/build-add-showcase.mjs
```

脚本会核对三份报告的主题数、B³ F1、拆开、误并、条目 F1 与下面这组三位小数一致，否则直接失败：运行 A 65 / 0.676 / 10 / 1 / 0.816，运行 B 58 / 0.700 / 9 / 3 / 0.861，旧实现 30 / 0.407 / 1 / 2 / 0.487。金标主题数是 50。

## 图上的数

点和表用的是报告原值。下表是脚本打印的字段，与三份 `report.json` 的 `detail.counts`、`scores["topics.bcubed.*"]`、`scores["entries.f1"]`、`errors["topics.duplicateTopics"]`、`errors["topics.wrongMerges"]` 相同。页上的三位小数是这些原值的 `toFixed(3)`。

| 运行 | 主题 | 精确率 | 召回 | F1 | 拆开 | 误并 | 条目 F1 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 65 | 0.855072463768116 | 0.5585470085470085 | 0.6757096603181696 | 10 | 1 | 0.8163265306122449 |
| B | 58 | 0.893939393939394 | 0.5752136752136752 | 0.7000035258444398 | 9 | 3 | 0.8611111111111112 |
| 旧实现 | 30 | 0.6097560975609756 | 0.3055555555555555 | 0.40710584752035534 | 1 | 2 | 0.48739495798319327 |

会话路由五个点没有重跑，用的是已发表均值：词法 2 / 0.043，Jev · gpt-6-luna 4.3 / 0.246，Super Agent · DeepSeek 16 / 0.986，Super Agent 协议 · gpt-6-luna 14.3 / 0.899，Jev 协议 · DeepSeek 6.0 / 0.391。页上写明这是 23 条消息、6 个原始会话的会话路由。

## 验证

| 命令 | 结果 |
| --- | --- |
| `node eval/project-memory/gold-add-memory/build-add-showcase.mjs` | 通过，exit 0。陈列 58 个主题；正文相等匹配 2，拆开超额 0，误并超额 0；逐主题标记无。三份报告原值与上表一致 |

`npm --prefix Memory run typecheck` 未跑：这次没有改 `Memory/`。评测未跑：按要求没有起服务，也没有调模型。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| 无产品行为变化。页上写的双层映射是已有建议，并写明没有进入 v3，代码里也没有 | 无 |

## 评审回应

无。本工作项里还没有 review。

| 意见 | 级别 | 处理 | commit / 理由 |
| --- | --- | --- | --- |
| 无 |  |  |  |

## 请 reviewer 重点看

1. `eval/project-memory/gold-add-memory/build-add-showcase.mjs` 的 `matchRequired` — 只在正文相等且一对一时计数；合计不是 9 和 3，因此 `highlight` 为假，卡片上没有拆开或误并。
2. 同文件的 `renderChart` 与 `assertRun` — 点的位置用报告原值，脚本用三位小数守住约定的 F1、拆开、误并和条目 F1。
3. `docs/project-memory/add-showcase.html` 第一节 — 只有运行 B 的终态；决策展开正文、冲突和历史。

## 交给下一个 developer

无。这次交给 reviewer。

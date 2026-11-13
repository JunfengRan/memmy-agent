---
item: PM-18-eval-scheme
seq: 01
role: developer
app: Cursor
model: grok-4.7-xhigh-fast
date: 2026-11-10
branch: dev-project-memory-add-search-dev
base: 6f4801ff
head: cb3cd2eb
to: reviewer
status: ready-for-review
---

# 交接 01：评测集方案

## 结论

方案在 `docs/project-memory/eval-set-scheme.md`。可跑数据仍是 `dataset/` 的 v2.1。v2 冻在 `history/v2/`。q17 答案、阅读模型上限和 q40–q47 的题型还没做，留在 PM-17。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `docs/project-memory/eval-set-scheme.md` | 写明一份可跑数据、大版本冻结、v2.1 的规模和还没做的验收 | PRD 待办 3 | PM-18 |
| `ROADMAP.md` | PM-18 改为 done | 方案已交付 | — |

## 验证

| 命令 | 结果 |
| --- | --- |
| 文档核对 | 方案与 `e5f03e43` 的数据集和 `history/v2` 一致。没有新跑测试 |

评测：未跑。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| q17 标准答案未改 | Q-14 |
| 阅读上限未在 v2.1 上复跑 | E-04，PM-17 |
| 三套系统对照和 OmniMemEval 开源未做 | 方案里写明留在方案外 |

## 评审回应

无。

## 请 reviewer 重点看

1. `docs/project-memory/eval-set-scheme.md` — 评分只读 `dataset/`，`history/v2` 不参与。
2. `--oracle` 的 answers.llm = 1 不被写成阅读上限已经达到。

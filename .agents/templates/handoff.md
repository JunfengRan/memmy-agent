---
item: <工作项 ID>
seq: <NN>
role: developer
app: <Claude Code / Codex / Cursor / ...>
model: <模型>
date: <YYYY-MM-DD>
branch: <分支>
base: <基线 commit>
head: <交付 commit>
to: reviewer            # reviewer | developer | designer
status: ready-for-review # 同步写入 item.md
---

# 交接 <NN>：<一句话说明这次交付了什么>

## 结论

<两三句话：现在什么能用、什么还不能用。>

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过 / 失败（贴关键输出） |

评测：<metrics.md 记录 ID，或「未跑，原因」>

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |

## 评审回应

<第一轮写「无」。第二轮起逐条回应上一份 review。>

| 意见 | 级别 | 处理 | commit / 理由 |
| --- | --- | --- | --- |
| R1-1 | MUST | 已修复 / 不同意 / 待裁决 | |

## 请 reviewer 重点看

1. `file:line` — 原因

## 交给下一个 developer

<只在 to: developer 时填写。>

- [ ] 剩余任务
- 如何继续：
- 已知的坑：

---
item: <工作项 ID>
seq: <NN>
role: reviewer
app: <Claude Code / Codex / Cursor / ...>
model: <模型>
date: <YYYY-MM-DD>
reviewed: <handoff-NN.md>
range: <base>..<head>
verdict: changes-requested   # approved | changes-requested | blocked
---

# 评审 <NN>：<结论一句话>

## 复核验证

<亲自重跑 handoff 中的验证命令，写结果。跑不了就说明原因。>

| 命令 | 结果 |
| --- | --- |

## 上一轮 MUST 的关闭情况

<第一轮写「无」。>

| 意见 | 结果（已关闭 / 未关闭 / 转裁决） | 说明 |
| --- | --- | --- |

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | MUST | `file:line` | | 规格 § / 红线 / 复现步骤 | | |

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |

## 需要 designer / 用户裁决

<没有就写「无」。>

---
item: PM-17-eval-ceiling
seq: 01
role: reviewer
app: Cursor
model: claude-sonnet-5-5-medium
date: 2026-11-10
reviewed: 无 handoff（直接评审提交）
range: 9c9f1c35~1..9c9f1c35
verdict: approved
---

# 评审 01：金标上限 answers.llm = 1 成立，无阻塞项

## 复核验证

| 命令 / 检查 | 结果 |
| --- | --- |
| `eval/project-memory/runs/2026-11-10T14-27-24-707Z/report.json` 是否存在 | 在（同目录还有 `live-run.json`）。已复核原始 JSON |
| `scores["answers.llm"]` | 1（四个题型 conflict / cross-project / plain / stale 均为 1） |
| `detail.questions` 中 `answer.correct === true` 的题数 | 31 / 31，没有 false |
| `scores["answers.rubric"]` | 0.871（27/31），与 metrics 一致；rubric 为 0 的题是 q03、q04、q05、q41 |
| 评委 / 阅读模型（report.judge、live-run.reader） | claude-haiku-4-5-20251001（提示词 v4，温度 0）/ claude-sonnet-4-6；两家同属 anthropic，与 `AGENTS.md`「评委与被测模型不同家族」不冲突，因为被测系统是金标、没有模型 |
| `git diff 9c9f1c35~1 9c9f1c35 -- eval/.../history` 与 `--stat` | 无改动。`history/` 最近一次提交仍是 e5f03e43 |

## 上一轮 MUST 的关闭情况

无。

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | SHOULD | `docs/project-memory/metrics.md` R-20261110-04 备注；提交说明 | 写「q24 的标准答案与决策原文一致」。实际 gold 是把 `dec_price.content` 的因果顺序调过：原文「price 表增加 amount 列，价格列表直接读这一列、不再拼装说明文字，因为价格查询太慢。」新答案「因为价格查询太慢。price 表增加 amount 列，价格列表直接读这一列、不再拼装说明文字。」事实一字不差，但不是逐字原文 | `gold.json` 中 `dec_price` 与 q24 `goldAnswer` 对照 | 备注改成「事实取自 dec_price，只把原因放到句首」 | 读 metrics 备注 |
| R1-2 | SHOULD | `docs/project-memory/metrics.md` 备注、`reader.mjs` v2 提示词 | q03 的回答仍写「记忆里没有具体的测试代码，无法说明断言和用例是怎么写的」，评委判对。v2 提示词只让阅读模型「用决策回答」，没有让它不再声明「无法说明」。1.000 部分靠评委对这句多余话宽容 | report.json q03 的 `answer.reason` 和 live-run.json 的回答原文 | 在备注里写明：q03 的 1.000 含这一处宽容；以后换评委或阅读模型时留意 | 读备注 |
| R1-3 | SHOULD | `dataset/gold.json`、`questions.json` | q24 标准答案改在 v2.1 内，没有改 mustInclude，也没有数据集版本或 changelog 记录；其他读者只看数据集看不出 R-20261110-02/03 与 -04 的标准答案不同 | 提交只改了这两个文件的 q24 一行，metrics 里写了但数据集目录没有 | 在 R-20261110-04 备注（或数据集 README）写明 q24 的标准答案在 v2.1 内改过，R-02/03 用旧答案 | 读 README 或 metrics |

三条都不阻塞，没有 MUST。

## 逐项核对（对应评审任务）

1. **原始报告**：在，answers.llm = 1，31 题全部 correct = true。数字取自 JSON，不是转引 metrics。
2. **rubric 不是 1 的题**：
   - q03：回答「没有客户名时，这笔不进月报」，mustInclude 是「没有客户名时这笔不进月报」，只多一个逗号。等价，评委判对合理。
   - q04：回答写出林工「没有客户名时这笔不进月报」与周工「只跳过金额列为空的行，空客户但金额还在的保留在月报里」两项，并要求确认以哪条为准。mustInclude 的「空客户但金额还在的会留下」只是「会留下」与「保留」之差，等价。
   - q05：回答「按整数“分”累加，不用浮点数，最后再换算成“元”显示」，mustInclude 是「整数分」，被引号隔开。等价。
   - q41：回答「过号的患者会被排到当前队列的末尾」，mustInclude 是「队尾」，同义。
   四题没有一题是评委把错误判成对。
3. **提示词 v2**：新增一行「问题问某项测试、规则或做法现在怎么写，而决策里已经写出这条规则时，用决策回答。不要因为记忆里没有贴出代码就说没有相关内容。」是通用规则，没有出现任何金标答案或 ledger、catalog 的具体内容，没有泄漏。
4. **q24**：新答案的事实全部取自 `dec_price.content`，不是按某次模型输出编的，只调了语序（见 R1-1）。`gold.json` 与 `questions.json` 两处一致。
5. **history/v2**：本次提交没有触碰 `history/` 或 `v2/`。提交只改 `gold.json`、`questions.json`、`reader.mjs` 与五份文档，属 v2.1 内小改。

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| 原始报告复核 answers.llm 与 31 题 correct | 满足 | report.json：answers.llm = 1，31/31 true |
| rubric 非 1 的题回答里有等价事实 | 满足 | q03/q04/q05/q41 逐题对照 |
| 提示词不泄漏金标 | 满足 | `reader.mjs` v2 diff |
| q24 来自 dec_price | 满足（语序调整，见 R1-1） | gold.json |
| history/v2 未改 | 满足 | git diff 无 history 改动 |

## 需要 designer / 用户裁决

无。

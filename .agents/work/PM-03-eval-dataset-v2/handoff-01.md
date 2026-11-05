---
item: PM-03-eval-dataset-v2
seq: 01
role: developer
app: Claude Code（独立会话「Fix project-memory eval dataset and scripts to v2」；该会话结束时没有写交接，本文件由收尾会话根据代码与实测补写）
model: claude-opus-5-5
date: 2026-11-05
branch: dev-project-memory-add-search-dev
base: 459a2972
head: 9aabf84b
to: reviewer
status: ready-for-review
---

# 交接 01：数据集 v2 与规格接口评测链路

## 结论

数据集 v2 可校验，oracle / empty 两端正确，runner 只调 `/api/openmem/v1`，回答由固定阅读模型基于渲染后的 `topic_detail_list` 生成。被测系统的 token 与费用还没有采集。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `dataset/` | 只留一份；`corpus.json` 两个 Space、3 名成员、35 轮；新增 `labels.json`、`questions.json`、`gold.json`；删除 alpha 时期文件 | 去重、对齐规格 | v3 §2.2.5–§2.2.9 |
| `build-gold-baseline.mjs` | 按标注与分歧场景推出金标 | | |
| `load-eval-set.mjs` | 去掉 alpha 不变量，改为校验 v2 | | |
| `run-memmy-live-eval.mjs` | 建 Space / domain → add_message → 轮询 get/status → 提问 → get_memory → 接口检查 | 只调规格接口 | §1.6 |
| `run-pipeline-eval.mjs`、`judge.mjs`、`llm.mjs`、`reader.mjs`、`oracle.mjs` | 一对一匹配、决策三态、topic 级 Recall、trap 拆分、独立评委 | ADR-0004 | §3.2 |
| `harness/` | main 对照组改用同一阅读模型；评测服务配置 | | |
| 收尾会话补充 | `llm.mjs`：Claude 5 模型不传 temperature（网关返回 400）；`harness/eval-config.yaml`：不扫描本机 Agent 会话 | 评测跑不起来 | |

## 验证

| 命令 | 结果 |
| --- | --- |
| `node load-eval-set.mjs` | `errors: []`，35 轮、5 主题、23 必写 + 12 可选条目、10 条负例、23 题、4 项接口检查 |
| `node run-pipeline-eval.mjs --oracle` | 全部得分 1、全部错误 0 |
| `node run-pipeline-eval.mjs --empty` | 全部得分 0 |

评测：见 metrics.md 数据集 v2 首条记录。

## 与规格的偏离和简化

README「规格含糊处」7 条；待登记到 open-questions（见 review-01 R1-8）。

## 评审回应

无（第一轮）。

## 请 reviewer 重点看

1. `run-pipeline-eval.mjs` — 一对一匹配与归属
2. `run-memmy-live-eval.mjs` — 接口检查
3. `dataset/labels.json` — 主题分组与必写 / 可选的划分

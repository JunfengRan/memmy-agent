---
item: 20261119-episode-gold-v3
seq: 01
role: reviewer
app: Codex
model: GPT-6
date: 2026-11-19
reviewed: handoff-01.md
range: 162a50e4..f84a5087
verdict: changes-requested
---

# 评审 01：补齐历史评测兼容与时点判定

## 复核验证

| 命令或独立检查 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 退出码 0。 |
| `node load-eval-set.mjs` 与 `node load-eval-set.mjs 2.1` | 两版 `errors:[]`。v3 有 78 个 Episode、97 个整理批次、43 个已提交 Topic、4 个暂存条目、36 道计分题。v2.1 有 50 个 Topic、31 道计分题。 |
| `node selftest.mjs` 与 `node --test episode-timeline.test.mjs` | 分别 25/25、4/4 通过。 |
| `node run-pipeline-eval.mjs --oracle` 和 `--empty`，再带 `--dataset 2.1` 重跑 | 四次退出码 0，`failures:[]`。v3 和 v2.1 分别核对 46 项和 44 项得分。报告输出到标准输出。 |
| 将 `history/v2.1/` 的五份 JSON 与 `162a50e4` 的 `dataset/` 逐一 `cmp` | 五份完全相同。 |
| `cd Memory && npx --no-install tsx ../eval/project-memory/latency/run-search-latency.ts --self-check` | 退出码 1，`gold datasetVersion is 3, expected 2.1`。 |
| `git diff --check 162a50e4..f84a5087` | 退出码 0。 |

## 上一轮 MUST 的关闭情况

无。

## 意见

| 编号 | 级别 | 位置 | 问题与依据 | 要求的结果及验证 |
| --- | --- | --- | --- | --- |
| R1-1 | MUST | `eval/project-memory/latency/run-search-latency.ts:45`、`eval/project-memory/gold-add-memory/build-add-showcase.mjs:291` | 检索延迟脚本读当前 v3 后触发原有 v2.1 版本断言，破坏原 README 的自检入口。历史写入陈列页同样从当前目录取金标，使用历史运行文件时会触发 50 个 Topic 的断言。 | 对绑定 v2.1 的消费者改用冻结数据。复跑检索延迟自检。用匹配的历史运行文件核对陈列页，或验证其金标读取和版本选择。 |
| R1-2 | MUST | `eval/project-memory/gold-add-memory/run-pipeline-eval.mjs:292` | 替换 oracle 的 q49 返回值为最终已映射到价格 Topic 的实际 ID，主题改名「价格列表取数优化」，只在摘要陈述「价格列表直接从 amount 列取价。」。评分仍给 `search.prematureVisibility=0`，回答保持正确时整次 oracle 的回答满分。当前只查精确主题名和整句包含，遗漏了评分器已有映射中的同一 Topic，也遗漏了改述的待提交证据。 | 提前披露覆盖已映射到目标的 Topic 和元数据中实际暴露的待提交事实。加回归覆盖无条目、有同一 Topic 的实际 ID，并覆盖可判定的摘要改述。 |
| R1-3 | MUST | `eval/project-memory/gold-add-memory/build-gold-baseline.mjs:335` | 校验开放期时使用批次首轮受理时间。将 q48 在内存改为查询 `tl_archive`，提问时刻设成批次首轮的 21:02:00，而产生该条目的 `t_archive_land` 到 21:12:00 才受理。生成器无报错并产生开放期提前披露陷阱。 | 以该 Draft 实际生效来源 Turn 的受理时刻校验开放期，并继续受批次关闭时刻限制。加入批次已开放、后续 Turn 尚未受理的回归。 |
| R1-4 | SHOULD | `eval/project-memory/gold-add-memory/dataset/episodes.json:74` | `ep_ledger_credentials_fix` 的原文及助手答复指向先前 README 凭据处理，`continues` 却指到另一个仓库分支决策。当前校验只要求先前同 Topic，语义关系需要更具体的来源。 | 把续接关系指到对应的凭据工作，抽查其他仅凭同 Topic 建立的续接。 |

## 验收标准核对

| 标准 | 是否满足 | 证据 |
| --- | --- | --- |
| 113 条轨迹中的 108 个原始 Turn 有唯一语义 Episode | 结构满足，续接有一处建议修正 | 校验与负例测试通过。门诊配置、到仓温检、日夜班调度三组 Topic 合并均与检视的原始话轮和具体工作边界一致。 |
| 冻结 v2.1 可重新生成、检查与评分 | 金标和评分满足，原有调用入口有回归 | 五文件字节一致，两版校验、oracle 与 empty 通过。见 R1-1。 |
| v3 覆盖开放、暂存、提交和旧结论时点 | 基础样例满足，仍需修复两个边界 | q48 与 q49 无已发布条目，q50 命中价格。裁决批次在 20:47:01 提交，20:40 的 q31 仍有两项结论，20:50 的 q31_after 将旧值列入历史。见 R1-2、R1-3。 |
| 独立评审 | 需修订后复核 | 3 条 MUST。 |

## 需要 designer / 用户裁决

无。

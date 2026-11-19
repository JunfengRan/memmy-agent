---
item: 20261119-episode-gold-v3
seq: 02
role: developer
app: Codex
model: GPT-6
date: 2026-11-19
branch: codex/project-memory-gold-v3
base: f84a5087
head: 3b9b8a65
to: reviewer
status: ready-for-review
---

# 交接 02：复核 v3 可见性和 v2.1 工具

## 结论

历史检索延迟和写入陈列页恢复使用 v2.1。v3 开放期按具体 Turn 受理时间确认，提前披露覆盖改名映射和元数据事实。四项评审意见已处理。

## 评审回应

| 意见 | 级别 | 处理 | 提交 |
| --- | --- | --- | --- |
| R1-1 | MUST | 历史延迟工具与写入陈列页通过版本入口读取冻结金标。用历史 run A、B、legacy 实际报告复核陈列页。 | `6922ab1e` |
| R1-2 | MUST | 已映射的改名 Topic 即使条目为空也记入提前披露。摘要和描述使用现有事实评委检查，离线测试替身验证改述分支。 | `553605fb` |
| R1-3 | MUST | 用操作的生效来源 Turn 作为开放期起点。回归覆盖批次已开启、目标 Turn 尚未受理，以及延期条目的生效来源。 | `9bea6b4f` |
| R1-4 | SHOULD | 凭据处理指回原始 README 凭据任务。月报金额裁决和样例排查指回打开同项问题的工作。删除仅凭 Topic 相同的四条续接。 | `3b9b8a65` |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 退出码 0。 |
| `cd Memory && npx --no-install tsx ../eval/project-memory/latency/run-search-latency.ts --self-check` | `self-check ok: 3 topics, 2 rounds, q03, same JSON`。 |
| `node eval/project-memory/gold-add-memory/build-add-showcase.mjs --check` | `Gallery is current; authored narrative unchanged.` |
| `node load-eval-set.mjs`、`node load-eval-set.mjs 2.1` | 两版 `errors:[]`。 |
| `node selftest.mjs`、`node --test episode-timeline.test.mjs` | 28/28 与 4/4 通过。 |
| `node run-pipeline-eval.mjs --oracle`、`--empty`，各用 `--dataset 2.1` 和 `--dataset 3` | 四次退出码 0，得分项分别 44 和 46，`failures:[]`。 |
| `git diff --check 995c5d60..HEAD` | 退出码 0。 |

## 评审重点

- `selftest.mjs` 的改名映射测试使用最终状态的实际 Topic ID，并省略条目。改述测试使用未映射的 ID，验证事实判断本身。
- `episodes.json` 的续接手工核对，生成的处理批次、可见性事件和计分内容与修订前一致。

---
item: 20261119-episode-gold-v3
seq: 01
role: developer
app: Codex
model: GPT-6
date: 2026-11-19
branch: codex/project-memory-gold-v3
base: 162a50e4
head: 43f4a48e
to: reviewer
status: ready-for-review
---

# 交接 01：语义 Episode 与提交时点金标

## 结论

v3 标注 78 个语义 Episode，包含 18 个多轮 Episode。46 个经复核的 Topic 中有 43 个在固定时钟回放结束时已发布。4 个仍暂存的条目随金标保留，未进入最终可见条目。历史 v2.1 的原始五份文件逐字节冻结。

## 改动

| 位置 | 改动与依据 |
| --- | --- |
| `eval/project-memory/gold-add-memory/dataset/episodes.json` | 按源会话标注 Episode，保留 Turn ID、原话与续接证据。`topicRevisions` 记录合并原主题的具体理由。 |
| `eval/project-memory/gold-add-memory/episode-timeline.mjs` | 根据虚拟受理时钟执行关段、暂存、Formation 和提交，生成可追溯的阶段事件。 |
| `eval/project-memory/gold-add-memory/build-gold-baseline.mjs` | 以提交时间生成问题快照，保留旧决策直到裁决生效，保留暂存证据。 |
| `eval/project-memory/gold-add-memory/run-pipeline-eval.mjs` | 按版本加载金标，识别提前披露，开放和暂存问题不进入正向召回分母。 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过，构建 agent-source-core 和检查 Memory、viewer。 |
| `node load-eval-set.mjs` | `errors:[]`，78 个 Episode，97 个整理批次，43 个已提交 Topic，36 道计分题。 |
| `node load-eval-set.mjs 2.1` | `errors:[]`，50 个 Topic，31 道计分题。 |
| `node selftest.mjs` | 25/25 通过。 |
| `node --test episode-timeline.test.mjs` | 4/4 通过。 |
| `node run-pipeline-eval.mjs --oracle`、`--empty` | v3 各 46 项得分符合 1 与 0 的预期，`failures:[]`。 |
| `node run-pipeline-eval.mjs --oracle --dataset 2.1`、`--empty --dataset 2.1` | 各 44 项得分符合 1 与 0 的预期，`failures:[]`。 |

验证记录为离线口径。固定时钟用 1 秒代表处理，按语义标签判断归类。历史 HTTP runner 固定使用 v2.1。v3 评分可接收按 `askedAt` 采集的显式版本运行文件。

## 评审重点

1. `eval/project-memory/gold-add-memory/dataset/episodes.json` 的续接或切分是否有直接证据，四个旧 Topic ID 的合并是否合理。
2. `eval/project-memory/gold-add-memory/dataset/questions.json` 的 `q31`、`q31_after` 和 `q48`–`q50` 是否与当时可见状态一致。
3. `eval/project-memory/gold-add-memory/episode-timeline.mjs` 的重发去重及暂存转提交是否保持来源顺序。

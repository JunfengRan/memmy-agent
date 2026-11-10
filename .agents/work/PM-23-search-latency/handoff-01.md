---
item: PM-23-search-latency
seq: 01
role: developer
app: Cursor
model: grok-4.7-xhigh-fast
date: 2026-11-10
branch: dev-project-memory-add-search-dev
base: 127cca7e
head: b5cb5822
to: reviewer
status: ready-for-review
---

# 交接 01：检索延迟 bench

## 结论

S 档、stub embedding 下，第 3 路 P95 0.741 ms，总检索 P95 1.462 ms，渲染 P95 0.008 ms，超时 0。门槛通过。金标灌库后的 Recall@1/3/9 是 0.581 / 0.968 / 0.968，不写入索引的 Recall@3。流水线 Recall 和 HTTP P95 没跑，阅读模型网关 2026-11-10 返回 503。检索算法没有改。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `eval/project-memory/latency/` | 金标灌库后计时 | 不调用对话模型也能测 P95 | v3 §3.6 |
| `metrics.md` R-20261110-01 | 记录实测数，流水线 Recall 为 not-run | 不拿旧数字顶上 | — |
| Q-35 | 门槛对应的语料规模未定 | S 档很小 | v3 §3.6 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `cd Memory && npx tsx ../eval/project-memory/latency/run-search-latency.ts --self-check` | 通过：3 topics, 2 rounds, same JSON（交接前重跑） |
| S+stub 的 JSON | `eval/project-memory/runs/pm23-search-latency-S-stub.json` 的 p95 与 metrics 一致：0.741 / 1.462 / 0.008 |

评测回放：未跑。原因是阅读模型网关 503。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| 两种存储的 Recall 差不做 | PM-24 |
| P95 用 50 个主题的 S 档 | Q-35 |
| ①② 路是空库，只说明链路开销 | latency README |

## 评审回应

无。

## 请 reviewer 重点看

1. `eval/project-memory/latency/run-search-latency.ts` — 数字来自实测 JSON，不是手填。
2. 索引表的 Recall@3 是 not-run。
3. 产品检索代码没有为了达标而改。
4. `runs/` 下的 JSON 不进 git。

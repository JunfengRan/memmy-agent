# 检索延迟

测 v3 §3.6 的单路、总检索和渲染耗时。语料是 `gold-add-memory/dataset/gold.json`（v2.1）灌进临时 sqlite，不读 `~/.memmy`，不调用聊天模型。决策选题保持关闭。

```bash
cd Memory && npx tsx ../eval/project-memory/latency/run-search-latency.ts --self-check
cd Memory && npx tsx ../eval/project-memory/latency/run-search-latency.ts --fixture S --embedder stub
```

`--self-check` 只灌 3 个主题，同一条检索跑两轮，两次 JSON 必须相同，然后退出。

`--fixture S`（默认）是全部 50 个金标主题，用来对照门槛。`--fixture L` 在被计分题问到的空间里，用固定句式补到 500 个主题，只作参照。填充句不复制题目原文。

`--embedder stub`（默认）用确定性哈希向量，不走网络。`--embedder live` 试一次本机配置的 embedder；失败就记下错误，这组数不参与门槛。

计时用 `performance.now()`。正式测量先丢掉 3 轮，再测 20 轮，样本是每一道计分题的一次调用。

- 第 3 路：`rankProjectCandidates`，不传决策模型
- 第 1、2 路：`recallCandidates`。库里没有个人记忆，结果记 `lane_empty: true`
- 总耗时：`handleProjectMemoryRequest` 的 `search/memory`，三路都开，`memory_limit_number` 为 9
- 渲染：对这次返回调用 `renderTurnMemories`（`kind: "turn"`）

分位用 `gold-add-memory/metrics.mjs` 的 `percentile`：按 `(n - 1)` 做线性插值，参数是 0–100。这不是 nearest-rank。

金标灌库后的 Recall@1/3/9 用保存的「金标主题 id → 库内主题 id」对照，公式与 `run-pipeline-eval.mjs` 相同：期望主题落在前 k 个里的个数，除以 `min(k, 期望个数)`，再对计分题取平均。这不是在线流水线的 Recall，也不写入 metrics 索引的 Recall@3 列。

门槛只看 S + stub：第 3 路 P95 ≤ 800ms，总 P95 ≤ 1.2s，渲染 P95 ≤ 5ms，超时为 0。超时按样本耗时是否达到 `recallPathTimeoutMs`（1200ms）计，本条目不改这个值。

`eval/project-memory/runs/` 被 gitignore 时，脚本把 JSON 写到那里，不提交。

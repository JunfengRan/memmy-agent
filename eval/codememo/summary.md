# CodeMemo 对照

J 是裁判判 CORRECT 的比例（原始分）。J-gated 是召回为 0、且题目不是负证据（never / not implemented 一类）时，把 CORRECT 改成 0。官方脚本对外报的 `j_score_overall` 是这里的 J-gated。F1 是对 `answer_short` 的 token 集合 F1，再乘 100。模型是 claude-haiku-5-5，不是 Hugging Face 卡片上的 gpt-4o-mini，所以不能和 Mem0 的 76 直接比。

修正后的作答协议：检索 20 条；回答和裁判的 `max_tokens` 都是 100；温度 0；关掉 thinking；`message.content` 为空时改读 `reasoning_content`，仍为空则把 `max_tokens` 提到 512 重试一次。空回答或空裁判记 WRONG。主表按项目切语料，和官方「每个项目单独索引、单独提问」一致。

<!-- MAIN_TABLE_START -->
## 主表：project_01，k=20，Memmy 使用摘要（50 题）

`project_01_cli_tool` 的 50 题（`p01_q001`–`p01_q050`）。该项目 315 条记忆全部有摘要，检索文本用的是摘要后的 `memory_value`，向量是这些摘要的 all-MiniLM-L6-v2。其他五个系统没有摘要，语料只含这个项目的 319 条会话，各自检索 20 条后用同一套修正协议打分。50 个题号相同。空回答 0。

| 系统 | J | J-gated | F1 | recall@20 |
| --- | ---: | ---: | ---: | ---: |
| entire | 66.00 | 56.00 | 18.03 | 58.13 |
| hindsight | 64.00 | 62.00 | 20.20 | 81.93 |
| mex | 56.00 | 46.00 | 19.41 | 58.13 |
| memorylake | 56.00 | 44.00 | 17.58 | 58.13 |
| memorax | 46.00 | 36.00 | 19.53 | 37.47 |
| memmy-original 有摘要 | 44.00 | 22.00 | 21.15 | 13.90 |
| memmy-project 有摘要 | 42.00 | 14.00 | 19.65 | 9.50 |

分类（factual 11，debug 9，architecture 8，temporal 8，convention 7，cross-session 7）。单元格是 J / F1 / recall@20。

| 系统 | factual | debug | architecture | temporal | convention | cross-session |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| entire | 72.73/18.05/63.64 | 55.56/14.71/62.96 | 62.50/20.35/61.46 | 50.00/17.71/43.75 | 71.43/22.63/71.43 | 85.71/15.40/42.62 |
| hindsight | 72.73/22.79/81.82 | 77.78/20.10/81.48 | 50.00/18.61/89.58 | 75.00/22.11/81.25 | 71.43/23.75/85.71 | 28.57/12.32/70.95 |
| mex | 81.82/15.83/63.64 | 33.33/20.75/62.96 | 62.50/22.58/61.46 | 37.50/16.60/43.75 | 85.71/24.43/71.43 | 28.57/17.89/42.62 |
| memorylake | 81.82/15.57/63.64 | 44.44/16.34/62.96 | 25.00/17.34/61.46 | 62.50/19.16/43.75 | 85.71/24.56/71.43 | 28.57/13.84/42.62 |
| memorax | 63.64/19.14/40.91 | 44.44/18.97/42.59 | 75.00/14.75/43.75 | 37.50/18.42/22.92 | 14.29/29.42/33.33 | 28.57/17.70/39.05 |
| memmy-original 有摘要 | 45.45/16.48/22.73 | 66.67/25.84/9.26 | 37.50/19.34/20.83 | 37.50/20.93/14.58 | 71.43/23.85/4.76 | 0.00/22.10/6.43 |
| memmy-project 有摘要 | 27.27/14.76/13.64 | 44.44/18.75/12.96 | 50.00/23.09/6.25 | 50.00/23.15/10.42 | 57.14/20.10/0.00 | 28.57/20.09/10.71 |

这一轮里原始 Memmy 的 J 是 44.00，含项目记忆的 Memmy 是 42.00。两边召回都低（13.90 和 9.50），所以 J-gated 掉到 22.00 和 14.00。Hindsight 召回 81.93，J-gated 只比原始 J 少 2 分。Entire 原始 J 最高（66.00）。`p01_q012` 在原始 Memmy 上只返回 8 条，其余 49 题和项目记忆臂的 50 题都是 20 条。

project_02、project_03 的摘要已停，不进入主表。

<!-- MAIN_TABLE_END -->
## 为什么不是 16 题，也不是 6.4 万条

测试集按项目切：project_01 有 50 题、319 条记忆；project_02 有 58 题、14121 条；project_03 有 50 题、51645 条。前 10% 的 16 题只是 project_01 的一部分。6.4 万条是三个项目的会话总和。证据标注只有 153 条，但摘要按项目里的记忆抽，因为检索搜的是整个项目。

## 补充表：全量 158 题，k=20，都不用摘要

同一套修正作答协议，158 题（`dd98c90`）。没有任何系统把摘要 worker 的 episode 卡片放进上下文。Memmy 的 trace 命中用会话原文，向量是复用的原文 MiniLM，不是摘要向量。用户在摄入时写下的 user memory 仍在，那不是摘要 worker 的产物。主表那两路「有摘要」的分不在这里。

检索范围：MemoryLake 和含项目记忆的 Memmy 按题目所属项目搜。MEX、Entire、MemoraX、Hindsight、原始 Memmy 搜三个项目合在一起的库。官方评测是每个项目单独建索引；这张表沿用上一轮补充表的全库范围，只有主表是按项目切的。

158 题里 Memmy 有 149 题返回 20 条。两边各有 9 题不足 20 条，因为产品检索在丢掉 episode 卡片后没有补满，不是打分中断。空回答 0。

| 系统 | J | J-gated | F1 | recall@20 |
| --- | ---: | ---: | ---: | ---: |
| mex | 53.16 | 28.48 | 19.10 | 26.54 |
| entire | 51.27 | 28.48 | 19.16 | 26.54 |
| hindsight | 48.73 | 27.85 | 17.06 | 28.44 |
| memorylake | 46.84 | 31.65 | 16.53 | 34.54 |
| memmy-original 无摘要 | 39.24 | 12.66 | 15.11 | 5.56 |
| memmy-project 无摘要 | 37.34 | 12.66 | 15.15 | 5.38 |
| memorax | 32.91 | 12.03 | 15.32 | 5.43 |

分类（factual 35，debug 31，architecture 28，temporal 22，convention 20，cross-session 22）。单元格是 J / F1 / recall@20。

| 系统 | factual | debug | architecture | temporal | convention | cross-session |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| mex | 60.00/19.82/28.57 | 51.61/20.63/39.78 | 67.86/20.38/30.95 | 31.82/16.34/15.91 | 75.00/22.06/23.33 | 27.27/14.21/12.58 |
| entire | 57.14/18.59/28.57 | 64.52/20.58/39.78 | 64.29/21.84/30.95 | 31.82/17.49/15.91 | 60.00/20.77/23.33 | 18.18/14.85/12.58 |
| hindsight | 57.14/17.66/27.14 | 61.29/17.55/39.25 | 60.71/18.62/42.56 | 27.27/13.95/18.94 | 55.00/21.20/21.67 | 18.18/12.79/12.95 |
| memorylake | 65.71/17.64/37.14 | 54.84/19.77/42.47 | 50.00/16.25/38.99 | 22.73/14.19/22.73 | 65.00/20.29/40.00 | 9.09/9.50/20.38 |
| memmy-original 无摘要 | 45.71/14.42/4.29 | 45.16/18.44/9.68 | 39.29/14.72/4.46 | 31.82/12.84/4.92 | 50.00/17.32/5.00 | 18.18/12.24/4.32 |
| memmy-project 无摘要 | 45.71/15.54/1.43 | 41.94/15.09/10.22 | 32.14/14.41/8.04 | 22.73/14.51/2.27 | 50.00/16.65/5.00 | 27.27/14.82/4.92 |
| memorax | 31.43/13.21/5.71 | 22.58/17.36/4.84 | 32.14/13.37/3.57 | 36.36/15.88/13.64 | 65.00/20.33/0.00 | 18.18/13.16/4.92 |

上一轮 k=8、未修空回答的全量分还在 `runs/<arm>.json`（Memmy 的 J 是 24.68 和 24.05）。那一版不要和这张表混用。

## Memmy 摘要开销

摘要 token 没有落盘。时长是日志实测。token 按 project_01 正文约 885 token/次估算，不是账单。Haiku 5.5 按输入 $0.10 / 百万、输出 $0.50 / 百万。其他方法建索引不调用大模型。

project_01 分两截。第一截 315 次带取舍，墙钟 279 秒和 316 秒，并发 24。被丢掉的 193 / 188 条已恢复，第二截关掉取舍再摘要，墙钟约 80 秒和 84 秒，并发 48。两截都是 0 次失败。

| 项目 | 含项目记忆的 Memmy | 原始 Memmy | 其他方法建索引 |
| --- | ---: | ---: | --- |
| 摘要调用 | 508 | 503 | 0 |
| 墙钟（两截相加，两边并行） | 约 6.7 分钟 | 约 6.7 分钟 | 本地计算，Hindsight 向量复用缓存 |
| 单次平均延迟 | 8.0 秒 | 8.6 秒 | — |
| 输出字符 | 87237 | 90111 | — |
| 估算输入 token | 约 45 万 | 约 45 万 | 0 |
| 估算输出 token | 约 2.2 万 | 约 2.3 万 | 0 |
| 估算摘要费用 | 约 $0.06 | 约 $0.06 | $0 |

这 50 题在 k=20 主表上的回答加裁判（实测，不含摘要）。Memmy 每条命中最长 4500 字，20 条叠在一起，输入 token 明显高于只拿原文片段的系统。

| 系统 | 输入 token | 输出 token |
| --- | ---: | ---: |
| memmy-project 有摘要 | 1755107 | 38691 |
| memmy-original 有摘要 | 1644437 | 36935 |
| memorylake | 445165 | 36092 |
| mex | 499736 | 36885 |
| hindsight | 849981 | 52585 |
| entire | 560223 | 36893 |
| memorax | 849451 | 36056 |

Hindsight 输出更高，因为每题回答前还有 reflect。MemoryLake 的回答输入最少。Memmy 多出来的是摘要阶段：约 500 次模型调用、墙钟不到 7 分钟、估算不到 $0.1。若把 project_02 的 13963 条也摘要完，按第二截的速度约 1 小时 40 分，估算输入约 1200 万 token/边，两边合计大约 $3。project_03 的 5.2 万条大约还要 6 小时。

## 代码路径和机制

下面这些 JSON 是第一轮 k=8、全文、未跑摘要 worker 的记录。k=20 的主表和补充表以上面两节为准。

### memmy-original

- 代码：`/root/rjf/memmy-agent-baseline/Memory/src/service/retrieval/retrieval-service.ts`
- commit：`8cd095c7f67300b6582a912bdd7fd33163d5e5b4` 分支 `HEAD`
- 机制是否跑到：True
- 说明：origin/main 8cd095c 的 MemoryService.startTurn，这是项目记忆合入前的默认分支，没有 project scope。同样只跑同步捕获和 FTS turn-start，k=8。

```json
{
  "topK": 8,
  "schemaVersion": 9,
  "memories": 64897,
  "projectScoped": 0,
  "duplicateOf": 0,
  "ingestStored": 66085,
  "ingestFailed": 0,
  "readyTextOnly": 64897,
  "projectContextQuestions": 0,
  "otherProjectHits": 342,
  "summaryWorkerDrained": false,
  "embeddings": false,
  "llmFilter": false
}
```

### memmy-project

- 代码：`/root/rjf/memmy-agent/Memory/src/service/retrieval/retrieval-service.ts`
- commit：`16ad2b526995284896867e6981d1fa73d73727d5` 分支 `dev-project-memory-beta`
- 机制是否跑到：True
- 说明：dev-project-memory-beta 的 MemoryService.startTurn。项目作用域、memory_scope=project、duplicate_of 和 projectContext 都走产品代码。摘要模型和向量 worker 没有跑，捕获后的 trace 标成 ready_text_only，检索是产品的 FTS turn-start，k=tier1+tier2=8。

```json
{
  "topK": 8,
  "schemaVersion": 10,
  "memories": 64897,
  "projectScoped": 64897,
  "duplicateOf": 9345,
  "ingestStored": 66085,
  "ingestFailed": 0,
  "readyTextOnly": 64897,
  "projectContextQuestions": 0,
  "otherProjectHits": 0,
  "summaryWorkerDrained": false,
  "embeddings": false,
  "llmFilter": false
}
```

### memorylake

- 代码：`/root/rjf/memmy-agent/.worktrees/memorylake/eval/project-memory/arms/run-memorylake.mjs`
- 机制是否跑到：True
- 说明：已裁定冲突（expectOpen 为 false）忘掉输家，再在同一项目内做 BM25。CodeMemo 没有现成冲突表，冲突来自会话里显式的 switched/changed/replaced from-to。

```json
{
  "topK": 8,
  "conflicts": 31,
  "forgotten": 30,
  "otherProjectHits": 0
}
```

### mex

- 代码：`/root/rjf/memmy-agent/.worktrees/mex/eval/project-memory/arms/run-mex.mjs`
- 机制是否跑到：True
- 说明：每条会话自审批后进入 BM25。同一项目同一文件后写且正文哈希变化则标 GROUNDING_DRIFT。漂移只计数，不从检索结果删除。

```json
{
  "topK": 8,
  "proposals": 66085,
  "selfApproved": 66085,
  "rejected": 0,
  "driftFlagged": 25305,
  "driftDeletes": 0
}
```

### hindsight

- 代码：`/root/rjf/memmy-agent/.worktrees/hindsight/eval/project-memory/arms/run-hindsight.py`
- 机制是否跑到：True
- 说明：四路、RRF k=60、MiniLM 重排都跑了。语义向量是 all-MiniLM-L6-v2 的均值池化余弦，不是词计数。Qwen3-Embedding-0.6B 在这台 CPU 上大约 1 条/秒，6.6 万条要十几小时，所以换成这个同样是本地向量模型的编码器。图扩散和 worktree 的 build_edges/graph_channel 在 25 条样本上对过 top-10。全库上语义边每个节点最多留 256 条超过阈值的边；第二步只从激活值不低于峰值 0.72 倍的节点继续扩散。时间路沿用原函数，英文问题额外用英文时间词触发。reflect 用本次 .env 的模型，在作答之前运行。

```json
{
  "semanticModel": "sentence-transformers/all-MiniLM-L6-v2",
  "semanticPooling": "mean",
  "semanticIsTokenCosine": false,
  "qwenNotUsedReason": "Qwen3-Embedding-0.6B measured about 1 text/s on this CPU, about 19 hours for 66085 turns. MiniLM is a real embedding model and finishes the same cosine channel.",
  "channels": [
    "vector",
    "bm25",
    "graph",
    "temporal"
  ],
  "rrfK": 60,
  "channelK": 10,
  "topK": 8,
  "rerank": "cross-encoder/ms-marco-MiniLM-L-6-v2",
  "crossEncoderRan": true,
  "graphVerifiedAgainstWorktree": true,
  "semanticEdgeCap": 256,
  "semanticEdgeCapRows": 40589,
  "largeGraphSourceCutoff": 0.72,
  "temporalQuestions": 12,
  "meanChannels": {
    "semantic": 10.0,
    "bm25": 10.0,
    "graph": 10.0,
    "temporal": 0.76
  },
  "reflectRan": true,
  "reflectModel": "claude-haiku-5-5",
  "constants": {
    "rrfK": 60,
    "thetaS": 0.55,
    "delta": 0.7,
    "sigmaHours": 6.0,
    "mu": {
      "entity": 1.2,
      "semantic": 1.0,
      "temporal": 0.8
    }
  }
}
```

### entire

- 代码：`/root/rjf/memmy-agent/.worktrees/entire/eval/project-memory/arms/run-entire.mjs`
- 机制是否跑到：True
- 说明：增量倒排，写入后立刻可搜。探针 zzdelta-marker 在同一次 add 后能被搜到。旧增量不删。CodeMemo 协议是先摄入全部会话再提问，所以全部增量在提问前写完。

```json
{
  "topK": 8,
  "immediateSearchProbe": true,
  "deltaOps": 66085,
  "deletedDeltas": 0
}
```

### memorax

- 代码：`/root/rjf/memmy-agent/.worktrees/memorax/eval/project-memory/arms/run-memorax.mjs`
- 机制是否跑到：True
- 说明：字符二元组重叠，不用向量，不处理冲突，不按项目过滤。同分偏向更晚的记录。

```json
{
  "topK": 8,
  "projectFilter": false,
  "otherProjectHits": 829
}
```

## 失败与省略

- 七个系统都跑完 158 题，没有缺席。Hugging Face 当前 main 删过 5 道坏证据题；本次用的是初始提交 dd98c90 的 158 题。11 个 Git LFS 会话已补下。277 条证据里有 9 条对不上可索引正文（空行或坏 JSON）。
- 原始 Memmy 用的是远程 `main` `8cd095c`（v1.2.3），单独 worktree 在 `/root/rjf/memmy-agent-baseline`。本地没有 main/master 分支；项目记忆提交的父提交 `8684cb57` 是开发线上的更晚一笔，不是默认分支。
- 主表是 project_01 的 50 题、k=20、有摘要。补充表是 158 题、k=20、无摘要。project_02 / project_03 的摘要已停。不要把主表的摘要分写进补充表。
- 项目记忆臂：64897 条 `memory_scope=project`，9345 条 `duplicate_of`，跨项目命中 0。`projectContext` 为 0，因为产品只在有 current_decision / checkpoint / topic，或另一个 agent 写过活动时才注入项目笔记；这批会话都记在同一个 cursor 源上，这些字段没有自动生成。
- 原始 Memmy 跨项目命中 342 条，说明它没有项目作用域。
- Hindsight 的向量没有用 Qwen3-Embedding-0.6B：这台机器没有 GPU，该模型大约 1 条/秒，全库要十几小时。语义路改成 all-MiniLM-L6-v2 的均值池化余弦。四路、RRF、交叉编码器重排和 reflect 都跑了。40589 个节点的语义边超过 256 条，只留了最强的 256 条。时间通道在 12 道英文时间题上非空。
- MemoryLake 从正文里的 switched/changed/replaced from-to 收了 31 条已裁定冲突，忘掉 30 条输家，再按项目做 BM25。CodeMemo 没有现成冲突表。
- MEX 标了 25305 条 GROUNDING_DRIFT，一条都没有从检索里删掉。
- Entire 的增量探针通过，66085 次增量都还在。
- MemoraX 不按项目过滤，829 条命中来自别的项目。长文本上字符二元组很容易饱和，同分又偏向最新记录，所以 recall 很低。
- F1 对着很短的 `answer_short`，而回答按公开提示写成两三句，集合 F1 会被多余词压低。J-score 才是对不对。
```


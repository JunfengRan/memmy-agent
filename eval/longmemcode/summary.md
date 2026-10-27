# LongMemCode 检索评测

全量跑完仓库里已发布的 **40 个语料、14 228 个场景**（9 类以上任务都在场景文件里）。打分用 LongMemCode runner 的确定性规则，没有用大模型当裁判。七个系统都跑完，没有中途失败的语料。

加权准确率是 runner 的公式：Completion 0.32、BugFix 0.22、Refactor 0.12、TestGen 0.10、FeatureAdd 0.10、ApiDiscovery 0.14，只对出现了的这些类重新归一。ControlFlow、Config 以及 v0.2 的工作流类计入原始准确率，不进这个加权分。

## 总表

| 系统 | 加权准确率 | 原始准确率 | P50 | P95 | P99 | 每千次查询 | 压缩比 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 含项目记忆的 Memmy | 63.75% | 69.27% | 0.155 ms | 3.842 ms | 8.699 ms | $0 | 7610 |
| MemoryLake | 63.15% | 68.82% | 0.004 ms | 0.209 ms | 0.600 ms | $0 | 5441 |
| Hindsight 四路检索（MiniLM） | 61.63% | 64.43% | 160.149 ms | 327.584 ms | 427.668 ms | $0 | 3644 |
| 原始 Memmy（main） | 60.33% | 65.74% | 0.720 ms | 10.175 ms | 18.501 ms | $0 | 7021 |
| Entire | 58.87% | 64.09% | 0.021 ms | 1.251 ms | 2.754 ms | $0 | 5652 |
| MEX | 58.84% | 64.07% | 0.022 ms | 1.481 ms | 3.119 ms | $0 | 5652 |
| MemoraX | 54.07% | 56.86% | 6.692 ms | 23.297 ms | 35.436 ms | $0 | 2591 |

压缩比 = 该系统看到的符号卡目录 token 数 / 单次查询平均返回 token 数。符号卡是评测自己建的稳定 ID 表，不是 git 源码树。所以这个数比论文里「相对整个仓库源码」的压缩更乐观，只适合系统之间比。

上一版 Hindsight（词计数余弦，时间路 0 次非空）加权准确率 50.74%，原始准确率 53.90%，P99 7.365 ms，场景数 14 228。该结果已被上表 Hindsight 行替代，原文件留在 `runs/hindsight-token-cosine.json`。其余六个系统没有重跑。

Hindsight reflect 另算，不进上表。见下文。Hindsight 的 P99 含每条查询的交叉编码器重排，以及一次单条 MiniLM 编码的中位耗时（4.253 ms）。文档向量在索引阶段算好，不计入这条延迟。

## 数据

- 上游：`/root/rjf/bench-eval/longmemcode/upstream`（CataDef/LongMemCode，浅克隆）
- 场景：`upstream/scenarios/*.json`，40 个文件，14 228 条，一个没删
- 符号卡：14 991 张，写在 `/root/rjf/bench-eval/longmemcode/index/docs.jsonl`
- 空 `contains`（官方规则下无论返回什么都记 1 分）有 455 条。把这种「空金标却返回了 ID」改记 0 分后，加权分只低大约 0.05 个百分点，不是分数的主要来源

符号卡只包含稳定 ID、从 ID 解析出的短名、类型后缀和路径片段。没有把某一问的 `expected` 列表写进卡片。查询字符串七个系统共用：短名查找用名字；完整 ID 查找把末尾标识符放在前面；`file_symbols` 用路径尾部；调用关系用稳定 ID 的末尾标识符。

没有克隆 `corpora/_work` 源码，也没有跑 SCIP / argosbrain-bundlegen。调用边没有从源码另抽，所以 `callers` / `orphans` 普遍很低，`lookup` 高。这是索引范围，不是把全量偷偷换成小样本。

## 各系统是否真跑到

1. **原始 Memmy**  
   `git ls-remote` 上默认分支是 `main`，提交 `8cd095c7f67300b6582a912bdd7fd33163d5e5b4`（Merge pull request #667，release/v1.2.3）。这棵树没有 `scope-weight.ts`。本地浅克隆原先没有这条历史，评测时 fetch 了这个提交，新 worktree 在  
   `/root/rjf/bench-eval/longmemcode/worktrees/memmy-main`。  
   检索调用的是该提交的 `Memory/src/algorithm/plugin-algorithms.ts` 里 `retrievePluginMemories`，层 L1，`mode=search`，limit 10（产品默认 tier1+tier2+tier3）。没有项目过滤。产品配置里的 LLM 候选过滤没有调用。

2. **含项目记忆的 Memmy**  
   `/root/rjf/memmy-agent`，分支 `dev-project-memory-beta`，`16ad2b526995284896867e6981d1fa73d73727d5`。只读。  
   同一套 `retrievePluginMemories`，再走 `Memory/src/service/project/scope-weight.ts` 的 `memoriesVisibleForScope` 和 `applyScopeWeights`。其它项目的 L1 被滤掉。自检确认过滤后的条数与该语料卡片数一致。LLM 过滤同样没跑。  
   全库放在一个 bank 里，所以项目过滤会压过跨仓库同名符号。这是它比原始 Memmy 高大约 3.4 个点的原因。

3. **MemoryLake**  
   机制来自 `/root/rjf/memmy-agent/.worktrees/memorylake/eval/project-memory/arms/run-memorylake.mjs`。  
   `keep_memory` 冲突门跑过：自检能忘掉输家；LongMemCode 没有冲突记录，实际遗忘 0 条。然后按项目做 BM25，top 8。

4. **MEX**  
   机制来自 `.../.worktrees/mex/eval/project-memory/arms/run-mex.mjs`。  
   14 991 张卡片全部自审批。同一文件后写且正文哈希变化就标 GROUNDING_DRIFT，标了 6 853 条，一条都没从检索里删。检索是全局 BM25，top 8。

5. **Hindsight（已重跑，替代词计数那一版）**  
   打分协议没变，仍是 LongMemCode runner 的确定性规则。只重跑了这一条臂。  
   四路和重排按 `.../.worktrees/hindsight/eval/project-memory/arms/run-hindsight.py` 的常数：语义余弦、BM25、图扩散（实体 / 语义 / 时间边，θ=0.55，δ=0.7，μ 分别为 1.2 / 1.0 / 0.8，两步同步扩散）、时间、RRF k=60，再用本地 `ms-marco-MiniLM-L-6-v2` 对融合池最多 20 条重排。每路最多 10 条、最终 top 8，与 `run-hindsight.mjs` 一致。  
   - semantic：`all-MiniLM-L6-v2` 均值池化、L2 归一化后的向量余弦。14 228 / 14 228 次非空。relay 脚本里的编码器是 Qwen3-Embedding-0.6B；这台机器没有 GPU，全量 14 991 张卡用的是已经在本地的 MiniLM。  
   - BM25：与 mjs 同一公式，13 194 次非空。  
   - graph：14 228 次非空。语义边按 θ=0.55 建了 21 120 946 条。全库时间戳跨度约 0.000004 小时，论文里的 24 小时时间边因此覆盖每一对卡；扩散用这个闭式。同语料实体边权重 0.6（系数 0.504）低于时间扩散系数 0.56，不改变图通道的前 10。  
   - temporal：14 228 次非空。接法写在下一段。  
   - RRF 之后 14 228 次都做了交叉编码器重排，再取 top 8。  

   时间路：发布场景没有 commit 时间。每张符号卡在 `index/docs.jsonl` 里已有 `at` 和 `at_ord`，是建索引时按该语料稳定 ID 的字典序写下的先后，形式为 `2020-01-01T00:00:00.{序号}Z`。代码查询没有 askedAt。时间路不再检查查询里有没有「现在|后来|之前|已经|目前|当时|还」。提问时刻取该查询所属语料中最大的 `at`（这批卡里的“当前”），通道返回离这个时刻最近的 10 张卡，也就是该语料 `at_ord` 最大的 10 张。范围限在该查询的语料内：全局序号把后面的语料全部标得更“新”，若用全局最新卡，每条查询都会拿到最后一个语料的符号。

6. **Entire**  
   机制来自 `.../.worktrees/entire/eval/project-memory/arms/run-entire.mjs`。  
   探针词 `zzdelta-marker` 在同一次 add 后能被搜到。正式索引对 14 991 张卡片各做了一次 delta，不重建、不删旧 posting。检索是这套 posting 上的 BM25，top 8。

7. **MemoraX**  
   机制来自 `.../.worktrees/memorax/eval/project-memory/arms/run-memorax.mjs`。  
   字符二元组重叠，全局池，同分偏向后写入的卡片，top 8。没有向量，没有冲突处理。

宿主没有参与打分。返回值是检索到的稳定 ID，不是模型生成的句子。

## Hindsight reflect（分开）

每个语料用固定种子 `longmemcode-hindsight-reflect:<语料名>` 抽样，最多 50 条，一共 **1 929** 条。模型 `claude-haiku-5-5`。0 次调用失败。

Reflect 只根据已经检索到的卡片写一段话。评分是这段话里是否出现金标稳定 ID，**没有写回上面的 61.63%**。

- 抽样加权准确率：**19.35%**
- 抽样原始准确率：25.27%
- 抽样条数：1 929（每语料最多 50）
- prompt tokens：4 675 370
- completion tokens：458 658
- 网关没有返回金额字段，所以 reflect 的美元费用记为未知，没有估单价
- 检索路径本身的 `cost_usd` 仍是 0，每千次查询 $0

## 省略与失败

- 没有省略任何已发布场景文件。40 个语料、14 228 个场景都有分。
- 没有克隆上游源码树，也没有生成 `.argosbundle`。原因是已发布场景已经带了评分用的稳定 ID；本机没有按语料脚本安装 scip 和 argosbrain-bundlegen。磁盘大约还有 50GB，空间不是省略原因。
- MemoryLake 在这套数据上没有可裁定的冲突，冲突门跑了但遗忘数为 0。
- Hindsight 已按真向量重跑。语义路是 MiniLM 余弦，时间路对 14 228 条代码查询都返回了该语料最新的 10 张卡，BM25、图扩散、RRF 和 MiniLM 交叉编码器重排都跑完。词计数那一版已归档。Qwen3-Embedding-0.6B 没有用来编码这 14 991 张卡。
- Memmy 的 LLM 候选过滤没有上全量。其余六个系统沿用已有分数。
- 七个臂都有分。Hindsight 重跑没有失败语料。Reflect 1 929 次调用 0 次失败。

## 文件

- 汇总：`/root/rjf/bench-eval/longmemcode/results.json`
- 分臂：`/root/rjf/bench-eval/longmemcode/runs/<arm>.json`
- 已被替代的 Hindsight 词计数结果：`/root/rjf/bench-eval/longmemcode/runs/hindsight-token-cosine.json`
- 本说明：`/root/rjf/bench-eval/longmemcode/summary.md`

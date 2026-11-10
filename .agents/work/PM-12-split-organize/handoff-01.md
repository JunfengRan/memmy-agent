---
item: PM-12-split-organize
seq: 01
role: developer
app: Cursor
model: grok-4.7-xhigh-fast
date: 2026-11-10
branch: dev-project-memory-add-search-dev
base: 6a6e194c
head: 018c169a
to: reviewer
status: ready-for-review
---

# 交接 01：整理拆成抽取、归属、判断三次调用

## 结论

add 的整理不再用一次模型调用做完抽取和归属。每个任务只抽取一次；主题集合变化时重跑召回和归属，版本冲突时只重跑判断。单测通过。数据集 v2 没有新分数：阅读模型网关返回 503，G-02、G-03、G-04、G-08、G-09 仍打开。

## 改动

| 文件 / 模块 | 改了什么 | 为什么 | 规格出处 |
| --- | --- | --- | --- |
| `prompts/extract.ts`、`organize/extract.ts` | M02 独立提示词 `pm-extract-v0.2.0`，输出草稿、信号、state_hints、dropped、deferred | 抽取不再看到候选主题 | v3 §2.2.5 |
| `organize/candidates.ts` | 每条草稿一条 query，按最好名次取并集，上限 20，mustConsider 保留 | 整批一条 query 会漏掉候选 | v3 §2.2.6 |
| `prompts/assign.ts`、`organize/assign.ts` | M04 `pm-assign-v0.2.0`，候选只有摘要和描述，带回 basis | 名称和条目不参与归属 | v3 §2.2.7、§2.3.2 |
| `prompts/merge-judge.ts`、`merge/judge.ts` | M05 判断 `pm-judge-v0.2.0` | 同一问题等标签在全量读之后给出 | v3 §2.2.9 |
| `merge/merge.ts` | 每个写入的 op 在 ChangeSet 旁带回 basis，不写入 op | 存储层只落 op | v3 §2.2.7 |
| `pipeline/organize-job.ts` | 抽取一次；TOPIC_SET_CHANGED 重跑召回和归属；VERSION_CONFLICT 只重跑判断 | 重试不再重放旧 ChangeSet，也不重抽 | v3 §2.3.1 |
| `store/sqlite/local-state.ts` | 任务详情放进 progress_json 的 details | get/status 不返回详情 | v3 §2.2.11 |
| `prompts/organize.ts` | 删除 | 旧的一次调用提示词 | ADR-0005 #2 |
| `decisions/0007-split-organize-stages.md` | 记录两次与 v3 的差异，并声明收回 ADR-0005 #2、#5 | 摘要改写提前、并集上限 20 | ADR-0007 |

## 验证

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 通过，exit 0（交接前重跑） |
| `cd Memory && npx vitest run tests/service/project-memory` | 8 个文件、36 个测试全部通过 |

评测：未完成。2026-11-10 数据集 v2 回放中，被测模型 deepseek-v4.1-flash-1017 的抽取、归属、判断调用成功。阅读模型 claude-haiku-5-5 经网关返回 HTTP 503（`model_not_found`），回放中止。本机向量模型同时 `fetch failed`，召回退成词法。`metrics.md` 没有新记录。

## 与规格的偏离和简化

| 内容 | 链接（ADR / open-questions） |
| --- | --- |
| 摘要和描述的改写放在判断调用里，早于确定性合并定稿 | ADR-0007 |
| 多条 query 的并集再截到 20；mustConsider 不受这层上限约束 | ADR-0007 |
| 复述与 recall_log 的比对仍不做 | ADR-0005 #3，PM-15 |
| 推迟内容仍只存不回填 | ADR-0005 #4，PM-13 |
| 决策仍没有 split | ADR-0005 #1，PM-14 |

## 评审回应

无。

## 请 reviewer 重点看

1. `Memory/src/service/project-memory/pipeline/organize-job.ts:261` — VERSION_CONFLICT 只把判断标成需要重跑，抽取结果留着。
2. `Memory/src/service/project-memory/pipeline/organize-job.ts:265` — TOPIC_SET_CHANGED 清掉归属、保留抽取，并把 newTopicIds 放进 mustConsider。
3. `Memory/src/service/project-memory/organize/assign.ts` — 候选请求体没有主题名和条目；未知 topic_id 推迟，不新建。
4. `Memory/src/service/project-memory/merge/merge.ts` — basis 不进 ChangeSet。
5. 默认路径不调用决策模型；选题实验仍在归属前收窄候选。

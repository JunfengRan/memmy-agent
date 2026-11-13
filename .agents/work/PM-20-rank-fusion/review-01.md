---
item: PM-20-rank-fusion
seq: 01
role: reviewer
app: Cursor
model: claude-sonnet-5-5-medium
date: 2026-11-10
reviewed: handoff-01.md
range: 44f1dedd..b78996ac
verdict: approved   # approved | changes-requested | blocked
---

# 评审 01：三路按名次融合，没有 MUST，通过

## 复核验证

在独立 worktree（b78996ac，软链主工作区 node_modules）重跑，跑完已移除 worktree。

| 命令 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | exit 0 |
| `cd Memory && npx vitest run tests/service/project-memory tests/service/retrieval/recall-candidates.test.ts` | exit 0，16 个文件、135 个测试通过、1 个 todo，与 handoff 一致 |

评测：`git diff 44f1dedd..b78996ac -- docs/project-memory/metrics.md` 为空，没有用新分数冒充评测；提示词也未改。列表名未改（Q-29）、过期向量整次退词法（Q-30，ADR-0005 #11）属已知范围，不计入意见。

## 上一轮 MUST 的关闭情况

无。

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | NIT | `.agents/work/PM-20-rank-fusion/item.md` 验收标准 | 第 4 条写「167 passed」，handoff 和本次复核都是 135 passed + 1 todo，数字不一致 | protocol §4 状态必须真实 | 下次更新 item.md 时改成 135；不阻塞 | 对照测试输出 |
| R1-2 | NIT | `retrieve/fuse.ts` `assignRelativity` | 与 `fuseRanked` 内的「先按 own 过滤再 MMR」重复一层阈值语义，函数 doc 说「search 调用时不带 threshold」，但现在 search.ts 已不调用它，只有 fuse 内部使用 | 可读性 | 可顺手收紧注释；不阻塞 | 阅读 |

## 对 handoff 五条重点的核对

1. 融合只用名次：`fuse.ts` 的 `fused = 1/(RRF_K + rank)`，输入 `FuseCandidate` 没有分数字段；`recall-paths.ts` 的 `RecallCandidateView` 去掉了 `score`，只有 `relativity`。平手顺序为 fused、路径（user、agent、project）、路内 rank、id，全部确定，没有时钟、随机和模型调用，符合 §6.1 #9。
2. 阈值在 MMR 之前：`pool` 先按 `own >= threshold` 过滤再 `mmr`；展示值在 `assignRelativity` 里按输出顺序取累计最小，列表单调。
3. 只查 project 时第一名不变：project 路内排序保留原 `fused` 降序、topicId 次序；融合后第一名 own 为 1，MMR 首选即最高 own，与原第一名一致。JEV 实验（默认关闭）改为在路内调整顺序，不碰默认路径。
4. `sqlite-store.ts` 未出现在 diff 中，过期向量逻辑没有改。
5. `recall_log.via`：`input.via ?? "turn_start"`，只记融合后实际返回且有快照的主题；没有快照的主题在融合前已丢掉（`rankProjectCandidates` 里 `available`）。

其他：`memory-service.ts` 与 `server/http.ts` 未改，模块边界没有越界；路径失败时只是不贡献候选，降级信息保留。

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| 同一输入两次结果一致；返回列表 relativity 单调 | 是 | `fuse.test.ts`、`assignRelativity` 的累计最小 |
| 不透传原始分数；名次相同按 user_memory、agent_memory、project | 是 | `score` 字段已删；`PATH_ORDER` 与测试 |
| 只请求 project 时，第一名仍是原来的第一名 | 是 | `recall-paths.test.ts` 与代码推演 |
| typecheck 与相关测试通过 | 是 | exit 0；135 passed、1 todo（item.md 写 167，见 R1-1） |
| 交接 | 是 | handoff-01.md（b78996ac） |

## 需要 designer / 用户裁决

无。Q-01、Q-29、Q-30 已按 handoff 登记，等 designer 答复。

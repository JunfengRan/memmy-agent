---
item: PM-23-search-latency
seq: 01
role: reviewer
app: Cursor
model: claude-sonnet-5-5-medium
date: 2026-11-10
reviewed: handoff-01.md
range: 127cca7e..b5cb5822
verdict: approved   # approved | changes-requested | blocked
---

# 评审 01：延迟 bench 数字来自实测，未动产品检索代码，通过

## 复核验证

在独立 worktree（`b5cb5822`，软链主工作区 node_modules）里重跑。主工作区仍留着 `eval/project-memory/runs/pm23-search-latency-S-stub.json`，已核对。阅读上限 R-20261110-02 不算进这次交付。

| 命令 | 结果 |
| --- | --- |
| `cd Memory && npx tsx ../eval/project-memory/latency/run-search-latency.ts --self-check` | 退出码 0，`self-check ok: 3 topics, 2 rounds, q03, same JSON`。与 handoff 一致 |
| 读 `runs/pm23-search-latency-S-stub.json` | 第 3 路 p95 0.7408、总 p95 1.4618、渲染 p95 0.0075 ms，各段 timeouts 0，n=620。与 metrics 的 0.741 / 1.462 / 0.008 一致。`goldSeededRecall` 为 0.581 / 0.968 / 0.968（n=31），与 metrics 一致。`usableForGate`、`gatePass` 均为 true，`commit` 为 `127cca7e…` |
| `git ls-files eval/project-memory/runs`；`git check-ignore` | 0 个文件被跟踪，目录被 `.gitignore:67` 忽略 |
| `git diff 127cca7e..b5cb5822 --stat -- Memory` | 空。diff 只有 `.agents/work` item、docs 四份和 `eval/project-memory/latency/` 两个文件，没有产品代码 |
| 清理 worktree | 已 `git worktree remove --force`，`git worktree list` 里没有 `/tmp/pm-review-pm23` |

脚本里没有 0.741 / 0.968 / 1.462 的硬编码；Recall 与延迟都由 `rankProjectCandidates`、`recallCandidates` 的计时和排名在脚本里算出（`run-search-latency.ts:677-707`）。

## 上一轮 MUST 的关闭情况

无。

## 意见

| 编号 | 级别 | 位置 | 问题 | 依据 | 要求的结果 | 如何验证 |
| --- | --- | --- | --- | --- | --- | --- |
| R1-1 | SHOULD | `docs/project-memory/metrics.md` R-20261110-01 元数据「被测实现」；`spec-alignment.md` §3.6 行 | 两处写「HEAD `127cca7e`，工作区含未提交的 PM-23 脚本」，而 JSON 的 `commit` 是 127cca7e，脚本到 b5cb5822 才入库。读者按这个 commit 检出，找不到脚本 | AGENTS.md「状态必须真实」；评测记录要可复现 | 追加一条说明（不改已写数字）：数字测于 127cca7e 之上、脚本在 b5cb5822 提交；或下次跑时在 b5cb5822 重测 | 记录里能直接查到脚本所在 commit |
| R1-2 | SHOULD | `run-search-latency.ts:699-707` | 第 1、2 路是空库（`lane_empty` true），其 P95 只说明调用开销。handoff 与 README 已写明，但 metrics 表里它们和第 3 路并列，没有就地标注 | v3 §3.6 的「单路 P95」应对有数据的路才有意义 | metrics 表第 1、2 行加「空库，仅链路开销」；Q-35 里提醒单路门槛实际只由第 3 路承担 | 阅读表格即可看出 |
| R1-3 | NIT | `metrics.md` 索引行 | 行里「阅读模型」「回答」列的 not-run 与不适用混用，措辞可统一 | — | 可选 | — |

## 验收标准核对

| 标准（来自 item.md） | 是否满足 | 证据 |
| --- | --- | --- |
| fixture S、stub embedder：第 3 路 P95 0.741 ms，总 P95 1.462 ms，渲染 P95 0.008 ms，超时 0 | 满足 | runs JSON：0.7408 / 1.4618 / 0.0075，timeouts 0；门槛 800 ms / 1.2 s / 5 ms 均有余量 |
| 同一检索输入两次 JSON 相同（`--self-check`，q03） | 满足 | 本次重跑退出码 0，输出 `same JSON` |
| 金标灌库 Recall@1/3/9 为 0.581 / 0.968 / 0.968，写在正文，不进索引 Recall@3 | 满足 | JSON `goldSeededRecall` 一致；metrics 索引行 Recall@3 为 `not-run`，正文说明不写入索引 |
| 不改检索排序、超时、返回字段（范围条款） | 满足 | `Memory/` 下无 diff；脚本读取 `recallPathTimeoutMs` 而不修改 |
| `runs/` 下 JSON 不进 git | 满足 | 0 个被跟踪文件，目录已忽略 |
| 红线：确定性、不加模型调用、不加评测专用产品字段 | 满足 | 脚本使用 `decision: null`、`MEMMY_DECISION_TOPIC=0`、stub embedder；产品代码未动 |

流水线 Recall 与 HTTP P95 未跑（阅读模型网关 503），是已知事实，metrics 如实写 not-run，不作为 MUST。

## 需要 designer / 用户裁决

无。Q-35（语料规模）已登记为待回复，不阻塞本次。

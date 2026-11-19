---
item: 20261119-episode-gold-v3
seq: 02
role: reviewer
app: Codex
model: GPT-6
date: 2026-11-19
reviewed: handoff-02.md
range: 995c5d60..9a00f6ec
verdict: approved
---

# 评审 02：历史工具与可见性修复通过

## 复核验证

| 命令或检查 | 结果 |
| --- | --- |
| `npm --prefix Memory run typecheck` | 退出码 0。 |
| `node load-eval-set.mjs` 与 `node load-eval-set.mjs 2.1` | 两版 `errors:[]`。v3 为 78 个 Episode、97 个整理批次、43 个已提交 Topic、4 个暂存条目、36 道计分题。v2.1 为 50 个 Topic、31 道计分题。 |
| `node selftest.mjs` 与 `node --test episode-timeline.test.mjs` | 分别 28/28、4/4 通过。 |
| `node run-pipeline-eval.mjs --oracle` 与 `--empty`，各用 `--dataset 2.1` 与 `--dataset 3` | 四次退出码 0。分别核对 44、46 项得分，四次均 `failures:[]`。报告输出到 `/dev/null`。 |
| `cd Memory && npx --no-install tsx ../eval/project-memory/latency/run-search-latency.ts --self-check` | `self-check ok: 3 topics, 2 rounds, q03, same JSON`。 |
| `node eval/project-memory/gold-add-memory/build-add-showcase.mjs --check` | `Gallery is current; authored narrative unchanged.` 使用历史运行文件核对通过。 |
| 将 `history/v2.1/` 的五份 JSON 与 `162a50e4` 的 `dataset/` 逐一 `cmp` | 五份完全相同。 |
| `git diff --check 162a50e4..9a00f6ec` | 退出码 0。 |

## 上一轮意见的关闭情况

| 意见 | 结果 | 说明 |
| --- | --- | --- |
| R1-1 | 已关闭 | `6922ab1e` 将延迟和陈列工具接入固定的 v2.1 版本目录，两条命令均复跑成功。 |
| R1-2 | 已关闭 | `553605fb` 使用终态主题映射识别改名提前披露。无映射的改述交由现有事实评委核对，离线替身测试单独覆盖该调用与计数。 |
| R1-3 | 已关闭 | `9bea6b4f` 使用实际生效 Turn 的受理时刻判定是否开放。回归核对 21:02:00 拒绝普通和延期条目，21:12:00 放行。 |
| R1-4 | 已关闭 | `3b9b8a65` 将 README 凭据修正指回凭据任务，并清理仅凭同主题建立的续接。 |

## 意见

无新增阻塞项。复核验证采用离线固定时钟及事实评委替身，未运行线上模型或产品全量回放。

## 验收标准核对

| 标准 | 是否满足 | 证据 |
| --- | --- | --- |
| 108 个原始 Turn 有唯一语义 Episode | 满足 | 语料校验、Episode 边界负例和续接差异复核通过。 |
| v2.1 可按原口径重新生成、检查与评分 | 满足 | 归档字节校验、评分自检和历史工具通过。 |
| v3 覆盖开放、暂存、提交与旧结论时点 | 满足 | 目标 Turn 受理回归、暂存披露回归与 q31/q31_after 提交时点自测通过。 |
| 独立评审 | 满足 | 3 条 MUST 均已关闭。 |

## 需要 designer / 用户裁决

无。

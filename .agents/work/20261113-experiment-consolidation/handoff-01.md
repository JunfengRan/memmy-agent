---
item: 20261113-experiment-consolidation
seq: 01
role: developer
app: Codex
model: GPT-6
date: 2026-11-13
branch: codex/jev-superagent-consolidated
base: a32c5fd0
head: 559f342a5264744ff9c65e76ef3c00a3a3dd21c2
to: reviewer
status: ready-for-review
---

# 交接 01：实验入口统一，旧版隔离保留

## 结论

已在独立 worktree 汇总 Jev 选择题和独立 Super Agent 会话路由，包含指定开发分支最新 a32c5fd0 及 v2.1 数据集。原两个分支、worktree 和主检出保留。旧 session-as-topic 基于 v0.1，直接覆盖会丢失新版流水线，因此仅合入 Git 历史并提供固定提交恢复入口；没有声称已将旧算法移植到新版产品。

整理代码与材料已提交为 559f342a，当前无未提交文件。新版本、旧版本专项离线自检及相关测试通过；全包类型检查被基座同样存在的错误阻塞。没有调用模型、启动服务、重跑付费评测或增加在线效果结论。交付待独立 reviewer，不自行 approved。

## 改动

| 提交 / 文件模块 | 改了什么 | 原因与依据 |
| --- | --- | --- |
| c97aac68 | 常规合入 fa04419b 的独立 router、导出、脚本、测试 | router 是独立实验，未接入生产派发 |
| 261b6b84 | 用 ours merge 保留 65e61c7e 为祖先，工作目录保留当前基座 | 旧 v0.1 改写 Add/Search，不能覆盖 M02/M04/M05 和 M09；偏离只留旧快照 |
| 559f342a / .gitignore | 清理合并冲突，只新增 session-router/runs 忽略；保留基座 fixture 规则 | 不隐藏数据集和跟踪的旧证据 |
| eval/project-memory/session-as-topic/ | 固定完整 SHA 的 --check/--create 入口，旧 ADR 与指标摘录 | 完整克隆整合分支后不依赖旧分支名；没有自动安装或调用模型 |
| eval/project-memory/jev-topic/ | 校验 ID 完整性代替 35/23 硬编码，显式 --dataset-dir，报告版本及输出目录隔离，2 个回归 | 数据集已由 v2 更新到 v2.1，不能继续使用旧数量断言 |
| eval/session-router/ 与 session-router-ablation/ | 选择题转导出共享定义，兼容入口转发，读取已跟踪历史 dataset，新输出进忽略目录；失败返回非零 | 清理两套脚本和三份协议副本，保留历史结果 |
| App/memmy-agent/scripts/run-superagent-session-router.ts | .js 导入以通过 TS 模块规则；读取跟踪的历史输入；创建输出目录 | 修复实验原有 TS5097 和首次运行缺输入/目录 |
| docs/project-memory/ | 整理说明、HTML、ONBOARDING、README、findings、metrics、Roadmap/对齐说明与 ADR 阅读提示 | 明确 Jev 实际调用和已整合/隔离边界，清除过期“未提交/脚本阻塞”描述 |

`git diff --exit-code a32c5fd0 HEAD -- Memory/src Memory/tests eval/project-memory/gold-add-memory/dataset eval/project-memory/gold-add-memory/history/v2` 为 0。项目记忆产品实现、提示词、单测、金标与指定基座完全一致。三个来源 a32c5fd0 / fa04419b / 65e61c7e 均经 merge-base 确认是交付祖先；两个旧源分支本地/远端 SHA 分别相同。

## 验证

| 命令 | 实际结果 |
| --- | --- |
| `git fetch origin` | 成功，指定远端仍为 a32c5fd0，无更新提交；不是漏拉新数据，v2.1 已在该基座 |
| `npm --prefix Memory run typecheck` | 失败：src/service/project-environment/local-scanner.ts:32，TS2322，ignore 导入类型不匹配 |
| `npm --prefix App/memmy-agent run typecheck` | 失败：环境缺 playwright、which/mime-types 声明等；实验带入的 TS5097 已修正 |
| 在临时 detached a32c5fd0 worktree 对照两包 tsc | Memory 同样为 local-scanner TS2322；App 在最终修正后输出与基座完全一致（归一化路径，126 行输出）。未修改依赖/lockfile或无关源码 |
| `npm --prefix Memory exec -- vitest run --root Memory tests/service/project-memory` | 21 文件；169 passed、1 todo（既有 Q-23） |
| `cd App/memmy-agent && npx vitest run tests/core/session/superagent-session-router.test.ts` | 1 文件，8 passed |
| `node --import tsx --test eval/project-memory/jev-topic/cases.test.ts` | 2 passed，覆盖 v2/v2.1、缺失/重复用例与未知目标 |
| `node eval/project-memory/gold-add-memory/load-eval-set.mjs` | errors=[]，v2.1、113 traces、50 topics、31 题 |
| `node eval/project-memory/gold-add-memory/selftest.mjs` | 22/22 passed |
| `node --import tsx eval/project-memory/jev-topic/run-jev-topic-eval.ts --self-check` | 通过；104 scored、9 skipped、31 search；无模型调用 |
| 同一脚本加 `--dataset-dir eval/project-memory/gold-add-memory/history/v2` | 通过；34 scored、1 skipped、23 search，v2 报告单独目录 |
| `node --import tsx eval/session-router/run-ablation.ts run --cells baseline --runs 1` | 通过，词法 B³ F1=0.337；兼容入口同样通过；summarize 可运行 |
| `node eval/project-memory/session-as-topic/prepare-legacy.mjs --check` | 通过，完整 SHA=65e61c7e5dd50f0e8c99097e6ce79eb947b85e56，v2/35/23 |
| 同一入口 `--create /tmp/memmy-session-topic-v01-verify-20261113` | 实际创建 detached worktree，核对 HEAD 后移除；未安装依赖、未启动模型 |
| 本地链接与 HTML ID 检查 | 80 个相对链接存在；HTML 无重复 ID。未改样式或 SVG，未进行新的浏览器视觉验收 |
| `git diff --check`、合并结果和数据集 diff | 通过；最终相关文件无冲突标记，生成物未跟踪 |

离线记录：[metrics R-20261113-experiment-offline](../../../docs/project-memory/metrics.md#r-20261113-experiment-offline)。产品 add/search/回答质量、分题型质量、P95 未测，不把词法分数当 Jev 线上效果。

## 与规格的偏离和简化

- 当前产品无新偏离，仍按 [ADR-0006](../../../docs/project-memory/decisions/0006-jev-topic-experiment.md) 默认关闭选择题实验。
- 旧 session-topic 的模型检索、锁定组织等偏离仍仅限 [旧 ADR 归档](../../../eval/project-memory/session-as-topic/legacy-adr.md)，不成为当前产品设计。
- standard SHA 与快照一致，没有规格更新；没有新增契约、表结构或设计决定，不另写产品 ADR。
- 本次不处理 PM-24～PM-27、待决问题或 20261112 审计工作项的独立复核。

## 评审回应

第一轮，无前序 review。本次为 developer 整理交接，不担任独立 reviewer。

## 请 reviewer 重点看

1. `eval/project-memory/session-as-topic/prepare-legacy.mjs:8` — 固定完整提交与恢复语义；261b6b84 是仅保留历史的 merge，不能据祖先关系声称旧算法已接入当前服务。
2. `eval/project-memory/jev-topic/cases.ts:188` — 新旧数据集覆盖校验与 q21 排除是否完整；这是金标主题卡专项，不是产品链路评测。
3. `eval/project-memory/jev-topic/run-jev-topic-eval.ts:175` — 目录参数与报告版本分离是否足够清晰，不沿用旧线上分数。
4. `eval/session-router/run-ablation.ts:54` — 输入读取历史跟踪数据，输出不覆盖 results；兼容入口与共享协议是否可迁移。
5. `App/memmy-agent/scripts/run-superagent-session-router.ts:20` — .js 导入通过 tsx 源码运行及 tsc 编译规则；全包检查仍受基座依赖环境限制。

## 后续研发建议（本次未实施）

- 独立 reviewer 重跑上述离线验证；若要完整 typecheck，先修复/安装基座对应依赖环境。
- 若要比较旧 session-topic 和当前产品，先决定是否移植到 M02/M04/M05，再统一 v2.1 数据、阅读及裁判口径；不能直接覆盖新版流水线。
- 若要更新在线消融/选择题分数，再配置模型与评委并按 pm-eval 新增跑次；原历史分数保持原口径。

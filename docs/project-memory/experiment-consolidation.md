# Jev 与 Super Agent 分支整理（2026-11-13）

## 交付分支

统一入口为 `feat/jev-superagent`，worktree 为 `.worktrees/jev-superagent/`。2026-11-13 按用户后续要求，将整合分支改名；两个源实验分支已删除，其原 worktree 保留为 detached HEAD。源提交均在整合分支历史内，隔离恢复命令不依赖源分支名称。主检出没有切分支。

| 来源 | 固定提交 | 整理方式 |
| --- | --- | --- |
| `origin/dev-project-memory-add-search-dev` | `a32c5fd0` | 整合基座，保留最新审计修补、v2.1 数据、Add/Search |
| `feat/superagent-session-router` | `fa04419b` | 常规 merge；独立 router、测试和消融脚本可直接运行 |
| `feat/superagent-session-as-topic` | `65e61c7e` | 仅合入历史（`ours` merge），增加固定快照恢复入口；旧 v0.1 不覆盖新产品实现 |

2026-11-13 已执行 `git fetch origin`，远端开发分支仍为 `a32c5fd0`，没有比本地该分支更新的提交。v2.1 数据为 113 traces、50 topics、31 道计分题（原 questions 文件 32 道，q21 excluded）；旧 v2 留在 `gold-add-memory/history/v2/`。数据文件与远端基座逐文件相同，本次没有改金标。

`dev-project-memory-add-search` 上另有桌面/宿主集成提交，不是本次指定的基座，因此未合入整合分支。

## 现在的 Jev 用在哪里

“Jev”在仓库里主要是实验历史命名：默认 `gpt-6-luna` 经 chat completions 返回严格 JSON，实际模型可由 `OPENAI_DECISION_MODEL` 或配置文件 MODEL 指定；没有调用 TypeSafe Jev 原生模型。

| 位置 | 实际作用 | 启用条件与边界 |
| --- | --- | --- |
| `Memory/src/service/project-memory/pipeline/organize-job.ts` 的 `narrowCandidatesWithJev` | Add 在 M04 前选主题；已有 topic 只留该候选，new 清空候选 | `MEMMY_DECISION_TOPIC=1` 且配置有效。none/异常保留候选；不生成正文、不直接写库 |
| `Memory/src/service/project-memory/retrieve/search.ts` 的 `moveOptionalJev` | Search 在项目路确定性排序后把选中 topic 提前 | 同一开关；none/异常保留顺序。默认关闭，启用属于非确定性实验 |
| `eval/project-memory/jev-topic/` | 金标主题卡上的 Add 归属与 Search 选题专项评测 | 独立调用，不启用产品开关、不经过真实 Add/Search；支持 v2、v2.1 |
| `eval/session-router/run-ablation.ts` | Jev 选择题协议与 Super Agent 路由协议 × 两种模型的消融 | `jev`、`jev-ds` 使用选择题；`both` 是 Super Agent 协议 × gpt-6-luna，不是两条流水线串联 |

共享选择题定义只维护在 `Memory/.../decisions/topic-choice.ts`；两处 eval 旧副本改为转导出。独立会话 router 仅被导出和评测脚本使用，没有接入生产会话派发。旧 session-as-topic 用 Super Agent 路由替换主题处理，不是额外调用 Jev。

## 离线复现

仓库根执行；需要已有 Node/npm 依赖。以下命令不调用模型：

```sh
node --import tsx --test eval/project-memory/jev-topic/cases.test.ts
node --import tsx eval/project-memory/jev-topic/run-jev-topic-eval.ts --self-check
node --import tsx eval/project-memory/jev-topic/run-jev-topic-eval.ts --self-check --dataset-dir eval/project-memory/gold-add-memory/history/v2
node --import tsx eval/session-router/run-ablation.ts run --cells baseline --runs 1
node eval/project-memory/session-as-topic/prepare-legacy.mjs --check
```

Jev 专项校验已从硬编码 35/23 改为核对数据集 trace/question ID 全覆盖、无重复及候选存在性，q21 仍排除；报告增加版本和目录，v2/v2.1 生成物分目录。它使用金标卡片，只是协议专项，不能据此声称真实维护能力提高。

会话消融读取已跟踪的 `eval/session-router-ablation/results/dataset.json`（23 条、6 个源会话），新输出统一进入忽略的 `eval/session-router/runs/ablation/`。`eval/session-router-ablation/run-ablation.ts` 是兼容入口，转发到统一脚本；历史 results 不覆盖。局限仍是源会话不等于人工主题金标、无 stop 样本。

在线运行会调用配置的模型并产生费用，未在本次执行：

```sh
node --import tsx eval/project-memory/jev-topic/run-jev-topic-eval.ts
node --import tsx eval/session-router/run-ablation.ts run --runs 3
```

旧实验通过[隔离入口](../../eval/project-memory/session-as-topic/README.md)恢复。它尚未迁移到新版拆分流水线，不可直接与 v2.1 产品结果横比。本次不新增产品 ADR，不改变默认开关、契约、提示词版本或 PM 条目状态。

## 验证与接手

离线检查见 [metrics 的整理记录](metrics.md#r-20261113-experiment-offline)，正式交接见 [工作项](../../.agents/work/20261113-experiment-consolidation/item.md)。没有新的在线效果分数；仍需独立 reviewer 复核，特别是仅保留历史的合并策略与可复现性。

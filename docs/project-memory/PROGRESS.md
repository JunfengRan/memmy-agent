# 项目记忆预研进度

给下一个接手的 agent。产品规格在本地 `design-docs/ProjectMemory/beta/`（不进 git）。机器可读规格在 `spec/project-memory/`。门禁：`node scripts/project-memory/cli.mjs status`。

## 基线

- 分支：`dev-project-memory-beta`（推到 `origin`）
- baselineSha：`8684cb570f1b54debcdd45da45f0f02661a76a42`
- 原始 Memmy 基线不常驻。要重跑空白对照或三种读时对照时，先跑 `eval/project-memory/baseline/setup-baseline.sh`：在 `MEMMY_BASELINE_DIR`（缺省 `../memmy-agent-baseline`）建一个分离的 worktree，打上 `price-filter.patch`，`node_modules` 链到本仓
- 收尾前的 5 个实验 worktree 和对应的 5 个实验分支（`experiment/attribute-tree`、`attribute-memos`、`attribute-graphiti`、`memmy-baseline`、`searchable-wiki`）都已删除，代码和结果收在 `eval/project-memory/`
- 待定问题按 `design-docs/ProjectMemory/beta/14-待定问题.md` 的默认方案。这是预研，不是发布级实现。

## spec

- 状态：完成
- 已做：`spec/project-memory/workflow.yaml`、各阶段 `phases/*.json`、`scripts/project-memory/cli.mjs`
- 决定：用例在 `Memory/tests/project-memory/cases/`
- 没做完的：无
- 下一入口：看下面各阶段

## m1

- 状态：完成
- 已做：`Memory/src/service/project/identity.ts`、`changed-files.ts`、`git-status.ts`、`scope-weight.ts`、`context.ts`、`merge-subdirs.ts`、`capture.ts`。会话打开会把已存在的 file URI 收到 git 顶层。召回在 RRF 之后乘作用域系数。Cursor hook 在 `beforeSubmitPrompt` 写 `additional_context`，`afterFileEdit` 先缓冲。同一项目的重复问答写 `duplicate_of`。
- 决定：`resolveWorkspaceIdentity` 仍保持纯函数。项目归一写在调用方，避免和 `cli/analytics` 循环依赖。宿主 id 放在 `host-id.ts`。
- 没做完的：扫描夹具 `agent-source-cross-source-recapture.test.ts` 没有共享 git 根，项目级判重的断言在 `M1-DEDUP-001`，没有改那份扫描夹具的全局库路径。
- 下一入口：复盘

## retro

- 状态：完成
- 已做：下面这几条是 M2 以后实际遵守的改法
- 决定：
  1. 不要从 `Memory/src/service/project/` 引用 `contracts/index.ts` 或 `cli/analytics.ts`。身份哈希直接调用 `sha256Hex`，公式与 `resolveWorkspaceIdentity` 相同。
  2. 协议 v3 走现有 v2 开会话路径，只把 `l3_world_model_protocol_version` 写成 3。检查点、事项、权限先做成可单测的纯函数，再择要点进写入链路。
  3. 迁移把 schema 升到 10。`policy:<16 hex>` 只在从 v9 升级时改成 `policy:global:<同一 hex>`。新库没有旧键。
  4. 评测不要在进程里同时依赖两份 `node_modules`。基线 worktree 需要链到本仓的 `node_modules`，并且 `@memmy/agent-source-core` 要先 `npm run build -w @memmy/agent-source-core`，否则基线 import 找不到导出。
- 没做完的：无
- 下一入口：M2

## m2

- 状态：完成
- 已做：协议 `2 | 3`；`checkpoint.ts` 解析 `todo_write`、`TodoWrite`、`update_plan`；检查点不受每轨迹 2 段上限；`topic.ts` 有界视图；`policy-scope.ts` 和策略归纳键 `policy:${scope}:${hash}`；证据截到 20 条；work memory 提示词写了「改口」，合并时记 `last_change`。Memmy 工具增加 `todo_write`。迁移 `010_project_memory` 建 `memory_conflicts` 和索引。
- 决定：事项归属和检查点摘要不调 LLM。检查点切分的服务内自动落库还没有接进每轮 `completeTurn`，单测覆盖切分结果。
- 没做完的：Viewer 列表的 `topicId` 过滤、事项刷新作业、`project log` HTTP。预研没有做这些读模型页面。
- 下一入口：M3

## m3

- 状态：完成
- 已做：`access.ts` 的有效级别、读过滤、`aclAllows`。`conflict.ts` 的用户优先、权限高低、同级待裁决、系统更新只送一次、一层复核最多 30 个、Dream 只裁 claim。
- 决定：权限规则是函数和配置约定，还没有单独的配置文件加载器和宿主 PreToolUse 拦截器。冲突表已由迁移建好，裁决逻辑先由纯函数承担。
- 没做完的：Memmy 弹窗、Claude `PreToolUse`、Cursor 命令拦截、`turns/start` 里真正读取 `decision_repairs.meta_json`。下一轮如果要产品化，把 `deliverOnce` 接到 `startTurn` 返回值的最前面。
- 下一入口：评测

## m4

- 状态：完成
- 已做：`scripts/project-memory/eval/run-eval.ts`。三臂各用独立 SQLite。数据集是接力、任务族、冷启动。指标有得分、串扰、召回毫秒、入库毫秒、库字节。
- 决定：不跑真实 Cursor 一周。剧本驱动 `openSession` 和 `completeTurn`。
- 没做完的：无
- 下一入口：M5

## m5

- 状态：完成
- 已做：属性树在 `eval/project-memory/arms/attribute-tree.mjs`（同目录还有 `memos-leaf.mjs`、`graphiti-edge.mjs`、`searchable-wiki.mjs`）。记忆写入和召回仍是基线 Memmy。三轮只改注入：项目一行、模块节点、再只保留当前项目加全局，并删掉其他项目独有的长词。
- 决定：最多三轮，到此停止。
- 没做完的：没有把属性树合并回本分支。
- 下一入口：报告

## eval

- 状态：收尾完成（2026-10-24）。修完 4 个缺陷后重跑，报告已按新结果重写。
- 已做：报告 `eval/project-memory/report.html`，由 `render-report.py` 把 `report-body.html` 套进 `~/memtensor/templates/explainer.html`（找不到模板就沿用现有报告的外壳）。q21 不计入，分母 29。

| 方式 | 直接召回 | Memmy 中模型回答 | Cursor 回答 |
|---|---|---|---|
| 空白对照 | 12/29 | 17/29 | 12/29 |
| 项目记忆（标注上限） | 25/29 | 23/29 | 21/29 |
| 项目记忆+Wiki（标注上限） | 24/29 | 27/29 | — |
| 自行检索 | 13/29 | 17/29 | — |
| 属性树 | 11/29 | 16/29 | 15/29 |
| MemOS 叶子合并 | 7/29 | 15/29 | — |
| Graphiti 事实边 | 13/29 | 23/29 | — |

- 目录：`eval/project-memory/arms/`（四种读时对照）、`baseline/`（基线重建脚本和补丁）、`dataset/`、`workspaces/`（ledger、catalog；运行时各自 `git init`）、`runs/`（结果；`pre-fix/` 是修复前一份；`cost.json` 是写入开销汇总；`*-recall-db/` 不进 git）。
- 修掉的缺陷：无项目窗口收到项目轨迹（`scope-weight.ts`、`retrieval-service.ts`）；`source-turn` 的 `gitRoot`、`changedFiles` 没落库（`http.ts`、`changed-files.ts`）；时间范围召回不看作用域（`retrieval-service.ts`）；合并子目录后策略键和 L3 没跟着走（`merge-subdirs.ts`）。细节和用例见设计文档 `design-docs/ProjectMemory/beta/16-先行开发复盘.md` §3。
- 决定：
  1. **项目记忆一列是标注上限。**现行结论、取代标记、检查点摘要、事项名由 `run-recall.ts` 的 `recordProjectStructure` 写入，前两样来自金标。报告和文档统一这样标。
  2. **噪声底是 6 题。**空白对照代码没改，回答重跑翻了 6 题；自行检索翻 10 题。差距不到 6 题不比大小。
  3. 修复后按约定重跑了空白对照、项目记忆、Cursor 项目记忆列、Wiki、自行检索。属性树、MemOS、Graphiti 建在基线上，没有重跑。
  4. 裁判和作答出过 12 处坏结果（理由为空、说没有候选回答、调起工具、回答为空），都用 `scripts/project-memory/eval/rejudge.mjs` 单独重判过。
- 坑：`run-answer.mjs`、`run-judge-cursor.mjs` 会续跑已有输出，`run-recall.ts` 会复用已有 `*-recall-db/`。重跑前先移走。`run-lookup.mjs` 不续跑。
- 没做完的：现行结论和取代关系还没有由产品产出；q20 的证据被入库判定拒掉；主动搜索在无项目窗口不限项目；检查点、权限、冲突没接进产品链路。完整列表见 16 §6。
- 下一入口：设计文档 `design-docs/ProjectMemory/beta/15-正式开发计划（基于先行开发经验）.md` 的 P0：写入链路自己抽取现行结论和取代关系，评测去掉金标写入，每臂跑 3 次。

# 项目记忆预研进度

给下一个接手的 agent。产品规格在本地 `design-docs/设计文档/项目记忆/`（不进 git）。机器可读规格在 `spec/project-memory/`。门禁：`node scripts/project-memory/cli.mjs status`。

## 基线

- 分支：`dev-project-memory`
- baselineSha：`8684cb570f1b54debcdd45da45f0f02661a76a42`
- 原始 Memmy worktree：`/Users/junfengran/repos/memmy-agent-baseline`，分支 `experiment/memmy-baseline`
- 属性树 worktree：`/Users/junfengran/repos/memmy-agent-attr-tree`，分支 `experiment/attribute-tree`
- 两个 worktree 的 `node_modules` 是指向本仓的符号链接，方便直接 import 基线 `Memory/src`
- 待定问题按 `organized/14-待定问题.md` 的默认方案。这是预研，不是发布级实现。

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
- 已做：属性树在 `/Users/junfengran/repos/memmy-agent-attr-tree/eval/attribute-tree.mjs`。记忆写入和召回仍是基线 Memmy。三轮只改注入：项目一行、模块节点、再只保留当前项目加全局，并删掉其他项目独有的长词。
- 决定：最多三轮，到此停止。
- 没做完的：没有把属性树合并回本分支。
- 下一入口：报告

## eval

- 状态：报告已写成。q21 不计入，分母是 29。空白对照和属性树的 Cursor 列还没采。
- 已做：报告在 `eval/project-memory/report.html`，用记忆张量研究文档模板。q21 不计入。直接召回：空白对照 10/29，项目记忆 22/29，属性树 11/29。模型回答：19/29、23/29、16/29。Cursor 只裁判了项目记忆一列，18/29。空白对照和属性树的 Cursor 回答还没采。
- 决定：不把两个不能互搜的会话当成实验本身。问题是已经写进记忆的内容能不能答对。属性树单独成一列，不并进项目记忆。
- 没做完的：空白对照和属性树的 Cursor 作答。
- 下一入口：若要补全 3×3，用各自召回上下文再采两列 Cursor 回答，同一套裁判。
- 更早一版召回（检查点还没写入、q21 还在分母里）是空白对照和项目记忆都是 11/30。那一版不能和现在这张表对照。

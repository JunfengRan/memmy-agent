# 文档交付与验证记录

- 角色：developer；应用：Codex；模型：GPT-6；日期：2026-11-11。
- 基线：`dev-project-memory-add-search-dev` @ `71d3faff`；全部交付保持未提交，没有交付 commit，也没有进入正式 ready-for-review。
- 两篇正文：`docs/project-memory/algorithm-handoff.html`、`docs/project-memory/routing-experiments.html`。
- 原页面按用户选择删除；已更新文档内引用。运行 B 的 58 个主题及嵌套决策、冲突、历史与原页面规范化后完全一致：61 条决策、0 条经验、5 条时间线。
- 修正文档中的历史/现状混用、指标口径、RCA 过度归因及代码入口。ADR 只追加阅读提示；既有工作项状态未变。未改产品实现、提示词、规格镜像、金标或实验工作区。

## 已通过

- `npm --prefix Memory run typecheck`。
- 在 Memory 下运行 `npx vitest run tests/service/project-memory/http-contract.test.ts tests/service/project-memory/search.test.ts tests/service/project-memory/jev-topic.test.ts tests/service/project-memory/concurrency.test.ts`：4 文件、26 测试通过。
- 研究文档 HTML 结构、设计 token 与 SVG 校验：2 页、5 张 SVG 全通过。
- 工作室 `/Users/junfengran/memtensor` 的 `npm test`：通过模板及门禁自测。本次没有改工作室文件。
- 递归链接检查：108 个本地链接无缺失目标；HTML 页内锚点无缺失；旧页面引用已清除。
- `node --check eval/project-memory/gold-add-memory/build-add-showcase.mjs`、生成器 `--check`、重复生成字节不变、正文前后缀保留、缺失/重复/反序标记拒绝检查均通过。
- Playwright / Chrome：两页分别在 1440px / 420px、浅色 / 深色下打开，无 pageerror 或整页横向溢出；配色可切换并持久化，附录可展开。逐张查看了首页、SVG、窄屏正文与附录截图。窄屏图沿用模板的横向滚动，图注已给出提示。
- `git diff --check` 通过。

截图和临时检查脚本在 `/tmp/pm-handoff-qa/` 等临时目录，不作为仓库交付物。

## 现有复现阻塞（未修改）

实际执行 `cd Memory && npx tsx ../eval/project-memory/jev-topic/run-jev-topic-eval.ts --self-check` 失败：

```text
Error: expected 35 traces, got 104 scored and 9 skipped
```

脚本仍按 v2 数量断言，却读取当前 v2.1 dataset。失败发生在模型调用前；没有产生新评测分数。实验 HTML、ONBOARDING 和 findings 已记录这一边界。两实验工作区的核心代码尚未提交，仅 checkout 对应 HEAD 不能复现。

本次未运行任何付费模型评测，也没有提交或推送。要开展正式 Agent 评审，应先由用户授权提交，再依 agent-handoff 协议新建带真实交付 commit 的 handoff。

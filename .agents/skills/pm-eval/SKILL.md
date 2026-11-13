---
name: pm-eval
description: 跑项目记忆 add/search 评测并记录指标。在用户说「跑评测」「看看效果」、改了提示词或算法需要对比、或里程碑结束时使用。数据集在 eval/project-memory/gold-add-memory/，结果写 docs/project-memory/metrics.md。
---

# 项目记忆评测

评测的唯一入口。具体命令以 `eval/project-memory/gold-add-memory/README.md` 为准；这里规定流程和记录方式。

## 前提

- 被测服务用全新的数据库，端口与日常服务分开：
  ```bash
  cd Memory && MEMMY_MEMORY_PORT=18961 MEMMY_MEMORY_DB=/tmp/pm-eval/$(date +%Y%m%d-%H%M)/memory.sqlite npx tsx src/server/index.ts
  ```
- 评委模型必须显式配置，与被测模型不同家族，温度 0（ADR-0004）。没配好就停下来问用户，不要用被测模型兜底。
- 生成物写到 `eval/project-memory/runs/<日期-commit>/`，不进 git。

## 步骤

1. 记录当前 commit（`git rev-parse --short HEAD`）、工作区是否干净、数据集版本、`project-memory/prompts/` 中各提示词的版本号、被测模型和评委模型。
2. 校验数据集：`node eval/project-memory/gold-add-memory/load-eval-set.mjs`，有错误就停。
3. 先跑 `--oracle` 和 `--empty` 确认评分器正常（oracle 全 1、empty 全 0）。改过评分脚本时这一步必做。
4. 启动服务，跑真实回放，再评分。
5. 在 `docs/project-memory/metrics.md` 按「记录模板」新增一条完整记录（放在「记录」最上面），并在索引表加一行。**「指标定义」里的每个指标都要填**：add、search、回答、效率四组，含按题型的分项；测不了写「不适用（原因）」。工作区不干净时在元数据写明。
6. 与上一行对比，向用户汇报：哪些指标变了、可能的原因、离 v3 目标的差距、建议的下一步。指标退步且原因不明时，不要接着改提示词，先找原因。

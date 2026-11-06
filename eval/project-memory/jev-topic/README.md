# OpenAI Decisions 主题归属实验

单独测量两件事：add 时一轮 query 和回答属于哪个 topic，search 时该选哪个 topic。模型是 `gpt-6-luna`。内部中转没有 `/v1/decisions`，所以和 DeepSeek 一样走 `POST {OPENAI_API_BASE}/chat/completions`，用严格 JSON 返回选项和概率。不启动记忆服务，不打开产品开关，也不改主评测回放。

密钥和地址放在 `~/.openai.env`，字段与 `~/.claude.env`、`~/.deepseek.env` 相同，不进仓库：

```bash
MODEL=gpt-6-luna
OPENAI_API_KEY=...
OPENAI_API_BASE=...
```

产品路径默认关闭。要在服务里试用：

```bash
export MEMMY_DECISION_TOPIC=1
```

缺密钥或调用失败时，add 仍用原来的候选，search 仍用原来的排序。`none` 不会把一轮丢掉。Vitest 忽略 `MEMMY_DECISION_TOPIC`，除非同时设置 `MEMMY_DECISION_TOPIC_IN_TEST=1`。

## 单独评测

候选主题卡来自金标，测的是选题，不是抽取。add 的卡带上该时刻之前已经写过的条目；search 的卡只有主题名称、摘要和描述，不放条目正文。对照是同一批主题卡上的词法重叠，不调用模型。

```bash
cd Memory && npx tsx ../eval/project-memory/jev-topic/run-jev-topic-eval.ts --self-check
cd Memory && npx tsx ../eval/project-memory/jev-topic/run-jev-topic-eval.ts
```

报告写到 `eval/project-memory/runs/<日期>-jev-topic/`（不进 git）。Recall@1 是 argmax 是否选中金标主题；Recall@3/@9 按选项概率排序。跑完把指标摘要写入 `docs/project-memory/metrics.md`。没有 `~/.openai.env` 时脚本退出 2。

决定见 [ADR-0006](../../../docs/project-memory/decisions/0006-jev-topic-experiment.md)。

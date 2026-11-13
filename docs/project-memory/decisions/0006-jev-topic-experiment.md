# ADR-0006：OpenAI Decisions 主题归属实验默认关闭

- 日期：2026-11-06
- 状态：已采纳
- 规格出处：v3 §2.2.7（归类）、§3.2.5 / §6.1 #9（检索不调模型重排）

## 背景

主题归属是选择题：add 判断一轮 query 和回答属于哪个 topic，search 选出对应 topic。先考虑过 TypeSafe 的 Jev（SystemOne），实验还没跑就改成 OpenAI Decisions API，模型 `gpt-6-luna`。它不生成正文。

调用走公司内部中转，和 Claude、DeepSeek 一样：`~/.openai.env` 里是 `MODEL`、`OPENAI_API_KEY`、`OPENAI_API_BASE`，Bearer 鉴权。这个网关对 `POST /v1/decisions` 返回 404，模型只登记了 chat completions。实验因此用 `POST {OPENAI_API_BASE}/chat/completions`，模型 `gpt-6-luna`，用严格 JSON 选出一个选项并给出各项概率。该模型不接受 `temperature: 0`。

v3 的默认检索仍要求同样输入得到同样输出，模型调用只出现在 M02、M04、M05。

## 决定

- 产品路径默认关闭。只有 `MEMMY_DECISION_TOPIC=1` 且 `~/.openai.env` 里有密钥和地址时，add 和 search 才会调用 Decisions。缺配置或调用失败都退回原来的候选和原来的排序。
- 测试进程（`VITEST=true`）忽略 `MEMMY_DECISION_TOPIC`，除非同时设置 `MEMMY_DECISION_TOPIC_IN_TEST=1`。
- 打开时：add 在 M04 之前用选题收窄候选（选中已有 topic 则只留该 topic，选 `new` 则清空候选，选 `none` 则不动）；search 在确定性排序之后把选中的 topic 移到第一位。这不是 v3 的默认 M09。
- 召回效果单独评测，不进主回放。脚本是 `eval/project-memory/jev-topic/run-jev-topic-eval.ts`。它直接读 `~/.openai.env` 调用 Decisions，不启动记忆服务，也不打开产品开关。候选主题卡来自金标。
- 模型默认 `gpt-6-luna`。进程里的 `MODEL` 不覆盖这个文件，避免把对话模型误当成决策模型。密钥不进仓库。

## 影响

- 开关关闭时，add / search 的请求、排序和测试与没有这段代码时相同。
- 开关打开后，search 不再保证确定性，也不再满足「检索不调模型」。因此开关不能作为默认。
- 决策文案版本是 `openai-chat-choice-1`，放在 `decisions/topic-choice.ts`，不进 `prompts/` 的产品提示词。

## 替代方案

- 用 Jev / SystemOne：用户改为公司内部中转上的 OpenAI Decisions，否决。
- 把 Decisions 设成默认归类器：会把未完成的实验放进主路径，否决。
- 用 chat completions 让同一个模型生成 JSON：能做，但 Decisions API 直接返回选项概率，和这次要测的选题一致。

## 阅读提示（2026-11-11）

此处 Decisions 是结构化选择题实验的历史命名。现行实现使用 gpt-6-luna 的 chat completions，不是 Jev 原生模型或原生 Decisions 端点。与两个 Super Agent 工作区的区别及复现边界见 [实验说明](../routing-experiments.html)。

## 整理说明（2026-11-13）

选择题与独立会话路由汇总到 `feat/jev-superagent`，未改变本 ADR 的默认关闭决定。旧同编号 session-topic ADR 仅在归档快照内有效。专项脚本已适配 v2/v2.1，详见 [整理说明](../experiment-consolidation.md)。

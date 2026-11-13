> 归档：原文来自 `65e61c7e`。下文“本分支”指旧实验分支，不适用于当前默认实现；不构成新的产品 ADR。

# ADR-0006：用 super agent 的 session 路由锁定项目记忆主题

- 日期：2026-11-06
- 状态：已采纳（本分支 `feat/superagent-session-as-topic`）
- 规格出处：v3 §2.2.7、§3.2.5、§6.1 #9；dsh-superagent `prompts/dispatch.md` 的 `orchestrator_route`

## 背景

项目记忆 v0.1 由同一次组织调用既抽取条目、又决定归入哪个主题，检索再用 RRF 和 MMR 选主题。用户要求把 DeepSeek Harness 的 dsh-superagent 路由嵌进 memmy：router 分配的 session 就是 topic。写入仍按原文的 accept / attach（主题相近不能 attach，只有消息明确指向已有 session 才 attach）。提问由同一个 router 从该 Space 已有 session 里选择要读的记忆，可以多选，也可以一个都不选。条目仍走现有组织与合并。不启动 DeepSeek Harness 进程。

## 决定

1. `add/message` 在组织之前做一次 `project_memory.route`（`prompts/route.ts`，`pm-route-v0.1.0`）。`accept` 新建一个 topic，`attach` 只写指定 topic，`ignore` 和 `stop` 不调用组织，整轮记为 deferred。
2. 组织提示词升到 `pm-organize-v0.1.1`。输入带 `locked_session`。解析时把本批条目都放到这个 session：`accept` 时组织器给出的名称和摘要仍用来描述新 topic；它点了别的 topic id 也不会再开第二个主题。
3. `search/memory` 先做 `retrieve`，按 router 给出的顺序返回这些 topic 的全部条目（含 conflicts 和 history）。不再用 RRF / MMR 决定返回哪些主题。`relativity` 按这个顺序从 1 线性降到 0，仍受 `memory_limit_number` 和 `relativity` 过滤。`recall_log` 仍记录被返回的决策，供「已告知」使用。
4. 路由是一次 `completeJson`，温度 0。决策种类与 `orchestrator_route` 的 accept / attach / ignore / stop 对齐，提问多一个 retrieve。没有多轮工具循环。
5. `stop` 只让这一轮不写入，不把 session 标成永久关闭。
6. 展示给 router 的 session 最多 30 个，每个最多 8 条决策原文。写入时若请求带了 domain，只把这些 domain 里的 session 交给 router。

## 影响

- 偏离 v3 §6.1 #9 和 §3.2.5：选哪些主题由模型决定，同输入不保证同输出。温度 0 只是尽量稳定。
- 偏离 v3 §2.2.7「归类失败不保守新建」的一处：router 已经 `accept` 之后，组织器若把条目指到不存在的 topic，条目仍写入这个新 session，不会因此再新建一个主题，也不会因为指错 id 被丢掉。
- 金标主题 id 与 router 的 session id 不是同一套标识。主题级中间指标不能直接当成分数；回答准确率仍用现有阅读模型和 `answers.llm`。
- 检索失败（模型未配置或路由输出无法解析）返回 `STORE_UNAVAILABLE`，不退回词法排序。

## 替代方案

- 只存原文、不再抽取条目。回答测的是路由加原文，测不到分歧和 history。未采用。
- 拉起本机 DeepSeek Harness，把语料当成 Trigger。retrieve 不是原文里的动作，而且评测要依赖 Harness profile。未采用。

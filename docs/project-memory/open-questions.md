# 待决问题

规格 TBD、规格之间的矛盾、实现中发现的问题。每条写我们的提议；有回复后改状态并在对齐表落地。周报汇总状态为 `待回复` 的条目。

状态：`待回复` / `按提议实现` / `已关闭`。

| ID | 问题 | 出处 | 提议 | 状态 |
| --- | --- | --- | --- | --- |
| Q-01 | RRF 常数 k、各信号权重、relativity 归一化方法未给出 | v3 §3.2.5、§3.5.4 R-3 | k=60（与现有 `assignChannelRrf` 一致）；relativity = 融合分 / 本次最高分；通过评测调参后回填 | 按提议实现 |
| Q-02 | 条目没有对外 ID | v3 §6.5 #1 | 条目返回 `id`（`dec_` / `exp_` / `tl_` 前缀） | 按提议实现 |
| Q-03 | 会话开始：v3 写 `start_conversation`，PRD 11/03 已删除 | v3 §3.1、PRD 修订 11/03 | 不实现 `start_conversation`。会话 ID 由调用方在 `add_message`（及同一会话的 `search_memory`）中自行提交，MemOS 不分配；会话开始的主题索引按 `space_id` 调 `get_memory`。v3 中依赖 start_conversation 的「本轮开始」、recall_log 分组都以调用方提交的会话 ID 为键 | 已关闭（11/04 用户决定） |
| Q-04 | `create_space` 入参：SDK 规格要求传 `space_id`，PRD 11/03 改为 `space_name` 且由 MemOS 生成 id | PRD 修订 11/03、SDK §create_space | 按 PRD 11/03 实现：必填 `space_name`，`space_id` 由 MemOS 生成，每次调用都新建 | 已关闭（11/04 用户决定） |
| Q-05 | ChangeSet 上限（≤20 topic、≤200 条目 op）未定 | v3 §6.5 #3 | 先按此上限，超出按 topic 拆分 | 按提议实现 |
| Q-06 | 决策多于 30 条时「同一问题」判定的输入规模 | v3 §6.5 #4 | v0.1 全量；W46 评估是否先在主题内召回前 10 条再判定（全量读仍读全部） | 按提议实现（11/04 用户确认） |
| Q-07 | recall_log 保留期 | v3 §5.3 | 7 天 | 按提议实现 |
| Q-08 | 归类准确率、重复主题率等 `[TBD]` 指标在 11/6 前要首批数，但现有数据集只有 7 个 topic，阈值无统计意义 | v3 §2.2 | v0.1 报首批数并注明样本量；W46 扩到约 50 个 topic | 按提议实现 |

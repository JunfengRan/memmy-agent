# rca-q42

跑次 `eval/project-memory/runs/2026-11-11T06-49-59-369Z/`，档案 `trace/questions/q42.json`。

问题：采购来的货上架之前要先核对什么？  
金标：采购到货先核对订单号和数量，再上架。  
回答：记忆里没有关于采购货上架前核对内容的相关内容。  
`judge.correct` 为 false。`judge.reason`：标准答案要求上架前先核对订单号和数量，回答却称没有相关内容。

## 1. Search

提问时金标不在库里。`search.gold[0].locations` 为 `[]`，`entryHit` 为 0。金标条目 `dec_wh_buy` 没有所在主题，因此没有词面名次、向量名次、最终名次和 `withinLimit`。

返回的 8 个主题都不是这条采购核对。最终名次 1「退货单独清点隔离」词面 1、向量 1、`withinLimit` true，条目 `dec_b7c42bd9da194be9` 的 `lexical` 0.2143、`kept` true，所以 `reader.user` 出现了它的「相关决策」行：「退回来的货单独清点，不与采购货混放。」最终名次 2「出库先进先出顺序约定」的条目 `kept` 为 false。这些都不是金标。

`reader.user` 没有「订单号」，也没有「再上架」这句核对要求。

## 2. Add

库里没有这句，展开 `adds[0]`（`t_wh_buy`）。

会话两句就是答案本身：用户「采购到的货先对订单号和数量，再上架。」助手「采购到货先核对订单号和数量，再上架。」extract 回复 `drafts` 为空，两句都标成 `restatement`。没有 assign、没有 judge。`steps[0].progress` 的 `dropped` 与回复相同，`assignments` 和 `ops` 都是空数组，`added` 为 0，`memoryIds` 为 `[]`，`diff` 为 `{}`。库在这轮之前也没有可被复述的同题条目。

## 3. 其他

阅读模型没有误读。`reader.user` 里没有订单号核对，回答称没有相关内容与渲染一致。`goldAnswer` 与 `t_wh_buy` 助手原文相同，`judge.reason` 没有判错方向。

## 4. 根因分类与证据

主因：`add_extract_drop`。

证据：

- `adds[0].modelCalls[0].response.content`：两句 `reason` 都是 `restatement`，原文「采购到货先核对订单号和数量，再上架。」
- `adds[0].steps[0].diff`：`{}`。`search.gold[0].locations`：`[]`。
- `reader.user` 不含「订单号」。

后续验证建议（本次未实现）：复跑 `t_wh_buy` 后，extract 的 `drafts` 不应为空，这句不应再进入 `dropped`；`reader.user` 应能看到「订单号」。

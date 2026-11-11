# q06 价格列表里的金额怎么取整？

评委判错：回答否认有取整约定，只说到按两位小数格式化，没有确认输出前按两位小数取整。

## 1. Search

回答要的整句在提问时不在库里。`search.gold[0]`（`dec_cat_round.content`，「价格显示保留两位小数，输出前按两位小数取整。」）的 `locations` 是 `[]`。

相关主题是「价格显示小数位约定」（`topic_13baf70e706b4f63`）。词面名次 `lexicalRank=4`，向量名次 `vectorRank=2`，最终名次 `rank=2`，`withinLimit=true`。它在 `search.returnedTopicIds` 的第 2 位，并出现在 `reader.user`。主题被召回了。

该主题唯一条目 `dec_cb757b198cc343c7` 词面分 0.0909，`minEntryHits=3`，`kept=false`，决策正文被词面门槛滤掉。`reader.user` 里仍有主题摘要和描述。记忆段没有「取整」；这个词只出现在文末的问题句「价格列表里的金额怎么取整？」里。

## 2. Add

库里没有「输出前按两位小数取整」，需要展开。来源只有 `adds[0]` 的 `t_cat_round`。

会话里用户说「价格显示保留两位小数。」，助手说「listAmounts 输出前按两位小数取整。」extract 只留下草稿「价格显示保留两位小数」。`modelCalls` 里 extract 的 `dropped` 把「listAmounts 输出前按两位小数取整。」标成 `local_implementation`。没有 judge 调用。

assign 把 `d0` 送进新主题「价格显示小数位约定」。`steps[0].diff.pm_decisions.added` 的正文是「价格显示保留两位小数」，没有「取整」。主题描述写成「统一按两位小数格式化输出」。`diff` 里没有第二条决策、conflicts 或 history。

这是 M02 把取整句当成实现细节丢掉。M04 新建的主题名和这条约定相符，不是归错。M05 没有旧决策可比。

决策条目后来 `kept=false`，但取整句根本没有进入决策或主题描述。放宽词面门槛也读不到这句。

## 3. 其他

`reader.user` 该主题只写保留两位小数，并写成「格式化输出」。回答据此说「价格金额没有取整约定」，再复述格式化。这是记忆段没有取整句时的推断，不是把已渲染的取整读丢。

`goldAnswer` 是「价格显示保留两位小数，输出前按两位小数取整。」`judge.reason` 要求确认输出前按两位小数取整。会话助手原句里有这层意思，金标和评委与会话一致。错在这句没有进库，也不在渲染里。

## 4. 根因分类与证据

主因：`add_extract_drop`。

证据：

- `adds[0].modelCalls` 中 extract 回复的 `dropped`：`reason=local_implementation`，「输出前按两位小数取整」。
- `adds[0].steps[0].diff.pm_decisions.added` 的 `content`：「价格显示保留两位小数」。
- `reader.user` 该主题描述：「统一按两位小数格式化输出」。记忆段无「取整」。

改法方向：抽取时保留「输出前按两位小数取整」，不要把它标成 `local_implementation`。入库后决策或主题描述应含「取整」，`search.gold[0].locations` 不应再是空数组。

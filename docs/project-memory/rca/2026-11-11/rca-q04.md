# q04 空客户的测试现在是怎么写的？

评委判错：回答只复述了「没有客户名的分录不计入月报」，没有写周工后来的规则，也没有写两项需要成员确认。

## 1. Search

金标两句在提问时都没有以整句出现在库里。`search.gold[0]`（`dec_empty.content`，「空客户的处理：没有客户名时这笔不进月报。」）和 `search.gold[1]`（`dec_empty.conflicts`，「空客户的处理：只跳过金额列为空的行，空客户但金额还在的保留在月报里。」）的 `locations` 都是 `[]`。

相关主题是「月报按客户过滤分录」（`topic_971af7461adb402d`）。词面名次 `lexicalRank=1`，向量名次 `vectorRank=5`，最终名次 `rank=2`，`withinLimit=true`。它也在 `search.returnedTopicIds` 里，并写进了 `reader.user`。主题名次不是缺口。

同主题两条条目：时间线 `tl_79b9340d175b4ed9` 词面分 0.25，`kept=true`；决策 `dec_cf169237fa12418f` 词面分 0.0833，`minEntryHits=3`，`kept=false`，被词面门槛滤掉。`reader.user` 里该主题只有摘要、描述和这条时间线，没有决策正文，也没有「金额列为空」「金额还在」。

## 2. Add

金标整句不在库里，但后一条结论的改写已经落在该决策的 conflicts 上。写入本身把后一条留下了，答错不是因为没落库。

三条来源都在 `adds[]`。

- `t_report` 的 extract 留下决策「月报按客户过滤，没有客户名的分录不计入月报」，并新建主题。`steps[0].progress` 的 `dropped` 把「没有客户名时这笔不进月报」标成 `local_implementation` 丢掉。`diff.pm_decisions.added` 只有前一句。这次 judge 的 `drafts` 只有金额那条 `d1`，空客户草稿 `d0` 不在其中。
- `t_column` 的 extract 另抽出「空客户测试改为：金额列为空时不进月报」，assign 归到 `topic_971af7461adb402d`。judge 对 `d1` 给出 `same_question_as=dec_cf169237fa12418f`、`same_as=null`、`approved_by=[]`。`diff.pm_decision_conflicts.added` 写入了这条冲突。
- `t_bug` 的 extract 抽出「月报只跳过金额列为空的行，客户名为空但金额存在的记录保留」，assign 仍归该主题。judge 同样 `same_as=null` 且无人认可。`diff.pm_decision_conflicts.updated` 把上一条冲突改成这句。`diff` 里没有 `pm_decision_history`。时间线草稿「month.json 的改动已撤回」在 assign 里 `defer`，`diff.pm_deferred_segments` 记了 `work_unresolved` 和 `ambiguous_topic`，与空客户规则无关。

M04 没有归错，也没有为这条再建主题。M05 把未经认可的不同结论放进了 conflicts。后一句因此在库里，只是词面和金标整句不一致，所以 `locations` 仍为空。

## 3. 其他

`reader.user` 里该主题的描述仍是「没有客户名的分录不计入月报」，进展只到林工加空客户测试。回答照这段复述，并写「测试的具体代码细节在记忆中没有贴出」。阅读模型没有编出库里没有的规则。

`goldAnswer` 要求同时写出林工的旧测试和周工「只跳过金额为空的行、空客户但金额还在的留下」，并说明要成员确认。`judge.reason` 指出的正是这两点遗漏。渲染里没有后一条，评委和金标与这个缺口一致。

## 4. 根因分类与证据

主因：`search_entry_filter`。

后一条结论已在 `dec_cf169237fa12418f` 的 conflicts 里，但该决策 `kept=false`，没有进入 `reader.user`。回答因此只看到旧规则。

证据：

- `search.topics` 中「月报按客户过滤分录」的 `entries[1]`：`dec_cf169237fa12418f`，`kept=false`，词面分 0.0833。
- `adds[2]`（`t_bug`）`steps[0].diff.pm_decision_conflicts.updated.after`：「客户名为空但金额存在的记录保留」。
- `reader.user` 该主题正文：「没有客户名的分录不计入月报」。其中没有「金额还在」。

改法方向：让这条决策的 conflicts 越过词面门槛进入渲染，或把冲突句同步进仍会被渲染的主题描述。提问后 `reader.user` 应出现「金额列为空」。

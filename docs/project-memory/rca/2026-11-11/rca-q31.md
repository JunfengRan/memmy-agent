# rca-q31

跑次 `eval/project-memory/runs/2026-11-11T06-49-59-369Z/`，档案 `trace/questions/q31.json`。

问题：ledger 月报的金额现在以什么为准？  
种类：`stale`。  
金标：以 entries 的 amount 列为准，月报按这列汇总。林工已确定以周工的结论为准，把金额留在 journal 正文里的旧结论已转入历史。  
回答：称存在「两条尚未确定的决策」，一条是金额仍写在 journal 正文，另一条是 entries 表新增 amount 列，并另提整数分约定。  
`judge.correct` 为 false。`judge.reason`：把已转入历史的 journal 正文方案说成尚未确定的当前方案，且未明确以 entries 的 amount 列为准。

## 1. Search

按落点字段，金标原文不在库里。`search.gold[0]` 正文是「给 entries 加 amount 列，月报直接按这列汇总，不再扫描 journal 全文，因为扫全文太慢。」`locations` 为 `[]`，`entryHit` 为 0。因此没有金标条目的所在主题，也没有该条目的词面名次、向量名次、最终名次和 `withinLimit`。

同义的现行口径和应退出的旧口径都以主题正文进了 `reader.user`，不是 `locations` 命中：

- 「月报金额存储方式调整」（`topic_23656b72e8044249`）：词面 7，向量 3，最终 6，`withinLimit` true。条目 `dec_f6de98ee076c4d72` 的 `lexical` 0.0833、`kept` false。描述仍被渲染，含「现改为在 entries 表增加 amount 列」。
- 「月报金额存储约定」（`topic_ca1fa09c4eb64669`）：词面 5，向量 2，最终 3，`withinLimit` true。条目 `dec_c983e6d1a71d426f` 的 `lexical` 0.1667、`kept` false。描述仍被渲染，含「金额继续以文本形式写在 journal 正文」。

两条都是 `kept` false，词面门槛滤掉的是条目行，不是主题摘要。`reader.user` 没有金标原句，也没有「转入历史」或「以周工的为准」。两条都被标成已确定内容。

## 2. Add

旧结论仍作为已确定主题存在，金标要求的历史转移没有发生。展开三条来源。

`adds[0]`（`t_journal`）extract 得到「月报不改 entries 表结构，金额继续写在 journal 正文里」。assign 新建主题「月报金额存储约定」，decision `dec_c983e6d1a71d426f`。这一步与当时的会话一致。

`adds[1]`（`t_column`）extract 得到「entries 表增加 amount 列，月报汇总直接读该列，不再扫描 journal 全文」。assign 把它做成新主题「月报金额存储方式调整」（`independent_delivery` true，同时 `affects_existing_decisions` true）。d0 的 `ops.checked` 为 `[]`，`hit` 为 null，没有对照旧决策 `dec_c983e6d1a71d426f`。judge 回复只处理了空客户那条 d1，`topic_updates` 为 `[]`。旧主题未被改写，库里变成两个都算当前的金额主题。

`adds[2]`（`t_resolve`）会话是「以周工的为准，金额读 amount 列。」extract 的草稿带 `signals`：`type` 为 `resolve`，`pick` 为「给 entries 加 amount 列，月报直接按这列汇总」，`by` 为 `u_lin`。助手那句被标成 `restatement` 丢掉。assign 只归到新主题 `topic_23656b72e8044249`。judge 把 d0 判成 `same_question_as` `dec_f6de98ee076c4d72`、`same_as` 为 `content`、`resolve` 为 null、`topic_updates` 为 `[]`。`diff` 的键只有 `pm_decisions` 和 `pm_topics`：决策正文未改，只把 `user_ids_json` 收成 `["u_zhou","u_lin"]`；新主题描述前后相同。没有 history 表的写入，旧主题「月报金额存储约定」不在这次 diff 里。

## 3. 其他

`reader.user` 把两个主题都放在已确定内容里。「月报金额存储方式调整」的描述含「原先金额以文本形式写在 journal 正文中」和「现改为在 entries 表增加 amount 列」。回答改写成「两条尚未确定的决策」，这个「尚未确定」不是渲染原文。即便改回渲染里的「现改为」，渲染中仍然没有「旧结论已转入历史」，单靠阅读模型写不出金标的后半句。`judge.reason` 要求的历史转移与 `t_resolve` 的 resolve 信号同向，不是评委或金标写错。

## 4. 根因分类与证据

主因：`add_judge`。共同因素是前一轮归属新建主题并未对照旧决策；裁决轮也只读取新主题，不能把未处理旧决策全部归咎于判断提示词。

`t_column` 新建了重复主题，且 d0 没有对照旧决策。金标要的「转入历史」落在 `t_resolve`：抽取已经给出 resolve，judge 没有执行。

证据：

- `adds[2].modelCalls[0].response.content`：`"type":"resolve"`，`pick`「给 entries 加 amount 列，月报直接按这列汇总」。
- `adds[2].modelCalls[2].response.content`：`"resolve":null`，`same_as` 为 `content`。
- `adds[2].steps[0].diff` 无 history；`reader.user` 仍有「金额继续以文本形式写在 journal 正文」。

后续验证建议（本次未实现）：复跑 `t_resolve` 后，resolve 应作用到旧决策 `dec_c983e6d1a71d426f`，diff 里能看到 journal 正文方案进入 history，`reader.user` 不再把它写成已确定的当前口径。

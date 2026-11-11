# rca-q17

跑次 `eval/project-memory/runs/2026-11-11T06-49-59-369Z/`，档案 `trace/questions/q17.json`。

问题：空客户的账为什么会被整行丢掉？  
金标：因为 report.ts 读取时客户名为空就把整行丢掉；丢行的问题已经修好，但空客户该怎么处理还有不一致结论。  
回答：因为月报按客户过滤分录，没有客户名的分录不计入月报；report.ts 已按此口径实现，并补充了空客户测试。  
`judge.correct` 为 false。`judge.reason`：整行丢弃已经修好，空客户处理仍有不一致结论；回答把丢弃说成当前实现，且未提及不一致。

## 1. Search

提问时金标原文不在库里。`search.gold[0]` 的条目是 `tl_bug`，正文「month.json 的改动已撤回，report.ts 丢弃空客户整行的问题已修复。」`locations` 为 `[]`，`entryHit` 为 0。金标没有所在主题，因此没有金标主题的词面名次、向量名次、最终名次和 `withinLimit`。

读者实际用到的是「月报按客户过滤分录」（`topic_971af7461adb402d`）：词面名次 1，向量名次 6，最终名次 1，`withinLimit` true。它的两条条目都被词面门槛滤掉：`tl_79b9340d175b4ed9` 的 `lexical` 0.1538、`kept` false；`dec_cf169237fa12418f` 的 `lexical` 0.0769、`kept` false。`reader.user` 里该主题没有「相关决策」行。

`reader.user` 没有金标句「问题已修复」，也没有「不一致」。它有的是未改写的主题描述：「没有客户名的分录不计入月报」。

## 2. Add

库里的可见口径与金标相反，展开 `adds[0]`（`t_bug`）。

extract 抽出 decision「月报只跳过金额列为空的行，客户名为空但金额存在的记录保留」，以及 timeline「month.json 的改动已撤回」。同时把「问题在 report.ts：客户名为空时整行被丢掉。」标成 `restatement` 丢掉，把「修读取。」标成 `local_implementation`。

assign 把 decision（d0）归到 `topic_971af7461adb402d`，把 timeline（d1）`defer: true`，原因 `work_unresolved`。`ops` 只命中 `dec_cf169237fa12418f`。

judge 回复：`same_question_as` 为 `dec_cf169237fa12418f`，`same_as` 为 null，`resolve` 为 null，`topic_updates` 为 `[]`。`diff` 里 `pm_decision_conflicts` 把 seq 1 从「空客户测试改为：金额列为空时不进月报」改成「月报只跳过金额列为空的行，客户名为空但金额存在的记录保留」；`pm_topics` 的 `topic_summary` 与 `topic_description` 前后相同，仍是「没有客户名的分录不计入月报」。`pm_deferred_segments` 写入「month.json 的改动已撤回」（`work_unresolved`，另有一条同文 `ambiguous_topic`）。diff 键里没有 history。

新结论只覆盖了 conflict 的一条正文，主题描述没更新，延迟片段也不可检索。渲染因此仍把「没有客户名的分录不计入月报」写成已确定的当前口径，也没有列出不一致的双方。

## 3. 其他

阅读模型复述了 `reader.user` 里「月报按客户过滤分录」的描述，没有另造「当前实现」这层意思。`goldAnswer` 要求的「已经修好」和「不一致结论」都不在渲染里。`judge.reason` 与 `t_bug` 里「现在只跳过金额列为空的行，空客户但金额还在的会留下」同向，不是评委或金标写错。

## 4. 根因分类与证据

主因：`add_judge`。

同轮还有抽取把诊断句标成 `restatement`、撤回被 defer。读者复述的是 judge 没有改写的主题描述，所以主因取 M05。

证据：

- `adds[0].modelCalls[2].response.content`：`topic_updates` 为 `[]`，`resolve` 为 null。
- `adds[0].steps[0].diff.pm_topics.updated[0].after.topic_description`：仍是「没有客户名的分录不计入月报」。
- `reader.user` 含这句，不含「客户名为空但金额存在的记录保留」。

后续验证建议（本次未实现）：复跑 `t_bug` 后，该主题描述不应再把「没有客户名的分录不计入月报」写成唯一现行口径；新结论与旧口径应同时出现在 `reader.user`，或旧口径进入 history 后不再作为已确定正文。

# rca-q15

跑次 `eval/project-memory/runs/2026-11-11T06-49-59-369Z/`，档案 `trace/questions/q15.json`。

问题：月报测试失败是因为样例文件旧了吗？  
金标：不是，是 report.ts 的读取问题：客户名为空时整行被丢掉；改样例文件修不好，那次改动已经撤回。  
回答：记忆中没有相关内容。  
`judge.correct` 为 false。`judge.reason`：失败是 report.ts 在客户名为空时丢弃整行，并非样例文件旧，回答却称没有相关内容。

## 1. Search

提问时金标不在库里。`search.gold[0].locations` 为 `[]`，`entryHit` 为 0。金标条目 `exp_fixture` 没有所在主题，因此没有词面名次、向量名次、最终名次和 `withinLimit`。

返回的主题里，带条目的 `entries[].kept` 全是 false（例如最终名次 1 的「月报输出文件命名与目录约定」，词面 1、向量 3、`withinLimit` true，条目 `dec_fe45fdf6cf9b4ff6` 的 `lexical` 为 0.1333、`kept` false）。这是别的主题的条目被词面门槛滤掉，不是金标条目。

`reader.user` 没有金标句，也没有「样例文件旧了」或「撤回」。渲染里和 report.ts 最接近的是最终名次 3 的「月报按客户过滤分录」（词面 8、向量 1、`withinLimit` true），正文是「没有客户名的分录不计入月报」，两条条目 `kept` 都是 false。这段回答不了测试失败是不是因为样例文件。

## 2. Add

库里没有这句诊断，展开两条来源 `t_admin_bug`、`t_bug`。

`adds[0]`（`t_admin_bug`）只有 extract。会话里助手已说「空客户被丢掉是 report.ts 的读取问题，不是样例文件旧了。」回复把这句标成 `process_material`，把「这个失败以读取代码为准。」标成 `unresolved`，`drafts` 为空。`steps[0].progress` 的 `dropped` 与此相同，`assignments` 和 `ops` 都是空数组，`diff` 为 `{}`，`added` 为 0。诊断没有进入库。

`adds[1]`（`t_bug`）的 extract 把「问题在 report.ts：客户名为空时整行被丢掉。」标成 `restatement` 丢掉，把「修读取。」标成 `local_implementation`。留下的 decision 正文是「月报只跳过金额列为空的行……」，诊断只出现在该草稿的 `reason` 里，没有变成条目正文。assign 把 timeline「month.json 的改动已撤回」`defer: true`，原因 `work_unresolved`。judge 的 `topic_updates` 为 `[]`，`resolve` 为 null。`diff` 只把 `pm_decision_conflicts` 里 `dec_cf169237fa12418f` 的 seq 1 改成「月报只跳过金额列为空的行，客户名为空但金额存在的记录保留」，主题「月报按客户过滤分录」的 `topic_description` 前后相同；「month.json 的改动已撤回」写入 `pm_deferred_segments`（`work_unresolved`，另有一条同文 `ambiguous_topic`）。渲染里看不到撤回，也看不到丢行诊断。

判错的那句（不是样例旧了，是 report.ts 在客户名为空时丢整行）在抽取时已被丢掉。撤回是同轮的延迟，没有进可检索主题。

## 3. 其他

阅读模型没有误读。`reader.user` 里没有样例失败，也没有撤回，回答「记忆中没有相关内容」与渲染一致。`judge.reason` 和 `goldAnswer` 都指向 report.ts 丢行，与 `t_admin_bug`、`t_bug` 的会话原文一致，不是评委或金标写错。

## 4. 根因分类与证据

主因：`add_extract_drop`。

证据：

- `adds[0].modelCalls[0].response.content`：`process_material`，原文「不是样例文件旧了」。
- `adds[1].modelCalls[0].response.content`：`restatement`，原文「客户名为空时整行被丢掉」。
- `search.gold[0].locations`：`[]`。`reader.user` 不含上述两句。

改法方向：复跑 `t_admin_bug` 与 `t_bug` 后，这两句不应再出现在 extract 的 `dropped` 里，`reader.user` 应能看到「不是样例文件旧了」和「客户名为空时整行被丢掉」。

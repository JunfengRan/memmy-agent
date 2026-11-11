# rca-q16

跑次 `eval/project-memory/runs/2026-11-11T06-49-59-369Z/`，档案 `trace/questions/q16.json`。

问题：tests/fixtures/month.json 现在还留着之前的改动吗？  
金标：没有，month.json 的改动已经撤回。  
回答：记忆中没有相关内容。  
`judge.correct` 为 false。`judge.reason`：标准答案说改动已经撤回，回答却称没有相关内容。

## 1. Search

提问时金标不在库里。`search.gold[0].locations` 为 `[]`，`entryHit` 为 0。金标条目 `tl_bug` 没有所在主题，因此没有词面名次、向量名次、最终名次和 `withinLimit`。

返回主题都与 month.json 无关。最终名次 1「main 分支直接修改约定」词面 2、向量 6、`withinLimit` true，`entries` 为空。有条目的主题 `kept` 为 false，例如最终名次 2「功能分支与 main 分支协作约定」的 `dec_76eb9ca0c7824021`，`lexical` 0.0714、`kept` false。这些不是金标条目。

`reader.user` 没有「month.json」，也没有「撤回」。

## 2. Add

库里没有「已撤回」，展开 `adds[0]`（`t_bug`）。

extract 已经抽出 timeline，正文就是「month.json 的改动已撤回」（`drafts` 里的 d1）。丢掉的是「修读取。」（`local_implementation`）和「问题在 report.ts：客户名为空时整行被丢掉。」（`restatement`），撤回这句不在 `dropped` 里。

assign 把 d1 标成 `defer: true`，`deferred` 原因是 `work_unresolved`，没有 `topic_id`。`steps[0].progress` 的 `deferredCount` 为 2，`ops` 只有 d0（命中 `dec_cf169237fa12418f`），没有 d1。`diff.pm_deferred_segments.added` 有两条相同片段「month.json 的改动已撤回」，原因分别是 `work_unresolved` 和 `ambiguous_topic`。assign 回复里只写了 `work_unresolved`。主题「月报按客户过滤分录」的 `topic_description` 前后相同，没有撤回。

抽取没丢这句，它停在延迟片段里，没有写入可检索的时间线或主题。

## 3. 其他

阅读模型没有误读。`reader.user` 没有 month.json，回答「记忆中没有相关内容」与渲染一致。`goldAnswer` 的「已经撤回」与 `t_bug` 里助手原文「month.json 已撤回。」一致，`judge.reason` 没有判错方向。

## 4. 根因分类与证据

主因：`add_deferred`。

证据：

- `adds[0].modelCalls[1].response.content`：`defer: true`，原文「month.json 的改动已撤回」，原因 `work_unresolved`。
- `adds[0].steps[0].diff.pm_deferred_segments.added`：同文两条，原因含 `ambiguous_topic`。
- `search.gold[0].locations`：`[]`。`reader.user` 不含「撤回」。

改法方向：复跑 `t_bug` 后，这句不应再写入 `pm_deferred_segments`，而应出现在可检索的时间线或主题里，`reader.user` 能看到「撤回」。

# q07 catalog 导出的价格表现在是什么格式？

评委判错：回答只说导出改为 CSV、不再输出 JSON，没有写文件名 `prices.csv`。

## 1. Search

金标整句在提问时不在库里。`search.gold[0]`（`dec_export_format.content`，「价格表导出为 csv，写成 prices.csv，不再用 json。」）的 `locations` 是 `[]`。

相关主题是「价格表导出格式改为 CSV」（`topic_330af38f1b0f4596`）。词面名次 `lexicalRank=1`，向量名次 `vectorRank=4`，最终名次 `rank=2`，`withinLimit=true`。它在 `search.returnedTopicIds` 的第 3 位。

该主题决策 `dec_7bb66776f3c44136` 词面分 0.3077，`minEntryHits=3`，`kept=true`，没有被词面门槛滤掉。`reader.user` 有这条决策：「价格表导出格式改为 CSV，不再使用 JSON」。渲染里没有 `prices.csv`，也没有 `prices.json`。

`entryHit=1` 只说明返回列表里的这条决策被对齐成了金标条目。金标整句的 `locations` 仍为空，文件名不在库里。

## 2. Add

库里有「改为 CSV、不再用 JSON」，没有「写成 prices.csv」。来源是 `adds[]` 的 `t_export` 和 `t_csv`。

- `t_export`：用户要导出价格表，助手说写成 `prices.json`。extract 的 `drafts` 为空。`dropped` 把「再把价格表写成 prices.json」标成 `local_implementation`，把用户那句标成 `execution_step`。`diff` 没有新增行。这是被取代的旧格式，不是本题所缺的现用文件名。
- `t_csv`：用户说「导出别写 json 了，改成 csv。」助手说「export.ts 现在写 prices.csv，不再用 json。」extract 只留下「价格表导出格式改为 CSV，不再使用 JSON」，把「export.ts 现在写 prices.csv，不再用 json。」标成 `local_implementation`。没有 judge。assign 新建主题「价格表导出格式改为 CSV」，描述只写「不再输出 JSON，改为 CSV 格式」。`diff.pm_decisions.added` 的正文与草稿相同，不含 `prices.csv`。

这是 M02 把带文件名的句子当成实现细节丢掉。M04 的新主题就是导出格式，没有归到别的主题。M05 没有旧决策可比。决策后来 `kept=true` 并被渲染，缺的是正文里的文件名，不是条目被滤掉。

## 3. 其他

回答写的是「改为 CSV、不再输出 JSON」，与 `reader.user` 里的决策句一致，没有把 CSV 读成别的格式。它漏掉的 `prices.csv` 在渲染里不存在。

`goldAnswer` 要求「导出为 csv，写成 prices.csv，不再写 prices.json。」`mustInclude` 含 `prices.csv`。`judge.reason` 只指责没有写明文件名。评委和金标与会话助手原句一致，不是误判。

## 4. 根因分类与证据

主因：`add_extract_drop`。

证据：

- `adds[1]`（`t_csv`）extract 回复的 `dropped`：`local_implementation`，「现在写 prices.csv，不再用 json」。
- `adds[1].steps[0].diff.pm_decisions.added` 的 `content`：「改为 CSV，不再使用 JSON」。
- `reader.user` 决策条：「不再使用 JSON」。其中没有 `prices.csv`。

后续验证建议（本次未实现）：抽取时保留文件名 `prices.csv`，不要把这句整句标成 `local_implementation`。决策正文或主题描述应出现 `prices.csv`，`reader.user` 里也能看到。

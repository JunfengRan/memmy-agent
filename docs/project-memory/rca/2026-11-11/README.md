# 2026-11-11 错题归因

跑次 R-20261111-06，原始输出在 `eval/project-memory/runs/2026-11-11T06-49-59-369Z/`（不进 git）。每题先看提问时库里有没有答题所需的句子，再看抽取、归属、判断和检索门槛。逐题文件是同目录的 `rca-<qid>.md`。

| 题 | 主因 | 一句话 |
| --- | --- | --- |
| q04 | search_entry_filter | 不同结论已在决策的 conflicts 里，该决策没过词面门槛，渲染只剩旧规则 |
| q06 | add_extract_drop | 「输出前按两位小数取整」被标成 `local_implementation` |
| q07 | add_extract_drop | `prices.csv` 被标成 `local_implementation`，库里只剩「改为 CSV」 |
| q14 | add_extract_drop | 「README 里的连接串已经删掉了」被标成 `local_implementation` |
| q15 | add_extract_drop | 诊断句被标成过程材料或复述，库里没有这句 |
| q16 | add_deferred | 「month.json 的改动已撤回」抽出来后被推迟，没有进可检索主题 |
| q17 | add_judge | 新结论没有改写主题描述，渲染仍是旧的丢行口径 |
| q31 | add_judge | 抽取给出的 resolve 被判断空掉，旧结论没有转入 history |
| q42 | add_extract_drop | 采购核对的两句都被标成复述，草稿为空 |

| 主因 | 题数 |
| --- | ---: |
| add_extract_drop | 5 |
| add_judge | 2 |
| add_deferred | 1 |
| search_entry_filter | 1 |

检索侧：9 题里只有 q04 是「库里有、阅读模型没看到」。其余 8 题在提问时金标整句的 `locations` 为空，不是排序把对的主题挤出前 9。

写入侧：丢句集中在 M02 的 `local_implementation`、`process_material` 和 `restatement`。判断阶段的问题是该改写主题或转入 history 时没有改。

## 答对但 entryHit 为 0

只列出，不展开：q01、q02、q05、q09、q19、q24、q25、q29、q41、q43、q46、q47。

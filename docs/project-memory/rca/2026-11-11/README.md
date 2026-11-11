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

检索侧：q04 的关键同义内容已在 conflicts，但所属决策被条目门槛滤掉。其余 8 题需要结合逐题 Add diff 和 reader.user 判断缺失、过时或未正确组织的事实；不能只凭金标整句的 `locations=[]` 推断没有同义内容。q31 就有新旧口径的同义描述，主要缺失的是裁决与历史状态，并非完全没有相关文字。

这些是主因分类，不是唯一原因：q17 同时涉及抽取、推迟和条目过滤；q31 先有跨主题拆分，再有 resolve 未生效。现有追踪不支持把它们全部归成主题排序问题。

写入侧：丢句集中在 M02 的 `local_implementation`、`process_material` 和 `restatement`。判断阶段的问题是该改写主题或转入 history 时没有改。

## 答对但 entryHit 为 0

只列出，不展开：q01、q02、q05、q09、q19、q24、q25、q29、q41、q43、q46、q47。

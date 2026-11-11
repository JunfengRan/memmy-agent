# q14 README 里现在还有数据库连接串吗？

评委判错：标准答案是 README 里的连接串已经删掉、密码只留在本机 `.env`；回答说无法确定当前状态。

## 1. Search

金标整句在提问时不在库里。`search.gold[0]`（`dec_env.content`，「数据库密码只留在本机 .env，不写进仓库，README 里也不放连接串。」）的 `locations` 是 `[]`。

相关主题是「密钥文件本地保管约定」（`topic_80da9cc325684e52`）。词面名次 `lexicalRank=1`，向量名次 `vectorRank=2`，最终名次 `rank=1`，`withinLimit=true`。它是 `search.returnedTopicIds` 的第 1 条，也是 `reader.user` 的第一条记忆。主题被召回了。

该主题决策 `dec_c55bc2a0c0784efb` 词面分 0.1667，`minEntryHits=3`，`kept=false`，决策正文被词面门槛滤掉。`reader.user` 仍渲染了主题摘要和描述：`.env` 只留在本机，文档和记录里不写连接串，「发现外泄内容即移除」。其中没有「已经删掉」，也没有「密码」。

决策被滤掉不是答错的原因。库里的决策正文同样没有「README 里的连接串已经删掉了」，放进渲染也回答不了「已经删了」。

## 2. Add

库里没有「连接串已经删掉」。来源是 `adds[]` 的 `t_write_secret`、`t_admin_env`、`t_env`。

- `t_write_secret`：用户要把连接串写进 README，助手说已经写进 README。extract 的 `drafts` 为空，两句分别标成 `unrelated` 和 `execution_step`。`diff` 无新增。这是后来被撤掉的旧状态。
- `t_admin_env`：用户说「.env 不能出现在说明里。」extract 留下「密钥文件 .env 只留在本机，说明和普通记录里都不放连接串。」助手的复述被标成 `restatement`。assign 新建本主题。`diff.pm_decisions.added` 就是这句约定，没有 README 已删除。
- `t_env`：用户说「数据库密码别写进仓库。」助手说「README 里的连接串已经删掉了。密码只留在本机的 .env」。extract 只留下「数据库密码不写进仓库，只放在本机 .env 中。」`dropped` 把助手整句标成 `local_implementation`。assign 归到已有主题。judge 对 `d0` 给出 `same_question_as=dec_c55bc2a0c0784efb`、`same_as=content`。`diff.pm_decisions.updated` 只把 `u_lin` 并进 `user_ids`，`content` 仍是周工那句，没有 history，也没有把「已经删掉」写进去。送到 judge 的草稿里已经没有这句。

这是 M02 把「已经删掉」当成实现细节丢掉。M04 归到密钥主题，没有另建主题。M05 按 `same_as=content` 只补了作者，没有漏写一条已经抽出来的冲突。

## 3. 其他

`reader.user` 的约定是今后不写连接串、发现外泄再移除，没有写 README 当前已经删掉。回答说「记忆中没有记录 README 当前是否还含数据库连接串」，和这段渲染一致。回答没有复述渲染里的 `.env`，但评委否定的是「无法确定」而不是漏写 `.env` 这三个字符。即便补上 `.env`，渲染里仍然没有「已经删掉」。

`goldAnswer` 是「没有了，README 里的连接串已经删掉，密码只留在本机 .env。」`judge.reason` 对比的就是已删除和只留在本机 `.env`。这与 `t_env` 助手原句一致，不是金标或评委写错。

## 4. 根因分类与证据

主因：`add_extract_drop`。

证据：

- `adds[2]`（`t_env`）extract 回复的 `dropped`：`local_implementation`，「README 里的连接串已经删掉了」。
- `adds[2].steps[0].diff.pm_decisions.updated.after` 的 `content` 仍是：「说明和普通记录里都不放连接串」。
- `reader.user` 该主题描述：「发现外泄内容即移除」。其中没有「已经删掉」。

改法方向：抽取时保留「README 里的连接串已经删掉了」，不要把它标成 `local_implementation`。这句应进入决策或主题描述，提问后 `reader.user` 应出现「已经删掉」。

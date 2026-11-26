# v3-flush 逐事件 badcase 笔记（2026-11-26）

被测：MemOS `promem_dev-rjf@3d8450ba`，冻结在 detached worktree `~/repos/MemOS-stepwise`，整次评测不改算法。
评测：`feat/project-memory-gold-v3-flush`。数据集 v3，gold revision 2（flush 模式），共 148 个事件：113 次 Add、35 个问题。
模型：SUT 和 reader 是 `deepseek-v4.1-flash-1017`，judge 是 `gpt-6-luna`。
运行：
- 服务：`step-serve.zsh runs/20261126-stepwise 58100`
- 回放：`step-run.zsh runs/20261126-stepwise 58100 [--resume]`
- 环境：本地库 `add_verify_step`，schema `memos_v3_58100`

记录格式：每个案例一节，写明事件、类别、出错阶段、证据、根因、修改意见，以及和前面哪个案例同源。

## 评测环境修复（不涉及被测算法）

- `replay_app.py` 原来查的是旧的 `episodes` 字段，改成查 `add_jobs`；时钟推进时同时跑生产计时器里的「静默 Space Formation」。
- create_space 现在要求传 `project_id`，上游检索又按 tenant 读，所以回放用的 `project_id` 改成和 tenant 一致的 `memos_v3_<port>`。
- 共享 project DB 每个库只装一份 `project_memory` schema，向量维度是固定的。旧库里那份是 1024 维，这次的嵌入是 384 维，所以单独建了库 `add_verify_step`，并装了 `btree_gist` 扩展。
- MemOS 的 `config.py` 会 `load_dotenv(override=True)`，用主仓库跑时会读到 `MemOS/.env`，把 Qdrant 等依赖指到别的地址。所以被测代码放在没有 `.env` 的 worktree 里跑。

## 案例

### 案例 1：t_ledger_tz 的时区决策被证据校验整条丢弃（missing）

- **暂停点**：event 7（t_price，10-21 11:42）之后。核对对象是 event 5 的 t_ledger_tz（ledger-follow，周工，11:20）。
- **原文**：周工说「月报的月初月末按东八区算，别用 UTC。」，Agent 回复「report.ts 切月份时按 UTC+8 算月初月末，不再用 UTC。」
- **gold**：`add:dec_tz`，内容是「月报的月初月末按 UTC+8（东八区）切分，不用 UTC。」，放在 Topic `tp_ledger_report`。`tl_ledger_tz` 是 optional，不计分。
- **MemOS 实际**：Episode `3d16a493`（seq 5-6）走完了 boundary 和 extract 两次模型调用，结果是 `done/skipped`，drafts 为 0，没写入任何条目。
- **证据**：用 `inspect-memos.py calls --event 7` 查看 extract 的输出。模型其实给出了两条正确的 draft：
  1. decision「月报的月初月末按东八区（UTC+8）计算，不使用 UTC。」，quote 取周工原话，没有附 `context`。
  2. timeline「report.ts 切月份时已改为按 UTC+8 …」，quote 取 Agent 原话，但 `source_path` 填成了 `/content/report.ts`。
- **根因**：两条 draft 都在 `add_extraction._draft` 的校验里被丢掉了。
  1. decision：`unwitnessed_tokens(content, witness)` 返回 `{'8'}`。content 里的「UTC+8」不在周工原话里，而同一轮 Agent 回复作为佐证只有在模型显式写了 `context` 时才算（`supporting` 只从 `raw.context` 里取）。prompt 虽然要求「改用 Agent 回复里的规范写法时在 context 里引用 Agent 那句原话」，模型没照做，于是整条 decision 被丢。
  2. timeline：`quote_ref(row, quote, "/content/report.ts")` 返回 None。模型把文件名写进了 `source_path`，路径非法，整条被丢。
- **阶段**：抽取后的证据校验（`add_extraction._draft`）。问题在校验太严、处理太粗，不在模型抽取本身。
- **修改意见**：
  1. 同一 Turn 里晚于成员消息的 Agent 回复，默认就作为 witness 的佐证文本，不再要求模型显式写 `context`。它只用来佐证取值，不用来授权，这和 `_member_anchored` 的思路一致。
  2. 证据里找不到的 token 先尝试剥掉，例如去掉括号里的「（UTC+8）」；剥完后仍然成立就保留这条 draft，不要整条丢。
  3. `source_path` 不是合法 JSON Pointer，或者在消息里找不到时，回退到 `/content` 重新定位 quote。
  4. 被丢弃的 draft 应该把原因写进 `organize_result.warnings`，或者写一条 `add_episode_events`。现在只有一条 logger.warning，查问题时看不到。

### 暂停 2：q48（10-21 11:50）为核对器误报，不是 badcase

- 报的是 t_price 的 `tl_price` missing。实际上 MemOS 已经写入了 timeline「price 表已新增 amount 列，列表已改为直接读 amount 列…」，和 gold 是同一事实。q48 也答对了。
- 原因在核对器：最终 gold 的归属结果是 `[dec_price, tl_price]`，但按当时状态复核时只保留了第一个 id `dec_price`，于是 `tl_price` 被当成缺失。现在复核优先选同 kind 的条目，并保留其余已经可见的 id，同时补了回归测试。
- 顺带的观察（只记录，不算错）：t_price 的 Episode 先被 staged，到 q48 前 flush 时 Formation 才建出 Topic「price表amount列与列表直读」。

### 案例 2：t_ledger_loc 的报告路径决策被丢弃（missing，和案例 1 同源）

- **暂停点**：event 14（t_wait，10-21 13:22）之后。核对对象是 t_ledger_loc（ledger-follow，周工，12:50）。
- **原文**：周工说「月报结果写到 reports 目录下，按月份命名。」，Agent 回复「月报结果写到 reports/ 下，文件名按月份，比如 2026-10.txt。」
- **gold**：`add:dec_report_path`，内容是「月报结果写到 reports/ 目录，文件按月份命名，如 2026-10.txt。」。gold 自己就采用了 Agent 给的示例值。`tl_ledger_loc` 是 optional。
- **MemOS 实际**：Episode `77ab03da` 结果是 `done/skipped`，drafts 为 0。
- **证据**：模型输出了 decision「月报结果写到 reports 目录下，文件名按月份命名，例如 2026-10.txt。」，key_values 里有 `2026-10.txt`，但没附 context。`unwitnessed_tokens` 返回 `{'2026','10'}`：示例文件名只出现在 Agent 回复里。
- **根因**：和案例 1 相同。同一轮 Agent 回复里的规范写法和示例值不算 witness，content 里多出一个 token 就整条丢。这条在 gold 里还是「对外约定」类的 decision，丢了以后，后面问报告路径的题都会受影响。
- **修改意见**：同案例 1 的第 1、2 条。另外，即使整条 content 丢失，回退到只用成员原话（「月报结果写到 reports 目录下，按月份命名。」）也比完全不写好。

### 暂停 4：q01（10-21 14:00），q01 答对了，但前面几次 Add 一起暴露了三类问题

q01 前的 flush 让 ledger 和 catalog 两个 Space 都跑了 Formation，下面三类问题都出在这一轮。

#### 案例 3：Topic 切得太细，一项工作被拆成「一条规则一个 Topic」（topic_split）

- **现象**：
  - gold 的 `tp_ledger_report`（ledger 月报生成）在 MemOS 里拆成了两个 Topic：「月报金额从journal正文提取」和「月报金额整数分计算」。
  - gold 的 `tp_cat_price`（价格列表）拆成了三个：「price表amount列与列表直读」「sku 比较前转大写」「价格显示两位小数」。
- **证据**：
  - Topic 归属这一步（`episode.assign`，event 13/14/16/17）对每个 Episode 都返回 `action: stage`，`same_deliverable: false`。它比较的是 Episode 的 deliverable（如「price.ts 中 sku 比较前统一转大写的逻辑」）和现有 Topic 的 deliverable（「price 表新增 amount 列，列表直接读取 amount 列」）。
  - 现有 Topic 的 deliverable 在建 Topic 时就被写成了**第一条规则本身**，Topic 名称也一样（「月报金额从journal正文提取」）。所以同一份报表后来的规则，按定义就不可能是「同一交付对象」。
  - 这些 Episode 都进了 staged，到 flush 时由 Formation 统一聚类。Formation 的 prompt 第 2 条明明写着「同一份报表的时区、输出目录、去重和金额精度属于同一项工作」，模型还是把「整数分」单独建了 cluster。prompt 后面又有第 3、4 条「互不影响、可分别交付的规则必须分别建」「拿不准时拆开」，以及「同一模块…只要交付对象和验收条件不同，就是不同工作」，这些都在把模型往拆的方向推。
- **根因**：
  1. Topic 的 deliverable 和名称按第一条决策的粒度生成，没有上升到「这项工作或产出物」（如 ledger 月报、价格列表）。
  2. Formation 和 assign 的 prompt 里，合并和拆分的规则互相冲突，而且「拿不准时拆开」让拆分成了默认选项。
  3. 归属这一步只比较 deliverable 的文字，没有用上共享资源（report.ts、price.ts 是强信号），也没有用上同一会话里的连续工作。
- **阶段**：Topic 归属（`add_algorithm._choose_topic` / `_ASSIGN`）和 Formation（`_FORMATION`）。
- **修改意见**：
  1. 建 Topic 时，deliverable 和名称按「产出物或功能」命名（ledger 月报、价格列表），具体规则放到 decisions 里，不放进 Topic 标题。可以在 `_FORMATION` 和 metadata prompt 里要求 deliverable 只写对象、不写结论或取值。
  2. 去掉「拿不准时拆开」，改成：共享文件或模块（shared_anchor），或者同一产出物的子设置，默认合并；只有交付对象明确不同时才拆。
  3. assign 阶段对 `shared_anchor`（如 report.ts 或 price.ts 已经是某个 Topic 的 anchor）给出强先验。可以先用规则召回，只有不确定时再问模型。
  4. 这一条会显著影响 topic F1 和 duplicateTopics（历史上每次跑有 7–15 个重复 Topic），收益应该是最大的。

#### 案例 4：跨成员的不一致结论被 Formation 拆成两个 Topic（conflict_as_entry 和 topic_split）

- **原文**：
  - 林工（t_copy，13:00，ledger-build 会话）说「catalog 那个导出做法能用，我把它抄进 ledger。」
  - 周工（t_wait，13:20，ledger-follow 会话）说「先别抄，我跟林工确认过了。等 dry-run 报告出来再看要不要搬。」
- **gold**：t_wait 应该是 `conflict_append:dec_copy`，也就是同一条 decision「ledger 的月报导出复用 catalog 的 export 做法」上挂一项周工的不一致结论。
- **MemOS 实际**：两条决策分进了两个 Topic，一个叫「catalog 导出做法移植 ledger」，一个叫「ledger 导出拷贝暂缓」。周工的结论成了一条独立的 decision，dec_copy 上 conflicts 为 0。
- **证据**：
  - 两个 Episode 在 assign 阶段都是 stage，一起进了 q01 前的 Formation。
  - Formation 输入里两者的 links 只有 `similar_summary`，没有 shared_anchor，因为 export.ts 没出现在 t_wait 里。
  - 模型给出的 deliverable 几乎一样（「ledger 的 export 拷贝…」和「ledger 的 export 实现…」），但 name 是按**结论**起的（「暂缓」和「移植」），于是拆成了两个 cluster。
  - prompt 里虽然有「对同一事项给出不同结论仍是同一工作，冲突交给后续的决策合并处理」，但没起作用。
- **根因**：Formation 在聚类时会按结论命名、按结论分组。同一批 staged Episode 里出现两个相反的立场时，没有任何机制把它们放进同一个 Topic，后面的 merge 也就无从发现冲突。另外两个 Episode 来自不同会话，「同一会话」这条线索也没有。
- **阶段**：Formation（`add_algorithm._form` / `_FORMATION`）。冲突识别依赖 merge（`add_merge.prepare_merge`），但两条决策根本没进同一个 Topic。
- **修改意见**：
  1. Formation 的 cluster name 和 deliverable 只允许写对象，禁止写结论（「暂缓」「移植」「采用」之类）；输出前做一次自检：deliverable 相同的 cluster 必须合并。
  2. Formation 之后、merge 之前，对每个新 Topic 的 decision 和同 Space 其他 Topic 的 decision 做一次「是否针对同一事项」的判断（可以是 yes/no 判定题，和 boundary 的做法一样），是就并到同一 Topic，交给 merge 处理冲突。
  3. 这一类直接对应 conflict 题（历史正确率只有 0.2–0.4）和 `conflictAsEntry`（历史每次跑 6–10 条），是 conflict 问题的主要来源之一。

#### 案例 5：执行步骤被写成 decision，未来计划被写成 timeline（negative_write 和 unattributed，偏小）

- t_export 中，陈工说「导出价格表。目录没有就先建，再写文件。」MemOS 写了 decision「导出价格表时，若目录不存在就先创建目录，再写文件。」gold 把这一句标成 negative（`execution_step`）。extract prompt 里也写了「执行步骤…不是 decision」，但模型还是输出了。gold 的标注本身也有争议：成员原话可以理解成一条规则。
- t_wait 中，Agent 说「ledger 不建 output 目录，等 dry-run 报告。」MemOS 写成了 timeline。它其实是对**不做**某事的陈述，或者说一项计划，不是可验证的完成结果，gold 也没有对应的条目。
- **修改意见**：在抽取后的校验里加规则：timeline 必须包含「已/完成/改为/新增」之类的完成态，含「等」「先不」的不算。执行步骤和 decision 的界线，在 prompt 里补一个反例（「目录没有就先建」属于实现步骤）。优先级低于案例 3 和 4。

### 案例 6：t_export 中 Agent 交代的对外约定和完成进展都没记（missing，抽取口径和 gold 不一致）

- **暂停点**：event 19（q50，10-21 14:20）之后。q50 答对了。
- **原文**：陈工说「导出价格表。目录没有就先建，再写文件。」，Agent 回复「export.ts 会先创建 output 目录，再把价格表写成 prices.json。」
- **gold**：
  - `dec_export_format`「价格表导出写到 output 目录下的 prices.json。」，类别是对外约定，来源是 t_export 和 t_csv。
  - `tl_export`「价格表导出（export.ts）已完成。」
  - 「目录没有就先建」被标成 negative（执行步骤）。
- **MemOS 实际**：只抽出一条 decision「导出价格表时，若目录不存在就先创建目录，再写文件。」，也就是 gold 的 negative（见案例 5）。用 triage 复核，这条通过了校验，没有 draft 被丢。差别出在**模型抽什么**。
- **根因**：
  - **输出位置**：output/prices.json 只出现在 Agent 的回复里。extract prompt 规定 decision 必须是成员确定的做法，「Agent 自述绝非成员决策」，所以模型没把输出位置当 decision。gold 则认为：成员交办的产出物，Agent 交代的交付位置和格式就是团队的对外约定，后面 t_csv 会在这个基础上改格式。
  - **时态**：Agent 用的是「export.ts 会先…再写成…」，描述的是代码现在的行为，prompt 却把「会…」当成未来计划，不记 timeline。gold 按已完成处理。
  - 结果模型抽了 gold 不要的执行步骤，漏了 gold 要的约定和进展。
- **阶段**：抽取（`_EXTRACT` prompt 的口径）。
- **修改意见**：
  1. prompt 区分两种「会」：「X 会…」描述已交付代码行为的，算 timeline；「会先…」「将…」「准备…」是未来计划，不算。可以给出反例对。
  2. 成员交办产出物、Agent 交代交付物的路径、文件名或格式时，记为 decision，origin 用 `delegated` 或 `adopted`，表示它是交付约定；这类条目不需要成员原话授权，但要标明来源是 Agent。是否采纳这个口径要和产品确认，同时 gold 应该明确说明这条规则。
  3. 执行步骤（「目录没有就先建」）不算 decision，在 prompt 里加反例（同案例 5）。
- **评测侧**：这条 gold 依赖「Agent 交代的交付约定算 decision」的口径，README 的标注规则里没写清楚，需要补上。

### 案例 7：成员给记忆系统本身定规则，被当成项目决策写入（negative_write）

- **暂停点**：event 29（t_csv，10-21 16:22）之后。
- **原文**：
  - 林工（t_write_edit，14:45）说「只要改了文件就算冲突。」，Agent 回复「report.ts 和 README 都改过，我把两次修改都记成冲突。」
  - 周工（t_admin_claim，14:50）说「只有两边结论相反才算冲突。」
- **gold**：两条都是 `not-written`，dropped 为 `unrelated`。它们说的是「记忆里什么算冲突」，属于对记忆系统或 Agent 记录方式的元规则，不是项目工作的决定。
- **MemOS 实际**：建了 Topic「冲突判定规则」，林工的写成 decision，周工的作为它的 conflict 挂上去；另外还有一条 timeline「Agent 把两次修改都记为冲突」。冲突挂载的机制是对的，但内容本来就不该写。
- **对照**：同一会话里「做完把每一步都写在回复里」「每句话都拆成一段」这类回复格式要求都被正确跳过了（`skipped`）。extract prompt 只排除了「对 Agent 回复格式或表达方式的要求」，没有覆盖「对记忆系统怎么记录、怎么判冲突的要求」。
- **阶段**：抽取（`_EXTRACT` 的排除范围）。
- **修改意见**：在 decision 的排除项里加上「对记忆系统本身或 Agent 记录方式的规定（什么算冲突、记什么不记什么、谁说了算）」，并给出反例。这类内容如果产品上想保留，应该进 Space 的 instructions 或配置，不进 Topic。
- **顺带的观察**：
  1. 周工的「改动先放 feature 分支」作为 conflict 正确挂在林工的「直接在 main 上改」上，和 gold 的 `conflict_append:dec_branch` 一致。说明在同一 Topic 内，跨成员冲突是能处理好的；案例 4 的问题在于两条决策没进同一个 Topic。
  2. Topic「月报金额从journal正文提取」的当前 decision 变成了「README 里写明金额还在 journal 正文。」，原来的「月报暂不改 entries 的表结构…」被移进了 history，还多了一条 change timeline「林工将结论从…改为…」。t_report 里的「README 写明」是一项文档任务，不是对表结构决定的修订，merge 把它当成了 rewrite。这一点等后面 dec_amount 的 op 被核对时会单独暂停，届时再细看。
- **评测侧的噪声**：event 28 有一次 extract 调用返回空响应（83 ms），重试后成功，没有影响结果。

### 案例 8：dec_amount 的冲突链：复述被当成修订，导致后来的反对意见记成了新决策；q02 答错（核心 conflict 案例）

- **暂停点**：event 31（q02，10-21 17:00）之后。q02 问「ledger 月报的金额现在是从哪里取的？」
- **gold 答案**：没有定论。林工的结论是 entries 不改、金额在 journal 正文；周工的结论是加 amount 列。两项都要说出来。
- **MemOS 回答**：「月报金额现在从 entries 表新增的 amount 列读取…」，把周工的方案当成了定论。judge 判错。
- **整条链分四步**：
  1. **t_report（林工，11:30）**：原话是「月报按客户过滤，空客户补一个测试，README 里写明金额还在 journal 正文。」gold 只记 `dec_empty` 和 `tl_report`，前一句和 README 那句标为 `restatement`（复述）。MemOS 抽出了 3 条 decision，其中两条是复述。
  2. **merge（event 9，`decision_update`）**：新决策「README 里写明金额还在 journal 正文。」和林工自己的「月报暂不改 entries 的表结构，金额继续写在 journal 正文里…」被判为同一件事，`action: rewrite`，理由是「新决策只补充 README 说明…故更新」。说话人是负责人本人，所以代码的负责人守卫放行了。结果 dec_amount 的当前结论变成了一句文档任务，真正的表结构决定被移进 history，还生成了一条 change timeline「林工将结论从…改为…」。
  3. **t_column（周工，16:40）**：原话是「还是给 entries 加上 amount 列…」，和林工的原结论正好相反。merge 时已有决策里只剩「README 里写明…」，模型判为不是同一件事（「新的存储与汇总方案，与已有各条各管各的」），`action: add`。周工的结论成了一条独立的新 decision，没挂成 conflict。
     - 对照：同一次 merge 里，周工对空客户测试的修改模型给的是 `rewrite`，被 `decision.decide` 的负责人守卫改成了 conflict，最终挂对了（「不一致：空客户那条测试改为…（周工）」）。说明守卫有效，前提是先找到了同一件事。
  4. **展示和作答**：
     - metadata 重写后，Topic 的摘要和描述直接写成「月报金额改为从 entries 新增的 amount 列读取…」，把有争议的方案当成定论写进了摘要。
     - 上游 search 只返回每个 Topic 里命中的条目，周工那条 decision 没过阈值，reader 看不到。评测用的是英文 MiniLM-384 嵌入，中文语义召回偏弱；生产用 bge-m3，这一点要打折看。
     - reader 只能依据摘要作答，于是答错。
- **根因**，按影响排序：
  1. **merge 把复述或文档任务当成修订**。判断「同一件事」时，「包含或细化」这个标准太宽：「README 写明金额在正文」只是提到了同一对象，并没有改变结论，却被当成了改写。
  2. **抽取没有过滤复述**。成员顺带复述已有结论或布置文档任务，不应产出 decision；gold 标为 `restatement`。
  3. **冲突识别只看当前结论**。merge 给模型看的 items 里只有 current 和 conflicts，没有 history。一旦当前结论被错误改写，后来的反对意见就再也对不上了。
  4. **metadata 把冲突写成定论**。有 conflict 或不同成员结论相反时，摘要应该写「尚未定论」。不过这一步本身依赖第 3 点，因为周工的结论根本没被记成冲突。
- **阶段**：抽取（复述）→ merge（`decision_update` prompt 和 `decision.decide`）→ metadata → search（上游）。
- **修改意见**：
  1. 在 `decision_update` 的「同一件事」标准里，「包含进去或者细化」要加限定：新决策必须改变或补充原结论里的对象、取值或条件。只是在文档、README、注释里**写明**已有结论的，算执行任务，应该 `add` 成 timeline，或者直接丢弃，不能 rewrite。也可以在 rewrite 前加一道守卫：新内容不包含原结论的核心取值（如「entries 表结构」「journal 正文」），又和原结论没有相反关系时，不允许 rewrite。
  2. extract prompt 增加：复述已有结论、布置文档或说明任务（「README 里写明…」）不是 decision。
  3. merge 召回已有决策时，把最近的 history 一起给模型，或者至少用 history 的原文参与召回，避免错误改写之后失去锚点。
  4. metadata prompt：decision 有 conflicts 时，摘要必须写明「尚未定论，两种结论分别是…」，不能只写其中一种。
  5. （上游 search，只记录）Topic 内条目按阈值筛选，会让同一 Topic 里相互冲突的决策只返回一半。建议冲突决策成对返回，或者 decision 不按阈值截断。评测这边应考虑换成中文能力强的嵌入，至少和生产一致用 bge-m3。
- **核对器修正**（只改评测侧）：timeline 复述冲突文本不再报 `conflict_as_entry`；一条 gold timeline 被拆成多条记为 note；丢失层的判断改成看具体条目是否被检索返回。本例重新判的话，丢失层应该是 **add**，因为冲突根本没有存下来。

### 暂停 8：t_silent（10-21 18:02）为核对器误报（时间差），顺带记下一个真实问题

- **误报原因**：t_env（林工「数据库密码别写进仓库」，17:50）在 gold 里 18:02:01 才 commit，比这个事件晚 1 秒；MemOS 已经先 commit 了。核对器拿 gold 在当前时刻的状态比，所以 MemOS 的新当前结论被判成了冲突文本。修复：凡是和 gold 最终 current 匹配、只是 MemOS 先到的写入，一律记为 early，不暂停。
- **真实问题（记为案例 9 的预告，等 t_env 被核对时确认）**：林工把 dec_env 改写成「数据库密码不写进仓库，只保留在本机 .env 中」，和周工早先挂上的不一致结论（「说明和普通记录里都不放连接串，.env 留在本机」）立场已经一致了。gold 的处理（`mergeConflict: 0`）是把周工那项并进当前结论，user_ids 变成林工和周工，conflicts 清空。MemOS 的 rewrite 保留了周工那条 conflict（status 2），于是出现「两人其实同意，界面上却还显示不一致」的状态，冲突类问题会被误导成「尚未定论」。

### 案例 9：负责人改到和对方一致的立场后，对方那项不一致结论没有并掉（conflict_state）

- **暂停点**：event 37（t_tell，10-21 18:17）之后。核对 t_env。
- **过程**：
  1. 林工（t_write_secret，14:25）说「把连接串写进 README，别人好查。」
  2. 周工（t_admin_env，14:40）说「.env 不能出现在说明里。」，作为 c1 挂上；这一步 MemOS 做对了。
  3. 林工（t_env，17:50）说「数据库密码别写进仓库。」，Agent 回复「README 里的连接串已经删掉了。密码只留在本机的 .env…」
- **gold**：`rewrite:dec_env`，并且 `mergeConflict: 0`。当前结论变成「数据库密码只留在本机 .env，不写进仓库，README 里也不放连接串。」，user_ids 为林工和周工，conflicts 清空，原结论进 history，另有 `tl_env_change` 记录这次改动。
- **MemOS 实际**：当前结论换成了林工的新说法，原结论进了 history，change timeline 也生成了，这几步都对。但周工的 c1「说明和普通记录里都不放连接串，.env 留在本机。」**还挂着**，user_ids 只有林工。界面上显示「林工：密码只留本机 .env ｜不一致：周工：.env 留在本机…」，两人明明已经一致，却还显示有分歧。
- **证据**：event 36 的 `decision_update`，模型给出 `same_as: null`、`action: rewrite`，理由是「新结论与现有各项均不同」。
  - prompt 对 same_as 的要求是「照着做出来的结果完全一样才算相同；对象、取值、范围…有一处不同就算不同」。林工的新结论讲的是「密码、仓库」，周工的讲的是「说明、.env」，范围不完全一样，所以 same_as 为 null。
  - `decision.apply` 里只有 `plan.merge_with` 有值时才会把 conflict 项并进当前结论。`merge_with` 只在「负责人 join 到某一项」时才会被设置，而 join 又依赖 same_as 严格相同。
- **根因**：判断「立场一致」和判断「同一结论」用的是同一个严格标准。负责人改口后，和对方的立场在取向上一致，只是措辞或范围有差别，这种情况走不进 merge 分支。
- **阶段**：merge（`decision_update` prompt 和 `decision.decide` / `apply`）。
- **修改意见**：
  1. 负责人 rewrite、而且这条决策有 conflict 项时，追加一道判定题（yes/no，和 boundary 的问法一致）：「新的当前结论是否采纳了 c_i 的立场，即两者同时照做不矛盾，且新结论覆盖了 c_i 的要求？」答 yes 就设 `merge_with = c_i`：合并 user_ids，清掉这一项，内容用负责人的新说法。
  2. 或者放宽 same_as 的语义：在 rewrite 分支里，same_as 可以是「新结论包含该项要求」，join 分支仍然要求严格相同。
  3. 这一类会让 conflict 题和 stale 题误报「尚未定论」，影响 `conflictSummary` 和 answers。

### 暂停 10：q04（10-21 19:20）答错，主要是案例 3、4 的后果，另有一个新问题（案例 10）

**同源部分（记录，不另立案例）**

- **t_bug（周工，17:40）**：周工改的是**自己那项**不一致结论（gold `conflict_update:dec_empty`），新说法是「只跳过金额列为空的行，空客户但金额还在的保留」，并且要求修 report.ts。MemOS 的 Formation 把 t_admin_bug 和 t_bug 聚成了一个新 Topic「report.ts 空客户读取修复」，见案例 3。结果 dec_empty 上周工的 c1 还停在旧说法「金额列为空时不进月报」，`tl_empty_change`（周工改了自己的结论）也没有生成，因为根本没走到 conflict_update。
- **t_dryrun（周工，19:10）**：「dry-run 报告出来了，export 在月报里用不上。」gold 是 `conflict_update:dec_copy`。MemOS 把它写进了案例 4 里那个错误的「ledger 导出拷贝暂缓」Topic，成了一条独立 decision。和案例 4 同源。
- **q04 的回答**：「两种不一致结论：林工…；周工则认为『空客户那条测试改为：金额列为空时不进月报』；进展显示测试已按后一种改法修改。」judge 认为没说出「空客户但金额还在的会留下」。这条信息其实在排第一的 Topic「report.ts 空客户读取修复」的 timeline 里，reader 没有用上。归因：主要是 add（冲突项没更新，信息分散在两个 Topic），其次是 reader 没有综合两个 Topic。judge 的判法偏严，但合理。
- **kind_mismatch（note）**：gold 的 `exp_fixture` 是一条 experience（「测试失败时先查读取代码再动样例…」），MemOS 写成了 decision「修复 report.ts 的读取逻辑…」，没有提炼出可复用的排查经验。

**案例 10：单条 Agent 进展的 Episode 被 Formation 拒绝，永远停在 staged（not_formed）**

- **原文**：t_sample（林工，17:05）说「月报测试出现问题了，我看样例文件是不是过期了。」，Agent 回复「我改了 tests/fixtures/month.json，把样例里的金额填上了。report.ts 没动。」
- **gold**：`add:tl_sample`，放在 `tp_ledger_report`。
- **MemOS 实际**：Episode `f0c92466` 只抽出一条 timeline。assign 阶段返回 `NO_CONFIRMED_TOPIC`，于是进了 staged；q04 前 flush 时，Formation 把它单独成一个 cluster，又被 `_has_evidence` 判为 `insufficient_evidence` 拒绝（规则是只有一条 delegated timeline、没有成员 decision 的，不能自成 Topic）。`staged_remaining: 1`，这条进展一直不可见。
- **根因**：「不够自成 Topic」的 Episode 没有归宿。它本来应该挂到已有的「月报」Topic 下，但 assign 阶段因为案例 3 的规则粒度没有匹配上；Formation 拒绝之后也不会回退去挂靠最相关的 Topic。
- **修改意见**：
  1. 被 Formation 以 `insufficient_evidence` 拒绝的 Episode，回退到 assign：放宽 same_deliverable 的条件，或者用 anchor 或文件路径（`tests/fixtures/month.json` 对应 report 测试）挂靠最相关的 Topic。
  2. 或者设一个 staged 的最长停留时间（如经过 N 次 Formation 仍未成形），到期后挂靠召回分最高的 Topic，或者明确丢弃并记 warning，不要无限期悬挂。
  3. 根本解法同案例 3：Topic 按工作或产出物粒度建，这类附属进展自然就能归进去。

### 暂停 11：q06（10-21 19:31）答错，加上 t_csv 停在 staged

#### 案例 11：reader 看到了相关决策，却答「记忆中没有相关内容」（answer_wrong，reader 层，也有一部分在 add 层）

- **题目**：「价格列表里的金额怎么取整？」，gold 答案是「价格显示保留两位小数，输出前按两位小数取整。」
- **reader 的输入**：Topic「价格显示两位小数」排在第 4 位，决策是「价格显示保留两位小数。（10/21，陈工）」，摘要和描述也是这一句。
- **回答**：「记忆中没有相关内容。」reader 用的是 deepseek-v4.1-flash-1017。
- **分析**：
  1. **add 层**：陈工的原话是「价格显示保留两位小数」，Agent 的回复是「listAmounts 输出前按两位小数取整」。gold 把两句合成了一条 decision。MemOS 只保留了成员原话（同案例 1，Agent 的规范写法不进 content），可选的 timeline「listAmounts 已改为输出前按两位小数取整」也没写。于是记忆里没有「取整」这个词。
  2. **reader 层**：问题问「取整」，记忆说「保留两位小数」，语义上是同一件事，但 reader 判成了不相关。reader 模板最后一句是「以上为…已确定的内容，与本轮问题相关时采用」，对措辞不同的内容，模型倾向于拒答。
- **修改意见**：
  1. 同案例 1：允许用同一轮 Agent 回复里的规范写法和实现细节补全 decision 的 content（「输出前按两位小数取整」）。
  2. reader 模板：改为「先判断各条记忆是否回答了问题的意图，措辞不同也算相关」；只有所有 Topic 都不相关时才答没有。或者在 reader 前加一步「按问题意图挑出相关条目」。reader 属于评测和产品的共同环节，结论要注明这一条不完全是 Add 的问题。

#### t_csv 停在 staged（not_formed，案例 10 的另一种拒绝原因）

- **原文**：陈工（16:20）说「导出别写 json 了，改成 csv。」，Agent 回复「export.ts 现在写 prices.csv，不再用 json。」gold 是 `rewrite:dec_export_format`，外加 tl_csv 和 tl_csv_change。
- **MemOS**：抽取正确，得到 decision「导出格式改为 csv，不再写 json。」和一条 timeline。assign 阶段返回 `NO_CONFIRMED_TOPIC`，因为已有的「导出价格表到 prices.json」Topic 的 deliverable 是「目录处理与写文件顺序」，见案例 3 和案例 6。之后 Formation 标了 `affects_existing_decisions: true`，被 `not_independent` 拒绝，`staged_remaining: 1`。
- **根因**：同案例 10。Formation 拒绝以后没有回退路径；而且这次 Formation 自己已经判断出它「影响已有决策」，也就是应该挂到已有 Topic，系统却没有据此去挂。
- **修改意见**：Formation 返回 `affects_existing_decisions: true` 或 `not_independent` 时，应该直接要求模型或召回给出目标 Topic，再走 merge（这里会是对导出格式的 rewrite），而不是留在 staged。

### 暂停 12：q07（10-21 19:32）答错，是 t_csv 停在 staged 的直接后果（同案例 10）

- 问题：「catalog 导出的价格表现在是什么格式？」，gold 是「导出为 csv，写成 prices.csv，不再写 prices.json。」
- reader 只看到「导出价格表到 prices.json」，所以答成了 json。核对器判丢失层为 add：`dec_export_format` 的当前版本根本没有写入。
- 根因就是上一个暂停记的 t_csv：Episode `58da9ea8` 被 Formation 以 `not_independent` 拒绝后留在 staged，rewrite 没有执行。不另立案例。

### 模型切换记录

- 从 event 43（q09，10-21 19:34）开始，deepseek-v4.1-flash 触发 TPM 限流（429），按约定，reader 自动切换到 openai 配置的 `gpt-6-luna`。SUT（MemOS 服务）仍是 deepseek，judge 仍是 gpt-6-luna。切换记在 `models.json.switches` 和 `live-run.json.readerSwitches` 里，每题的 `readerModel` 字段标出作答的模型。之后统计 answer 指标时，要把 event 43 前后两段分开看。

### 暂停 13：q09（10-21 19:34）答错，同案例 4

- 问题：「账本月报之前试过接入导出功能，后来怎么处理的，还会恢复吗？」gold 的回答是「尚无定论：林工要抄进 ledger；周工先撤回、等 dry-run，报告出来后的结论是不搬」。
- 回答只说了周工的结论（reader 是 gpt-6-luna），漏了林工的。
- 原因：林工和周工的结论分别落在「catalog 导出做法移植 ledger」和「ledger 导出拷贝暂缓」两个 Topic 里，dec_copy 上没有 conflict（`dec_copy/conflicts stored=0`）。reader 看不到「这两条是同一件事的不一致结论」这个关系。丢失层是 add，根因同案例 4。

### 暂停 14：q13（10-21 19:39）答错，是案例 9 的直接后果

- 问题：「数据库连接串能写进说明或普通记录吗？」gold 的回答是「不能」，两人立场已经一致。
- 回答（gpt-6-luna）：「…两项相关结论尚未确定以哪项为准…」。原因是 dec_env 上周工那项 c1 没有被并掉（案例 9），reader 按模板规则「带有不一致结论的决策尚未确定」作答。
- 丢失层：核对器判为 reader，因为条目都在、也都检索到了。实际根因在 add 层的 merge：立场一致后冲突没有并掉。reader 的做法符合模板，不算 reader 的错。
- 这一题很好地说明了案例 9 的影响：本来是确定的规则，被呈现成了有争议。

### 暂停 15：q15（10-21 19:41）答错，判得过严加上信息分散（不另立案例）

- 问题：「月报测试失败是因为样例文件旧了吗？」gold 要三点：不是样例旧、是 report.ts 读取问题、样例改动已撤回。
- 回答（gpt-6-luna）说对了前两点，还多说了读取已修复，但没说「month.json 的改动已撤回」。judge 判错。
- 「month.json 已撤回」这条 timeline 确实存在，但和 `exp_fixture` 的决策一起落在错误的 Topic「report.ts 空客户读取修复」里（案例 3），没有和林工最初的「样例文件是不是过期了」放在一起。reader 综合多个 Topic 时漏掉了这一条。
- 归因：主要是案例 3 的 Topic 分散，其次是 reader 漏事实；judge 的口径也偏严（gold 答案的三点里，前两点已答对）。不立新案例。

### 暂停 16：q17（10-21 19:43）答错，同案例 3 和案例 8（不另立案例）

- 问题：「空客户的账为什么会被整行丢掉？」gold 要两点：原因是 report.ts 空客户名整行丢弃、问题已修好，**并且**空客户怎么处理还有不一致结论。
- 回答（gpt-6-luna）把原因和修复说对了，没提「仍有不一致结论」。
- 原因：dec_empty 的当前结论（林工「没有客户名时这笔不进月报」）和周工改后的说法分在两个 Topic 里，周工那项 c1 也还停在旧措辞（见暂停 10）。reader 从结构上无法看出这里还有分歧。
- 根因同案例 3（Topic 粒度）和案例 8（冲突项没更新），不另立案例。

### 暂停 17：q25（10-21 19:53）答错，同案例 8

- 问题：「周工为什么建议直接读 entries 的 amount 列？当时定下来了吗？」gold 的回答是：原因是扫全文太慢；当时没定，和林工的结论还没裁决。
- 回答把原因说对了，但说「这个做法已于 10 月 21 日确定」。dec_amount 上没有 conflict（`stored=0`），周工的结论是一条独立 decision，Topic 摘要也把它写成了定论。根因同案例 8：复述被当成改写，周工的结论随后被 add 成新决策。

### 暂停 18：q26（10-21 19:54）答错，是案例 1 的直接后果

- 问题：「月报的月初月末按哪个时区切？」gold 的回答是 UTC+8（东八区）。
- 回答是「记忆中没有相关内容」，dec_tz 没有存下来（`stored=0`）。案例 1：带 UTC+8 的 decision 被证据校验整条丢掉了。案例 1 的影响在这里体现为答错一题。

### 暂停 19：q28（10-21 19:56）答错，是案例 2 的直接后果

- 问题：「月报结果写到哪里？」gold 的回答是 reports/ 目录、按月份命名、如 2026-10.txt。
- 回答「没有指定」，dec_report_path 没有存下来（案例 2：因为示例值 2026-10.txt 只出现在 Agent 回复里，整条被丢）。reader 还把「ledger 不建 output 目录」（案例 5 的那条计划型 timeline）拿来凑答，错误的写入进一步干扰了回答。

## 阶段总结（停在 event 57 / 148）

用户确认后续没有新的错误类别，review 在 10-21 19:57（q29 之后）停止。checkpoint `live-run.partial.json` 保留在 `in_progress` 状态，可以用 `step-run.zsh … --resume` 接着跑。

- **覆盖范围**：
  - 事件：148 个里跑了 57 个，第一天 ledger 和 catalog 两个 Space 的全部事件都已覆盖。
  - Add：113 次里核对了 33 次；跨 Space 的 13 个问题都还没跑到。
  - 问题：判了 23 题，答对 12 题（52%）。event 43 起 reader 从 deepseek 切到了 gpt-6-luna（TPM 限流）。切换前 deepseek 答了 10 题（对 6），切换后 gpt-6-luna 答了 13 题（对 6）。
- **暂停**：共 19 次。核对器误报 3 次（暂停 2、8，以及暂停 7 的一部分），都已修复，并且每次都补了回归测试。
- **问题类型计数**（`step-issues.jsonl`）：

  | 类型 | 次数 |
  |---|---|
  | answer_wrong | 11 |
  | missing | 8 |
  | topic_split | 8（涉及 gold 的 5 个 Topic 中的 4 个） |
  | conflict_state | 5 |
  | conflict_as_entry | 5 |
  | negative_write | 3 |
  | not_formed | 2 |
  | history_state | 1 |
  | unattributed | 1 |

- **Topic 粒度**：此刻 gold 有 5 个 Topic（ledger 3 个、catalog 2 个），MemOS 有 15 个（ledger 9 个、catalog 6 个）。没有出现合并。
- **11 个错题的归因**：

  | 根因 | 题目 |
  |---|---|
  | 案例 8 | q02、q25 |
  | 案例 3/4 | q04、q09、q15、q17 |
  | 案例 10 | q07 |
  | 案例 9 | q13 |
  | 案例 1 | q26 |
  | 案例 2 | q28 |
  | 案例 11（reader 和 add 各占一部分） | q06 |

  除 q06 以外，根因都在 Add 链路上，reader 和 search 只是放大了问题。

| # | 根因 | 阶段 | 影响 | 优先级 |
|---|---|---|---|---|
| 3 | Topic 按第一条规则命名和比对，一项工作被拆成一条规则一个 Topic | assign / Formation | topic_split；后续修订落进错误的 Topic；冲突分散 | P0 |
| 4 | Formation 按结论给 cluster 命名，跨成员的相反结论被拆成两个 Topic | Formation | conflict_as_entry；q09 | P0 |
| 8 | merge 把复述或文档任务（「README 写明…」）当成负责人改写，冲突锚点丢失 | 抽取 + decision_update | q02、q25；摘要把争议写成定论 | P0 |
| 1/2 | 同一轮 Agent 回复里的规范写法和示例值不算证据，整条 decision 被丢 | `_draft` 证据校验 | q26、q28；q06 的 add 部分 | P0 |
| 9 | 负责人改到和对方一致的立场后，对方的冲突项没并掉（same_as 判得过严） | decision_update / apply | q13；确定的规则被呈现成争议 | P1 |
| 10 | Formation 拒绝（insufficient_evidence / not_independent）后没有回退路径，Episode 永远停在 staged | Formation | q07；进展和改写丢失 | P1 |
| 6 | Agent 交代的交付约定，以及「X 会…」形式的已完成描述，口径和 gold 不一致 | 抽取 prompt | missing；需要和产品确认口径 | P2 |
| 7 | 成员给记忆系统本身定的规则（什么算冲突）被写成项目决策 | 抽取 prompt | negative_write | P2 |
| 5 | 执行步骤写成 decision，「等…」「不建…」这类计划写成 timeline | 抽取 prompt / 校验 | negative_write、unattributed | P3 |
| 11 | reader 遇到措辞不同（取整 vs 保留两位小数）就拒答 | reader 模板 | q06 | P2（评测和产品共有的环节） |

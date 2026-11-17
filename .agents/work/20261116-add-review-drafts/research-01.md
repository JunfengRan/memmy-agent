---
item: 20261116-add-review-drafts
seq: 01
role: designer
app: Claude Code
model: Fable 5.2
date: 2026-11-16
answers: 用户要求（11/16）：写三份项目记忆评审设计稿
---

# 交付记录 01：Add 评审设计稿三份

沿用 `20261116-jev-possibilities` 的做法，用 `research-NN.md` 记录设计研究的交付。本文件不是裁决，不要求实现方执行。

## 结论

三份稿已写到 `design-docs/review/`，可供 11/17 评审。基线 commit `3360239a`，工作区除本工作项和 `metrics.md` 的追加外没有改动；`design-docs/` 与 `eval/project-memory/runs/` 不进 git。

| 稿件 | 文件 | 形态 |
| --- | --- | --- |
| Add 算法设计 | `design-docs/review/2026-11-16-Add算法设计-评审稿.md` | 评审模版 §0–§8 |
| Add 任务队列与调度 | `design-docs/review/2026-11-16-Add任务队列与调度-评审稿.md` | 评审模版 §0–§8，附实验说明 |
| 会话线程即主题 | `design-docs/review/2026-11-16-会话线程即主题-简化方案.md` | 讨论稿，短 |

## 主要判断

1. 研发计划的五项指标里，「事实丢失率 0」「原因臆造 0」可以用结构保证；「重复主题 ≤2% 且错误合并 ≤1%」在 12/18 前同时达到没有证据支持，建议错并作硬门槛、重复主题移到给人看的目录层并分阶段；「关键值保留 ≥98%、幻觉率 <5%」需要先改口径和扩评测集。
2. 两层主题：工作主题给 Agent（写入与检索只认这一层），主题目录给人（派生视图，不参与匹配）。
3. 变更锚点用规则提取，进召回，也进归类判断的证据，不强制归入。
4. 调度按 V4 两段式落地，不做通用依赖引擎；Jev 回退必须是阶段级的一次调用。
5. 会话线程即主题：不建议直接替换 V4，建议先做一周验证实验；「会话当前线程」先作为归类的一个候选线索。

## 实验与数据

| 记录 | 内容 | 位置 |
| --- | --- | --- |
| R-20261116-02 | Add 分阶段耗时、非模型开销、调度策略模拟 | `eval/project-memory/runs/20261116-add-stage-timing/` |
| R-20261116-03 | 关键值保留、无依据关键值、「后续」句、重复主题分布、锚点线索的规则基线 | `eval/project-memory/runs/20261116-add-quality-baseline/` |

两组实验都只读取已有回放或用打桩模型，没有调用付费模型。数字见 `docs/project-memory/metrics.md` 同名记录。

## 验证

| 检查 | 结果 |
| --- | --- |
| `node analyze-trace.mjs` | 通过，输出 `trace-stats.json` |
| `npx tsx …/stub-timing.mts lexical` 与 `vector`（在 `Memory/` 下） | 通过，各 3 档主题数、每档 3 种情形 × 200 次 |
| `node simulate.mjs` | 通过，输出 `simulation.json` |
| `node key-value-baseline.mjs`、`node anchor-and-plan-stats.mjs` | 通过 |
| `render-mermaid.mjs`（mermaid.js） | 7/7 渲染通过，图片已人工查看 |
| `design-docs/.tools/cursor-mermaid-check.mjs` | 未通过运行：`MODULE_NOT_FOUND`，脚本写死的 Cursor 内置 worker 路径在本机不存在。与稿件内容无关 |
| typecheck、vitest | 未运行。本次没有改动产品代码与测试 |

## 与规格的偏离

稿件本身不改变规格。以下是稿中提出、需要评审或 designer 裁决后才能回写 V4 的内容，尚未登记到 `open-questions.md`：

- 「事实丢失率」「重复主题」「关键值保留率」「幻觉率」的口径与分阶段门槛（稿一第 7 章）。关键值保留率在研发计划（≥98%）与 V4 §2.4（≥90%）之间不一致。
- 描述不再默认写「后续计划」，与 V4 §2.2.6 的写法要求不同。
- 草稿新增 `evidence`、`reason_quote`、`key_values`、`anchors` 四个字段；新增锚点表与主题目录表；`get/memory` 新增 `anchor` 参数。
- 合并段时长与吞吐的预算数字；Jev 的回退方式（稿二第 7 章）。
- 研发计划备注「基于 Super Agent 实现进行管理和调度」与 V4 §5.2 的关系。

## 已知局限

- 所有耗时来自一个模型、一次顺序回放；合批收益是外推值；Jev 的三档时延是假设值。
- 规则基线判定偏宽，是下限；评测集 v2.1 是合成数据，主题切换偏密，没有工具调用，4 个空间没有锚点。
- 稿三的改进版（里程碑卡片加默认延续）没有实验数据。

## 请评审重点看

1. 稿一 4.1：把「重复主题」移到目录层考核是否可接受。
2. 稿一 3.4.3、3.4.4：锚点只作证据、不强制归入，这个力度够不够。
3. 稿二 3.3 第 5、6 条：合并段里的写字是否后置；Jev 回退的粒度。
4. 稿二 2.3：合批对 M05 的新要求（批内按 `chat_time` 依次作用到快照）。
5. 稿三第 6 节：是否做验证实验。

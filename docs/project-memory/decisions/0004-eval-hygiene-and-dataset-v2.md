# ADR-0004：评测卫生与数据集 v2

- 日期：2026-11-03
- 状态：已采纳
- 规格出处：v3 §2.2.5–2.2.9、§3.2

## 背景

`eval/project-memory/gold-add-memory/` 的金标和脚本是为 alpha / 旧实现写的，审计发现：

- 金标与规格矛盾：多数 experience 是规格不写入的局部实现或执行步骤；kind 用 `evolution` 而不是 `timeline`；没有 `user_ids`、`history`、`conflicts`、domain、摘要描述期望；有臆造的原因；
- 冲突按成员级别裁决，而规格已删除成员权限；语料没有用户身份，无法区分改写与冲突；
- 部分题目依赖 alpha 概念（跨窗口转达、无项目窗口、projectRoot、todolist）；
- runner 依赖同步返回、trace id 回显和 `generate_answer`，这些都不在规格里，trace id 还会进入抽取提示词，向被测模型泄漏标签；
- Recall@k 按条目算，规格按 topic 计数；trap 把规格要求返回的 history 也算错；评委与被测同一个模型；
- 数据集有三份完全相同的副本，生成物提交进了 git。

## 决定

- 产品契约不加评测字段；runner 只调规格接口，回放后用 `get_memory` 读最终状态。
- 金标从语料按 v3 规则重推，记为数据集 v2；冲突改为按作者判定期望 op。
- 指标按规格计数单位：search 用 topic 级 Recall；trap 区分「作为当前内容出现」和「出现在 history / conflicts」。
- 评委必须显式配置、与被测模型不同家族、温度 0；缓存键包含提示词文本哈希。
- 数据集只保留一份；生成物写到 `eval/project-memory/runs/`。
- 同步到 `dev-project-memory-search-gold-baseline` 前先征得用户同意。

## 影响

v1 的历史分数与 v2 不可比，`metrics.md` 中 v1 的记录只作参照。

## 补记（2026-11-10）

「数据集只保留一份」指评分只读 `dataset/`。大版本替换时，上一版整份冻在 `eval/project-memory/gold-add-memory/history/<版本>/`。v2 冻在 `history/v2/`。小改动不另存副本。

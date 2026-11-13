/**
 * M04 topic assignment. Candidates are summary + description only.
 * Names are not evidence (v3 §2.2.7). Summary rewrite is not this call (ADR-0007).
 */
export const ASSIGN_PROMPT_VERSION = "pm-assign-v0.2.0";

export const ASSIGN_SYSTEM_PROMPT = `提示词版本：${ASSIGN_PROMPT_VERSION}

你是团队项目记忆的归类器。输入是已经抽好的草稿、现状线索，以及召回得到的候选主题。每条草稿单独归类。只输出 JSON。

## 你能用的依据
候选只包含 topic_id、domain、topic_summary、topic_description。没有主题名称，也没有条目。名称或关键词相同不构成依据。拿草稿所推进的工作，和摘要、描述比对。

同一项工作：下面两条同时成立才是另一项工作，应新建或改归别处；任一不成立就是同一项工作，归入该主题。
- independent_delivery：这件事可以独立完成并交付。
- affects_existing_decisions：它的结论变化会影响该主题已经作出的决策。归入时这条为 true 或 false 都要按你的判断填写；归入表示「不是另一项工作」，所以两条不能同时是「可以独立交付」且「不影响已有决策」。

多个主题都能归入时，选工作范围最小的那个。degraded 非空表示召回降级（例如 vector），候选可能不全；仍只根据眼前的摘要和描述判断，不要因为降级就一律新建。

## 怎么填 target
- 归入候选：{"topic_id":"<候选里的 id>"}。topic_id 必须来自 candidates。不在候选里的 id 不要用，也不要把它改写成新主题。
- 候选里没有可归入的主题，且内容明确是一项新工作：{"new_topic":"<ref>"}，并在 new_topics 里给出这个 ref。topic_name 是名词短语，不超过 20 字，不含进展、版本和日期。topic_summary 不超过 80 字，一句话写做什么、为什么做，不写进展。topic_description 不超过 400 字，写怎么做、进展和后续计划。
- 看不出在说哪项工作：{"defer":true}。不要硬建新主题。

basis 两条都要给布尔值。compared_with 固定写 "summary+description"。

不要在这一步改写摘要或描述，不要判断两条决策是不是同一个问题。

## 输出格式
{
  "assignments": [
    {
      "draft_id": "d0",
      "target": {"topic_id": "topic_a"},
      "basis": {"compared_with": "summary+description", "independent_delivery": false, "affects_existing_decisions": true}
    }
  ],
  "new_topics": [{"ref": "n1", "topic_name": "...", "topic_summary": "...", "topic_description": "..."}],
  "deferred": [{"text": "...", "reason": "work_unresolved"}]
}

## 示例
草稿 d0：「推送失败后按指数退避重试 3 次」。
候选 topic_a 的 topic_summary：「推送失败后的重试策略」，topic_description：「失败后按指数退避重试，间隔逐步拉长。」
输出：
{"assignments":[{"draft_id":"d0","target":{"topic_id":"topic_a"},"basis":{"compared_with":"summary+description","independent_delivery":false,"affects_existing_decisions":true}}],"new_topics":[],"deferred":[]}`;

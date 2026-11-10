/**
 * Fixed injection copy (v3 §3.3). Wording is ours; the required behaviors match
 * the guide, the index lead-in, and the turn closing line.
 * Bump PROJECT_MEMORY_INJECT_PROMPT_VERSION when this copy changes.
 */
export const PROJECT_MEMORY_INJECT_PROMPT_VERSION = "pm-inject-v0.1.0";

/** `{space_name}` and `{source_hint}` are filled by the renderer. */
export const PROJECT_MEMORY_GUIDE_BODY = `当前任务属于项目「{space_name}」。成员共用一份按主题记下的项目记忆，内容是现状、已经确定的决策、可复用的经验和产出进展。

1. 会话开始附有 <project_index>，列出正在推进的主题。用户每次提问后，系统在 <memories> 里补上和本轮问题相关的主题。
2. <memories> 里的决策是成员已经确定的结论。按它做，不要向用户复述，也不要再问已经确定的事。
3. 标有「不一致」的决策还没有定论。本轮问题涉及它时，逐项列出各项结论和提出的成员，请用户确认以哪项为准；不涉及就不要提。
4. 用户本轮的结论和已有决策不同时，按用户的要求做，并说明它和哪条已有决策、哪位成员的结论不同。
5. 本轮 <memories> 没有覆盖、但又需要项目上下文时，调用 search_project_memory。每轮最多 2 次。
6. 项目记忆只记结论，不含讨论原文。{source_hint}`;

export const PROJECT_MEMORY_INDEX_LEAD = "当前会话所属空间里正在推进的主题如下。谈到具体内容时，当轮会再补上相关的决策和经验。";

export const PROJECT_MEMORY_TURN_CLOSING = "以上是指定空间和领域中已记下的内容，和本轮问题相关时采用。带有不一致结论的决策尚未确定：本轮问题涉及该决策时，列出各项结论及其成员，请用户确认以哪项为准；不涉及时不提及。";

export const PROJECT_MEMORY_DEGRADED_HINT = "本次检索有部分召回降级，结果可能不全；需要时换个说法再查一次。";

export const PROJECT_MEMORY_EMPTY_RESULT = "没有找到相关的项目记忆。";

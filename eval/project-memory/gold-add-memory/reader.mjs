// Renders search_memory's topic_detail_list with v3 §3.3.4 template three and asks a fixed reader
// model to answer from it. The system under test never writes the answer itself.
export const READER_PROMPT_VERSION = 2;

const READER_SYSTEM = `你是一个编码 Agent，正在回答项目成员的问题。只能使用本轮提供的 <memories> 内容，不能使用常识补充项目细节。
- 用一到三句中文直接回答当前状态。
- 问题问某项测试、规则或做法现在怎么写，而决策里已经写出这条规则时，用决策回答。不要因为记忆里没有贴出代码就说没有相关内容。
- 记忆里某项决策带有不一致结论且与问题相关时，列出各项结论及其成员，说明尚未确定。
- 记忆里没有能回答问题的内容时，只回答「记忆中没有相关内容」。`;

const day = (iso) => String(iso ?? "").slice(5, 10).replace("-", "/");
const minute = (iso) => String(iso ?? "").slice(0, 16).replace("T", " ");

function members(userIds, memberNames) {
  return (userIds ?? []).map((id) => memberNames[id] ?? id).join("、");
}

export function renderTemplate3({ topics, now, spaceNames = {}, memberNames = {} }) {
  if (!topics?.length) return `# System Context\n- 当前时间：${now}\n`;
  const lines = ["# System Context", `- 当前时间：${now}`, "", "# Memory Data", "<memories>", "  <projects>"];
  for (const topic of topics) {
    lines.push(`    -[${minute(topic.update_time)}] ${spaceNames[topic.space_id] ?? topic.space_id} · ${topic.topic_name ?? ""}`);
    lines.push(`      领域：${topic.domain ?? ""}`);
    lines.push(`      摘要：${topic.topic_summary ?? ""}`);
    if (topic.topic_description) lines.push(`      ${topic.topic_description}`);
    const decisions = topic.decisions ?? [];
    if (decisions.length) {
      lines.push("      相关决策：");
      for (const decision of decisions) {
        lines.push(`      - ${decision.content}（${day(decision.time)}，${members(decision.user_ids, memberNames)}）`);
        const conflicts = [...(decision.conflicts ?? [])].sort((a, b) => String(a.time).localeCompare(String(b.time)));
        for (const conflict of conflicts) lines.push(`        不一致：${conflict.content}（${day(conflict.time)}，${members(conflict.user_ids, memberNames)}）`);
        const history = [...(decision.history ?? [])].sort((a, b) => String(b.time).localeCompare(String(a.time)));
        for (const item of history.slice(0, 2)) lines.push(`        此前：${item.content}（${day(item.time)}${item.reason ? `；原因：${item.reason}` : ""}）`);
        if (history.length > 2) lines.push(`        另有 ${history.length - 2} 次更早的变更`);
      }
    }
    for (const [title, list] of [["相关经验", topic.experiences], ["相关进展", topic.timeline]]) {
      if (!list?.length) continue;
      lines.push(`      ${title}：`);
      for (const item of list) lines.push(`      - ${item.content}（${day(item.time)}，${members(item.user_ids, memberNames)}）`);
    }
  }
  lines.push("  </projects>", "</memories>");
  lines.push("以上为指定空间与领域中已确定的内容，与本轮问题相关时采用。带有不一致结论的决策尚未确定：本轮问题涉及该决策时，列出各项结论及其成员，请用户确认以哪项为准；不涉及时不提及。");
  return `${lines.join("\n")}\n`;
}

export function createReader(llm) {
  return {
    config: llm.config,
    async answer(question, rendered) {
      const text = await llm.complete(`reader-v${READER_PROMPT_VERSION}`, READER_SYSTEM, `${rendered}\n# 问题\n${question.question}`);
      return text.trim();
    }
  };
}

// Judge prompts. Exact text matches are settled by rule, so --oracle and --empty never call a model.
// Everything else goes to an explicitly configured judge (see llm.mjs), temperature 0, cached by
// model + prompt hash + payload.
import { parseJsonObject } from "./llm.mjs";

export const JUDGE_PROMPT_VERSION = 4;

const ATTRIBUTE_SYSTEM = `你是项目记忆写入评测的裁判。给定一个空间的标准条目（gold）、标准中不该写入的内容（negatives），以及系统写入的一条条目（candidate），判断 candidate 对应哪条标准。只看内容说的是不是同一件事，不看类型和措辞。
标签：
- "match"：candidate 与某条 gold.text（当前版本）说的是同一事实；改写、补充细节都算。candidate 同时覆盖多条 gold 时全部列出，最主要的放第一位。
- "stale"：candidate 说的是某条 gold 的 staleTexts（旧版、已被取代的版本）之一。
- "conflict"：candidate 说的是某条 gold 的 conflictTexts（尚未定论的另一项结论）之一，而不是它的当前版本。
- "negative"：candidate 说的是某条 negatives.text（标准认为不该写入的内容）。
- "none"：以上都不是。
只返回 JSON：{"label": "match|stale|conflict|negative|none", "ids": ["<gold 或 negative 的 id>"], "reason": "一句话"}`;

const ALIGN_SYSTEM = `你是项目记忆评测的裁判。给定两组短句 left 和 right，找出 left 中每一项在 right 里说同一事实的项（措辞可以不同，事实相反或不同不算）。每个 right 最多对应一个 left。
只返回 JSON：{"pairs": [[left 下标, right 下标或 null], ...]}`;

const REASON_SYSTEM = `你是项目记忆评测的裁判。v3 规定：变更原因只能取自会话，会话没说就留空，不能推断。给定会话原文和系统写下的原因，判断原因是否有会话依据（会话里说过这个原因，换说法可以）。
只返回 JSON：{"supported": true 或 false, "reason": "一句话"}`;

const KEYPOINT_SYSTEM = `你是项目记忆评测的裁判。给定一组要点和一段主题文字，判断每个要点在文字中是否被表达（换说法可以，事实不同不算）。
只返回 JSON：{"covered": [true 或 false, ...]}，顺序与要点一致。`;

const ANSWER_SYSTEM = `你是项目记忆评测的裁判。给定题目、标准答案、陷阱说法和被测回答，判断回答是否答对。
- 回答把标准答案的核心事实当作当前状态说出来就算对，措辞不同、多出不矛盾的细节都不扣分。
- 回答把陷阱说法（旧版本或别的项目的做法）当成当前答案，判错；提到旧版本但说明已被取代，判对。
- 标准答案说存在两项不一致结论时，回答必须把两项都列出来。
- 标准答案有明确结论而回答说"记忆中没有相关内容"、无法确定或答非所问，判错。
只返回 JSON：{"correct": true 或 false, "reason": "一句话"}`;

const norm = (text) => String(text ?? "").replace(/\s+/g, "").trim();

export function createJudge(llm) {
  const ask = async (kind, system, payload) => parseJsonObject(await llm.complete(`${kind}-v${JUDGE_PROMPT_VERSION}`, system, payload));

  // gold: [{id, kind, text, staleTexts, conflictTexts}], negatives: [{id, text}].
  async function attribute(candidate, gold, negatives) {
    const text = norm(candidate.content);
    if (!text) return { label: "none", ids: [], source: "rule" };
    const exact = gold.filter((g) => norm(g.text) === text).map((g) => g.id);
    if (exact.length) return { label: "match", ids: exact, source: "rule" };
    const stale = gold.find((g) => g.staleTexts.some((s) => norm(s) === text));
    if (stale) return { label: "stale", ids: [stale.id], source: "rule" };
    const conflict = gold.find((g) => g.conflictTexts.some((s) => norm(s) === text));
    if (conflict) return { label: "conflict", ids: [conflict.id], source: "rule" };
    const negative = negatives.find((n) => norm(n.text) === text);
    if (negative) return { label: "negative", ids: [negative.id], source: "rule" };
    if (!llm.config) return { label: "none", ids: [], source: "rule" };
    const output = await ask("attribute", ATTRIBUTE_SYSTEM, { gold, negatives, candidate: { kind: candidate.kind, text: candidate.content } });
    const known = new Set([...gold.map((g) => g.id), ...negatives.map((n) => n.id)]);
    const label = ["match", "stale", "conflict", "negative"].includes(output.label) ? output.label : "none";
    const ids = (Array.isArray(output.ids) ? output.ids : []).filter((id) => known.has(id));
    return label !== "none" && ids.length ? { label, ids, reason: String(output.reason ?? ""), source: "llm" } : { label: "none", ids: [], reason: String(output.reason ?? ""), source: "llm" };
  }

  // Returns, for each left index, the matched right index or null. One-to-one.
  async function align(left, right) {
    const result = left.map(() => null);
    const usedRight = new Set();
    left.forEach((item, i) => {
      const j = right.findIndex((other, k) => !usedRight.has(k) && norm(other) === norm(item));
      if (j >= 0) { result[i] = j; usedRight.add(j); }
    });
    const openLeft = result.map((value, i) => (value === null ? i : null)).filter((i) => i !== null);
    const openRight = right.map((_, k) => k).filter((k) => !usedRight.has(k));
    if (!openLeft.length || !openRight.length || !llm.config) return result;
    const output = await ask("align", ALIGN_SYSTEM, { left: openLeft.map((i) => left[i]), right: openRight.map((k) => right[k]) });
    for (const [a, b] of Array.isArray(output.pairs) ? output.pairs : []) {
      const i = openLeft[a];
      const k = openRight[b];
      if (i === undefined || k === undefined || result[i] !== null || usedRight.has(k)) continue;
      result[i] = k;
      usedRight.add(k);
    }
    return result;
  }

  async function reasonSupported(reason, conversationText, goldReason) {
    if (!norm(reason)) return { supported: true, source: "rule" };
    if (goldReason && norm(goldReason) === norm(reason)) return { supported: true, source: "rule" };
    if (norm(conversationText).includes(norm(reason))) return { supported: true, source: "rule" };
    if (!llm.config) return { supported: false, source: "rule" };
    const output = await ask("reason", REASON_SYSTEM, { conversation: conversationText, reason });
    return { supported: output.supported === true, reason: String(output.reason ?? ""), source: "llm" };
  }

  async function keyPoints(points, text) {
    const covered = points.map((point) => norm(text).includes(norm(point)));
    if (covered.every(Boolean) || !norm(text) || !llm.config) return covered;
    const output = await ask("keypoints", KEYPOINT_SYSTEM, { points, text });
    return points.map((_, i) => covered[i] || output.covered?.[i] === true);
  }

  async function answer(question, text, trapTexts) {
    const reply = String(text ?? "").trim();
    if (!reply) return { correct: false, reason: "empty answer", source: "rule" };
    if (norm(reply) === norm(question.goldAnswer)) return { correct: true, reason: "identical to gold answer", source: "rule" };
    if (!llm.config) return { correct: false, reason: "no judge configured", source: "rule" };
    const output = await ask("answer", ANSWER_SYSTEM, { question: question.question, askedAt: question.askedAt, goldAnswer: question.goldAnswer, trapTexts, answer: reply });
    return { correct: output.correct === true, reason: String(output.reason ?? ""), source: "llm" };
  }

  return { attribute, align, reasonSupported, keyPoints, answer };
}

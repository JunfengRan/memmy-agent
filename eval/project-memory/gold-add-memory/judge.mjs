import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const PROMPT_VERSION = 3;

const ANSWER_SYSTEM = `你是项目记忆评测的裁判。给定题目、提问时间、标准答案和旧说法示例，判断被测回答是否答对。按意思判断，不要求与标准答案或示例字面一致。
判定规则：
- 只看一件事：回答是否把标准答案的核心事实当作提问时的当前状态说了出来。措辞不同可以。
- 回答多出的细节（表名、文件名、实现细节等）只要不与标准答案矛盾，不扣分。
- 回答把旧说法示例（或同义说法、别的项目的说法）当成当前答案，判错。回答给出当前结论，同时说明旧说法已被取代，判对。
- 标准答案给出了明确结论，而回答说"无法确定""证据不足"或答非所问，判错。
- 标准答案说这个窗口拿不到项目记忆时，回答带出了项目细节就判错。
只返回 JSON：{"correct": true 或 false, "reason": "一句话理由"}`;

const ENTRY_SYSTEM = `你是项目记忆写入评测的裁判。给定同一项目的标准条目列表（gold）和一条模型写入的条目（candidate），逐条对照 gold 后给出标签：
- "match"：candidate 与某条 gold.text 说的是同一事实；改写、换说法、补充细节都算。candidate 同时覆盖多条 gold 时，选最主要的一条。
- "stale"：candidate 说的是某条 gold 的旧版或被压过的版本（与该 gold 的 staleTexts 之一同义），或与该 gold 的当前结论相反。
- "none"：与所有 gold 都不是同一事实。
不要考虑条目类型（kind）和 topic，只看内容。只返回 JSON：{"label": "match|stale|none", "gold": "<gold id，none 时为 null>", "reason": "一句话理由"}`;

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    task().then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (task) => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); next(); });
}

export function resolveJudgeConfig(env = process.env) {
  let model = env.MEMMY_EVAL_JUDGE_MODEL;
  let baseUrl = env.MEMMY_EVAL_JUDGE_BASE_URL;
  let apiKey = env.MEMMY_EVAL_JUDGE_API_KEY;
  const configPath = env.MEMMY_CONFIG_PATH ?? join(homedir(), ".memmy/config.yaml");
  if ((!model || !baseUrl || !apiKey) && existsSync(configPath)) {
    const config = YAML.parse(readFileSync(configPath, "utf8")) ?? {};
    const presetId = config.modelAssignments?.byok?.memorySummary ?? config.agents?.defaults?.modelPreset;
    const preset = config.modelPresets?.[presetId];
    const provider = config.providers?.[preset?.provider];
    const endpoint = provider?.endpoints?.[preset?.endpoint];
    if (preset?.provider === "anthropic") {
      model ??= preset.model;
      baseUrl ??= endpoint?.apiBase ?? "https://api.anthropic.com";
      apiKey ??= endpoint?.apiKey ?? provider?.apiKey;
    }
  }
  return model && baseUrl && apiKey ? { model, baseUrl: baseUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, ""), apiKey } : null;
}

export function createJudge({ cachePath, config = resolveJudgeConfig() }) {
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const used = new Set();
  const usage = { model: config?.model, calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, latencyMs: [] };
  const limit = createLimiter(Number(process.env.MEMMY_EVAL_JUDGE_CONCURRENCY ?? 6));
  const ask = (kind, system, payload) => limit(() => askOnce(kind, system, payload));

  async function askOnce(kind, system, payload) {
    const key = createHash("sha256").update(JSON.stringify({ v: PROMPT_VERSION, model: config?.model, kind, payload })).digest("hex");
    used.add(key);
    if (cache[key]) { usage.cacheHits += 1; return cache[key].output; }
    if (!config) throw new Error("judge credentials missing: set MEMMY_EVAL_JUDGE_MODEL / MEMMY_EVAL_JUDGE_BASE_URL / MEMMY_EVAL_JUDGE_API_KEY or configure an anthropic memorySummary preset");
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = performance.now();
      try {
        const response = await fetch(`${config.baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: config.model,
            max_tokens: 4096,
            thinking: { type: "disabled" },
            system,
            messages: [{ role: "user", content: JSON.stringify(payload) }]
          })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`judge ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
        usage.calls += 1;
        usage.latencyMs.push(performance.now() - startedAt);
        usage.inputTokens += body.usage?.input_tokens ?? 0;
        usage.outputTokens += body.usage?.output_tokens ?? 0;
        usage.cachedInputTokens += body.usage?.cache_read_input_tokens ?? 0;
        const text = (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
        const output = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
        cache[key] = { kind, output };
        return output;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async function judgeAnswer(question, answer) {
    const text = String(answer ?? "").trim();
    if (!text) return { correct: false, reason: "empty answer", source: "rule" };
    if (text === question.goldAnswer.trim()) return { correct: true, reason: "identical to gold answer", source: "rule" };
    const output = await ask("answer", ANSWER_SYSTEM, {
      question: question.question,
      askedAt: question.askedAt,
      goldAnswer: question.goldAnswer,
      staleClaimExamples: question.mustNotInclude,
      answer: text
    });
    return { correct: output.correct === true, reason: String(output.reason ?? ""), source: "llm" };
  }

  async function labelEntries(goldEntries, candidates) {
    const known = new Set(goldEntries.map((gold) => gold.id));
    const goldList = goldEntries.map(({ id, text, staleTexts }) => ({ id, text, staleTexts }));
    return Promise.all(candidates.map(async (candidate) => {
      const text = String(candidate.text ?? "").trim();
      const exact = goldEntries.find((gold) => gold.text.trim() === text);
      if (exact) return { label: "match", gold: exact.id, source: "rule" };
      const output = await ask("entry", ENTRY_SYSTEM, { gold: goldList, candidate: text });
      const label = output.label === "match" || output.label === "stale" ? output.label : "none";
      return label !== "none" && known.has(output.gold)
        ? { label, gold: output.gold, reason: String(output.reason ?? ""), source: "llm" }
        : { label: "none", gold: null, reason: String(output.reason ?? ""), source: "llm" };
    }));
  }

  // prune drops verdicts this run did not use, so a committed cache matches its committed report.
  function save({ prune = false } = {}) {
    const kept = prune ? Object.fromEntries(Object.entries(cache).filter(([key]) => used.has(key))) : cache;
    writeFileSync(cachePath, `${JSON.stringify(kept, null, 2)}\n`);
  }

  return { config, usage, judgeAnswer, labelEntries, save };
}

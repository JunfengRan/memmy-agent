// Model client shared by the judge and the reader. Configuration is explicit only: nothing is
// read from ~/.memmy or the server config, so the system under test cannot leak into scoring.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const sha256 = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

const FAMILIES = [
  ["anthropic", /claude|anthropic/],
  ["openai", /^(gpt|o\d|chatgpt|text-|openai)/],
  ["google", /gemini|gemma|palm/],
  ["xai", /grok/],
  ["qwen", /qwen|qwq|tongyi/],
  ["deepseek", /deepseek/],
  ["zhipu", /glm|zhipu/],
  ["moonshot", /kimi|moonshot/],
  ["meta", /llama/],
  ["mistral", /mistral|mixtral|codestral/],
  ["bytedance", /doubao|seed/],
  ["minimax", /minimax|abab/]
];

export function modelFamily(model) {
  const name = String(model ?? "").toLowerCase().split("/").pop();
  return FAMILIES.find(([, pattern]) => pattern.test(name))?.[0] ?? name.split(/[-_.:]/)[0];
}

// prefix is MEMMY_EVAL_JUDGE or MEMMY_EVAL_READER.
export function resolveModelConfig(prefix, env = process.env) {
  const provider = env[`${prefix}_PROVIDER`];
  const model = env[`${prefix}_MODEL`];
  const baseUrl = env[`${prefix}_BASE_URL`];
  const apiKey = env[`${prefix}_API_KEY`];
  if (!provider && !model && !baseUrl && !apiKey) return null;
  const missing = ["PROVIDER", "MODEL", "BASE_URL", "API_KEY"].filter((key) => !env[`${prefix}_${key}`]);
  if (missing.length) throw new Error(`${prefix}: set ${missing.map((key) => `${prefix}_${key}`).join(", ")}`);
  if (!["anthropic", "openai"].includes(provider)) throw new Error(`${prefix}_PROVIDER must be anthropic or openai (OpenAI-compatible chat completions)`);
  return { provider, model, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, family: modelFamily(model) };
}

// The judge must come from a different family than the model that wrote the memory.
export function assertJudgeFamily(judge, sutModel) {
  if (!judge) throw new Error("judge not configured: set MEMMY_EVAL_JUDGE_PROVIDER / _MODEL / _BASE_URL / _API_KEY");
  if (!sutModel) throw new Error("MEMMY_EVAL_SUT_MODEL is required so the judge family can be checked");
  if (judge.family === modelFamily(sutModel)) throw new Error(`judge ${judge.model} and system under test ${sutModel} are both ${judge.family}; use a different family`);
}

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

// Claude 5 models reject `temperature` (the API returns 400), so those calls rely on the model's
// default sampling; every other judge and reader runs at temperature 0.
function omitsTemperature(model) {
  return /^claude-[a-z]+-5/.test(String(model));
}

async function callOnce(config, system, user, maxTokens) {
  if (config.provider === "anthropic") {
    const response = await fetch(`${config.baseUrl.replace(/\/v1(\/messages)?$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: config.model, max_tokens: maxTokens, ...(omitsTemperature(config.model) ? {} : { temperature: 0 }), system, messages: [{ role: "user", content: user }] })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${config.model} ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return {
      text: (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join(""),
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      cachedInputTokens: body.usage?.cache_read_input_tokens ?? 0
    };
  }
  const response = await fetch(`${config.baseUrl.replace(/\/chat\/completions$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      ...(omitsTemperature(config.model) ? {} : { temperature: 0 }),
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${config.model} ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    // OpenAI prompt_tokens includes cache hits; inputTokens here excludes them, as Anthropic's does.
    inputTokens: (body.usage?.prompt_tokens ?? 0) - (body.usage?.prompt_tokens_details?.cached_tokens ?? 0),
    outputTokens: body.usage?.completion_tokens ?? 0,
    cachedInputTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0
  };
}

export function parseJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`model did not return JSON: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

// Cache key = model + provider + sha256(system prompt) + kind + payload, so any prompt edit misses.
export function createLlm({ config, cachePath, concurrency = 6, maxTokens = 2048 }) {
  const cache = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const used = new Set();
  // inputTokens excludes cache hits; perCall keeps each call's tokens so long-context pricing tiers apply per call.
  const usage = { model: config?.model ?? null, calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, perCall: [], latencyMs: [] };
  const limit = createLimiter(concurrency);

  async function complete(kind, system, payload) {
    const user = typeof payload === "string" ? payload : JSON.stringify(payload);
    const key = sha256({ provider: config?.provider, model: config?.model, promptHash: sha256(system), kind, user });
    used.add(key);
    if (cache[key]) { usage.cacheHits += 1; return cache[key].text; }
    if (!config) throw new Error(`model call "${kind}" needs configuration`);
    return limit(async () => {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const startedAt = performance.now();
        try {
          const result = await callOnce(config, system, user, maxTokens);
          usage.calls += 1;
          usage.latencyMs.push(performance.now() - startedAt);
          usage.inputTokens += result.inputTokens;
          usage.outputTokens += result.outputTokens;
          usage.cachedInputTokens += result.cachedInputTokens;
          usage.perCall.push({ inputTokens: result.inputTokens, cachedInputTokens: result.cachedInputTokens, outputTokens: result.outputTokens });
          cache[key] = { kind, model: config.model, promptHash: sha256(system), text: result.text };
          return result.text;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
        }
      }
      throw lastError;
    });
  }

  function save({ prune = false } = {}) {
    if (!cachePath) return;
    mkdirSync(dirname(cachePath), { recursive: true });
    const kept = prune ? Object.fromEntries(Object.entries(cache).filter(([key]) => used.has(key))) : cache;
    writeFileSync(cachePath, `${JSON.stringify(kept, null, 2)}\n`);
  }

  return { config, usage, complete, save, promptHash: sha256 };
}

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createMemoryLogger } from "../../../logging/logger.js";
import {
  buildAddTopicRequest,
  buildSearchTopicRequest,
  parseTopicChoice,
  type JevTopicRequest,
  type ParsedTopicChoice,
  type TopicBrief
} from "./topic-choice.js";

const log = createMemoryLogger("project-memory.decision");

const DEFAULT_MODEL = "gpt-6-luna";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export interface DecisionCredentials {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface DecisionTopicRouter {
  chooseAdd(input: { query: string; answer: string; topics: TopicBrief[] }): Promise<ParsedTopicChoice>;
  chooseSearch(input: { query: string; topics: TopicBrief[] }): Promise<ParsedTopicChoice>;
}

export class DecisionTopicError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "DecisionTopicError";
  }
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function openAIEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENAI_ENV_FILE || join(homedir(), ".openai.env");
}

/**
 * Same fields as ~/.claude.env and ~/.deepseek.env: MODEL, OPENAI_API_KEY,
 * OPENAI_API_BASE. gpt-6-luna is called with chat completions, the same path as
 * DeepSeek. This gateway returns 404 for POST /v1/decisions.
 * An explicit OPENAI_DECISION_* variable wins over the file. Process MODEL is
 * ignored so a sourced chat-model env cannot replace gpt-6-luna.
 */
export function resolveDecisionCredentials(
  env: NodeJS.ProcessEnv = process.env,
  fileText?: string | null
): DecisionCredentials | null {
  const fromFile = fileText === undefined ? readOpenAIEnvFile(env) : fileText ? parseEnvFile(fileText) : {};
  const apiKey = env.OPENAI_DECISION_API_KEY || fromFile.OPENAI_API_KEY || "";
  const baseUrl = (env.OPENAI_DECISION_BASE_URL || fromFile.OPENAI_API_BASE || fromFile.OPENAI_BASE_URL || "").replace(/\/$/, "");
  const model = env.OPENAI_DECISION_MODEL || fromFile.MODEL || DEFAULT_MODEL;
  if (!apiKey || !baseUrl) return null;
  return { apiKey, baseUrl, model };
}

function readOpenAIEnvFile(env: NodeJS.ProcessEnv): Record<string, string> {
  const path = openAIEnvPath(env);
  if (!existsSync(path)) return {};
  return parseEnvFile(readFileSync(path, "utf8"));
}

/** Default off. Vitest ignores the flag unless MEMMY_DECISION_TOPIC_IN_TEST=1. */
export function decisionTopicEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const inTest = env.VITEST === "true" && env.MEMMY_DECISION_TOPIC_IN_TEST !== "1";
  return !inTest && env.MEMMY_DECISION_TOPIC === "1";
}

export interface DecisionTopicClientOptions extends DecisionCredentials {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
}

export class DecisionTopicClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: DecisionTopicClientOptions) {
    if (!options.apiKey) throw new DecisionTopicError("OPENAI_API_KEY is required");
    if (!options.baseUrl) throw new DecisionTopicError("OPENAI_API_BASE is required");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async decide(request: JevTopicRequest): Promise<ParsedTopicChoice> {
    const allowed = Object.keys(request.questions.topic.criteria);
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        const payload = await this.post(request);
        return parseTopicChoice(payload, allowed);
      } catch (error) {
        lastError = error;
        const status = error instanceof DecisionTopicError ? error.status : null;
        const retry = status === null || RETRY_STATUS.has(status);
        if (!retry || attempt === this.maxRetries) break;
        await this.sleep(200 * 2 ** (attempt - 1));
      }
    }
    throw lastError instanceof Error ? lastError : new DecisionTopicError(String(lastError));
  }

  private endpoint(): string {
    const base = this.options.baseUrl.replace(/\/$/, "").replace(/\/chat\/completions$/, "");
    return `${base}/chat/completions`;
  }

  private async post(request: JevTopicRequest): Promise<unknown> {
    const question = request.questions.topic;
    const criteria = question.criteria;
    const keys = Object.keys(criteria);
    const options = keys.map((value) => `- ${value}: ${criteria[value]}`).join("\n");
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.options.model,
          max_completion_tokens: 800,
          messages: [
            { role: "system", content: question.instructions },
            { role: "user", content: `${request.state}\n\nOPTIONS:\n${options}` }
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "topic_choice",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  choice: { type: "string", enum: keys },
                  probabilities: {
                    type: "object",
                    additionalProperties: false,
                    properties: Object.fromEntries(keys.map((key) => [key, { type: "number" }])),
                    required: keys
                  }
                },
                required: ["choice", "probabilities"]
              }
            }
          }
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new DecisionTopicError(error instanceof Error ? error.message : String(error));
    }
    const text = await response.text();
    if (!response.ok) throw new DecisionTopicError(`HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
    try {
      return chatChoicePayload(JSON.parse(text) as unknown);
    } catch (error) {
      if (error instanceof DecisionTopicError) throw error;
      throw new DecisionTopicError("Decision response was not JSON", response.status);
    }
  }
}

function chatChoicePayload(payload: unknown): unknown {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const choice = Array.isArray(body?.choices) ? body.choices[0] as Record<string, unknown> | undefined : undefined;
  const message = choice?.message && typeof choice.message === "object" ? choice.message as Record<string, unknown> : null;
  const content = message?.content;
  if (typeof content !== "string") throw new DecisionTopicError("Decision response had no message content");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new DecisionTopicError("Decision message was not JSON");
  }
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  const selected = record?.choice;
  const probabilities = record?.probabilities;
  if (typeof selected !== "string" || !probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) {
    throw new DecisionTopicError("Decision message did not contain a choice");
  }
  const usage = body?.usage && typeof body.usage === "object" ? body.usage as Record<string, unknown> : {};
  return {
    model: typeof body?.model === "string" ? body.model : null,
    answers: [{
      name: "topic",
      type: "choice",
      choice: selected,
      confidence: typeof (probabilities as Record<string, unknown>)[selected] === "number" ? (probabilities as Record<string, number>)[selected] : 0,
      probabilities: Object.entries(probabilities as Record<string, unknown>).map(([value, probability]) => ({ value, probability }))
    }],
    usage: {
      input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0
    }
  };
}

/** Null when the experiment is off or ~/.openai.env has no key and base URL. */
export function createDecisionTopicRouter(
  env: NodeJS.ProcessEnv = process.env,
  fileText?: string | null
): DecisionTopicRouter | null {
  if (!decisionTopicEnabled(env)) return null;
  const credentials = resolveDecisionCredentials(env, fileText);
  if (!credentials) {
    log.warn("decision.skipped", { reason: "openai env missing OPENAI_API_KEY or OPENAI_API_BASE" });
    return null;
  }
  const client = new DecisionTopicClient(credentials);
  return {
    chooseAdd: (input) => client.decide(buildAddTopicRequest(input)),
    chooseSearch: (input) => client.decide(buildSearchTopicRequest(input))
  };
}

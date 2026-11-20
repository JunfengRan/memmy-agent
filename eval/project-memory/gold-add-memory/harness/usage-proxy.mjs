// Records the system-under-test's model usage without touching the product contract:
// point MEMMY_SUMMARY_ENDPOINT / MEMMY_EVOLUTION_ENDPOINT at this proxy, and every
// chat/completions call is forwarded upstream and its `usage` appended as one JSON line.
//   node harness/usage-proxy.mjs --upstream https://host/v1 --port 18970 --out <file.jsonl> [--trace <file.jsonl>]
// POST /__eval/context {phase, step, event, ...} tags later calls; each usage line carries the tag.
// --embed-upstream <base> sends /embeddings to a separate (for example local) service.
// --stages <file.json> names the step of a chat call: [{"stage", "operation", "marker"}], where
// marker is the start of the system prompt. Unmatched calls keep the version-string operation.
// The usage JSONL never contains prompts. The trace file records messages and the assistant text, never headers.
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { classifyOperation, tokenBuckets } from "../metrics.mjs";

const chatCall = (url) => /chat\/completions/.test(url ?? "");
const embeddingCall = (url) => /\/embeddings(?:\?|$)/.test(url ?? "");

// Keeps only scalar tag values so a tag can never carry prompts or nested payloads.
export function contextTag(body) {
  const tag = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (/^[A-Za-z_][\w]{0,40}$/.test(key) && (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.length <= 200) || value === null)) tag[key] = value;
  }
  return tag;
}

export function stageOf(requestJson, stages) {
  const system = (Array.isArray(requestJson?.messages) ? requestJson.messages : []).find((message) => message?.role === "system")?.content;
  if (typeof system !== "string") return null;
  return stages.find(({ marker }) => marker && system.trimStart().startsWith(marker)) ?? null;
}
const OPTION_KEYS = ["temperature", "max_tokens", "max_completion_tokens"];

export function buildTraceRecord(requestJson, responseText, context, meta = {}) {
  const request = requestJson && typeof requestJson === "object" ? requestJson : {};
  const requestOptions = {};
  for (const key of OPTION_KEYS) if (request[key] !== undefined) requestOptions[key] = request[key];
  let response;
  try {
    const body = JSON.parse(responseText);
    const content = body?.choices?.[0]?.message?.content;
    response = typeof content === "string"
      ? { content }
      : { content: content ?? null, parseError: true, responseText: String(responseText ?? "").slice(0, 4000) };
  } catch {
    response = { content: null, parseError: true, responseText: String(responseText ?? "").slice(0, 4000) };
  }
  return {
    ...meta,
    context: context ?? null,
    request: {
      model: request.model ?? null,
      messages: request.messages ?? null,
      ...(Object.keys(requestOptions).length ? { requestOptions } : {})
    },
    response
  };
}

function recordedUsage(raw) {
  const buckets = tokenBuckets(raw);
  if (!buckets) return { usage: raw ?? null };
  return {
    usage: raw ?? null,
    cacheReadTokens: buckets.cacheReadTokens,
    cacheWriteTokens: buckets.cacheWriteTokens,
    outputTokens: buckets.outputTokens,
    ...(buckets.cacheCreationTokens !== undefined ? { cacheCreationTokens: buckets.cacheCreationTokens } : {})
  };
}

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
let evalContext = null;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on("error", reject);
  });
}

if (process.argv[1]?.endsWith("usage-proxy.mjs")) {
  const upstream = (arg("upstream") ?? "").replace(/\/+$/, "");
  const port = Number(arg("port") ?? 18970);
  const out = arg("out");
  const tracePath = arg("trace");
  const embedUpstream = (arg("embed-upstream") ?? "").replace(/\/+$/, "");
  const stages = arg("stages") ? JSON.parse(readFileSync(arg("stages"), "utf8")) : [];
  if (!upstream || !out) { console.error("usage: --upstream <base> --port <n> --out <file> [--trace <file>]"); process.exit(2); }
  createServer(async (req, res) => {
    const rawBody = await readBody(req);
    if (req.method === "POST" && (req.url ?? "").split("?")[0] === "/__eval/context") {
      try {
        const body = JSON.parse(rawBody?.toString("utf8") || "{}");
        evalContext = contextTag(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
      }
      return;
    }
    const startedAt = Date.now();
    const headers = { ...req.headers };
    delete headers.host; delete headers["content-length"];
    let requestJson = null;
    if (chatCall(req.url) && rawBody) { try { requestJson = JSON.parse(rawBody.toString("utf8")); } catch { requestJson = null; } }
    const embedding = embeddingCall(req.url);
    if (embedding && rawBody) { try { requestJson = JSON.parse(rawBody.toString("utf8")); } catch { requestJson = null; } }
    const stage = chatCall(req.url) ? stageOf(requestJson, stages) : null;
    const operation = chatCall(req.url) ? stage?.operation ?? classifyOperation(requestJson) : undefined;
    const contextAtStart = evalContext;
    try {
      const target = embedding && embedUpstream ? embedUpstream : upstream;
      const response = await fetch(`${target}${req.url.replace(/^\/v1/, "")}`, { method: req.method, headers, body: rawBody });
      const text = await response.text();
      let usage = null; let model = null;
      try { const body = JSON.parse(text); usage = body.usage ?? null; model = body.model ?? null; } catch {}
      const inputs = embedding ? (Array.isArray(requestJson?.input) ? requestJson.input.length : requestJson?.input ? 1 : 0) : undefined;
      const meta = {
        at: new Date(startedAt).toISOString(), completedAt: new Date().toISOString(), path: req.url, status: response.status,
        latencyMs: Date.now() - startedAt, model, requestedModel: requestJson?.model ?? null,
        ...(operation ? { operation } : {}), ...(stage ? { stage: stage.stage } : {}),
        ...(embedding ? { kind: "embedding", inputs } : chatCall(req.url) ? { kind: "chat" } : {}),
        context: contextAtStart
      };
      appendFileSync(out, `${JSON.stringify({ ...meta, ...recordedUsage(usage) })}\n`);
      if (tracePath && chatCall(req.url)) {
        appendFileSync(tracePath, `${JSON.stringify({ ...buildTraceRecord(requestJson, text, contextAtStart, meta), ...recordedUsage(usage) })}\n`);
      }
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
      res.end(text);
    } catch (error) {
      appendFileSync(out, `${JSON.stringify({ at: new Date(startedAt).toISOString(), path: req.url, latencyMs: Date.now() - startedAt, ...(operation ? { operation } : {}), ...(stage ? { stage: stage.stage } : {}), context: contextAtStart, error: String(error) })}\n`);
      res.writeHead(502); res.end(JSON.stringify({ error: String(error) }));
    }
  }).listen(port, "127.0.0.1", () => console.log(`usage proxy on ${port} -> ${upstream}`));
}

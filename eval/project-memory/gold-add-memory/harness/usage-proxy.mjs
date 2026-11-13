// Records the system-under-test's model usage without touching the product contract:
// point MEMMY_SUMMARY_ENDPOINT / MEMMY_EVOLUTION_ENDPOINT at this proxy, and every
// chat/completions call is forwarded upstream and its `usage` appended as one JSON line.
//   node harness/usage-proxy.mjs --upstream https://host/v1 --port 18970 --out <file.jsonl> [--trace <file.jsonl>]
// POST /__eval/context {trace, task_id, phase, question_id} tags later chat calls in the trace file.
// The usage JSONL never contains prompts. The trace file records messages and the assistant text, never headers.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { classifyOperation, tokenBuckets } from "../metrics.mjs";

const chatCall = (url) => /chat\/completions/.test(url ?? "");
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
  if (!upstream || !out) { console.error("usage: --upstream <base> --port <n> --out <file> [--trace <file>]"); process.exit(2); }
  createServer(async (req, res) => {
    const rawBody = await readBody(req);
    if (req.method === "POST" && (req.url ?? "").split("?")[0] === "/__eval/context") {
      try {
        const body = JSON.parse(rawBody?.toString("utf8") || "{}");
        evalContext = {
          trace: body.trace ?? null,
          task_id: body.task_id ?? null,
          phase: body.phase ?? null,
          question_id: body.question_id ?? null
        };
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
    const operation = chatCall(req.url) ? classifyOperation(requestJson) : undefined;
    const contextAtStart = evalContext;
    try {
      const response = await fetch(`${upstream}${req.url.replace(/^\/v1/, "")}`, { method: req.method, headers, body: rawBody });
      const text = await response.text();
      let usage = null; let model = null;
      try { const body = JSON.parse(text); usage = body.usage ?? null; model = body.model ?? null; } catch {}
      const meta = { at: new Date(startedAt).toISOString(), path: req.url, status: response.status, latencyMs: Date.now() - startedAt, model, requestedModel: requestJson?.model ?? null, ...(operation ? { operation } : {}) };
      appendFileSync(out, `${JSON.stringify({ ...meta, ...recordedUsage(usage) })}\n`);
      if (tracePath && chatCall(req.url)) {
        appendFileSync(tracePath, `${JSON.stringify({ ...buildTraceRecord(requestJson, text, contextAtStart, meta), ...recordedUsage(usage) })}\n`);
      }
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
      res.end(text);
    } catch (error) {
      appendFileSync(out, `${JSON.stringify({ at: new Date(startedAt).toISOString(), path: req.url, ...(operation ? { operation } : {}), error: String(error) })}\n`);
      res.writeHead(502); res.end(JSON.stringify({ error: String(error) }));
    }
  }).listen(port, "127.0.0.1", () => console.log(`usage proxy on ${port} -> ${upstream}`));
}

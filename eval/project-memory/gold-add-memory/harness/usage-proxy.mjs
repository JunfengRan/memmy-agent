// Records the system-under-test's model usage without touching the product contract:
// point MEMMY_SUMMARY_ENDPOINT / MEMMY_EVOLUTION_ENDPOINT at this proxy, and every
// chat/completions call is forwarded upstream and its `usage` appended as one JSON line.
//   node harness/usage-proxy.mjs --upstream https://host/v1 --port 18970 --out <file.jsonl>
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const upstream = (arg("upstream") ?? "").replace(/\/+$/, "");
const port = Number(arg("port") ?? 18970);
const out = arg("out");
if (!upstream || !out) { console.error("usage: --upstream <base> --port <n> --out <file>"); process.exit(2); }

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const startedAt = Date.now();
  const headers = { ...req.headers };
  delete headers.host; delete headers["content-length"];
  try {
    const response = await fetch(`${upstream}${req.url.replace(/^\/v1/, "")}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const text = await response.text();
    let usage = null; let model = null;
    try { const body = JSON.parse(text); usage = body.usage ?? null; model = body.model ?? null; } catch {}
    appendFileSync(out, `${JSON.stringify({ at: new Date(startedAt).toISOString(), path: req.url, status: response.status, latencyMs: Date.now() - startedAt, model, usage })}\n`);
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
    res.end(text);
  } catch (error) {
    appendFileSync(out, `${JSON.stringify({ at: new Date(startedAt).toISOString(), path: req.url, error: String(error) })}\n`);
    res.writeHead(502); res.end(JSON.stringify({ error: String(error) }));
  }
}).listen(port, "127.0.0.1", () => console.log(`usage proxy on ${port} -> ${upstream}`));

// Searchable wiki layered on top of project memory.
//
// The retrieval shape follows TencentDB Agent Memory's wiki (MemoryKnowledge):
// raw sources stay intact, an LLM maintains interlinked markdown pages, and a
// query ranks those pages with BM25 (title weight 5, body weight 1) before the
// caller reads the hits. Hop 0 is the default; neighbors are returned as links,
// not pulled into the hit list. Wikis are separate per project, so one project's
// pages are never searched from another project.
//
// Two adaptations are deliberate. Source pages are the raw answer, not a model
// paraphrase, because TencentDB's index only covers wiki pages and a paraphrase
// would drop the original sentence. Maintained pages keep unrelated facts, but a
// sentence the new source contradicts is deleted instead of being reworded.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export const PROMPT_VERSION = "pm-wiki-1";

const STRUCTURAL = new Set(["index", "schema", "purpose"]);
const PAGE_DIRS = new Set(["sources", "entities", "concepts", "comparisons", "synthesis"]);
const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 5;
const BODY_WEIGHT = 1;
const DEFAULT_LIMIT = 20;
const DEFAULT_HOP = 0;
const DEFAULT_DECAY = 0.5;
const DEFAULT_MIN_SCORE = 0.1;
const RELATED_CAP = 10;

const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those"
]);

const PURPOSE = `这个 wiki 积累一个代码项目里的现行做法：模块、文件、口径，以及后来被改口替换的规则。
查询的人会按页阅读，而不是把全部历史对话一次放进上下文。`;

const SCHEMA = `# 页面类型
- entity：具体的文件、模块或角色
- concept：一条规则、口径或做法
- comparison：并列的几种做法
- synthesis：跨页面的现行结论
源页由系统按原文写入 wiki/sources/，不要自己输出。

# 正文
- entity / concept 写「定义」和「现行表述」。现行表述必须逐字引用目前仍成立的那句原文。
- 用 [[页面标题]] 互相引用，括号里只写标题。
- 与本次无关的已有事实保留。
- 新源如果否定了页面上的旧说法，把被否定的那句从 entity、concept、comparison、synthesis 里删掉。不要改写后留在页面上，也不要引用来说明它已经过时。`;

const SYSTEM_PROMPT = `你是 wiki 维护者。读一份源文档，更新已有的 markdown wiki：抽出实体和概念，合并到已有页，用交叉引用把相关页连起来。不要把源文档换种说法复述一遍。

## 用途
${PURPOSE}

## 抽取约定
${SCHEMA}

## 输出
只输出 FILE 块，块外不要解释。一种页面一块：

<<<FILE path="wiki/concepts/example.md">>>
---
type: concept
title: 示例
description: 一句话
---

定义

现行表述：逐字引用仍成立的原句。
<<<END>>>

目录只使用 entities、concepts、comparisons、synthesis。文件名用短横线连接的小写英文、数字或汉字。至少为一份有实质内容的源更新或新建一页。语言跟源文档一致。`;

export function tokenize(text) {
  const rawTokens = String(text ?? "")
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…\[\]【】{}《》<>]+/)
    .filter((token) => token.length > 0);
  const result = [];
  for (const token of rawTokens) {
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token);
    const hasLatin = /[a-z]/.test(token);
    if (hasCJK && hasLatin) {
      const parts = token.split(/(?<=[a-z0-9])(?=[\u4e00-\u9fff])|(?<=[\u4e00-\u9fff])(?=[a-z0-9])/);
      for (const part of parts) {
        if (/[\u4e00-\u9fff]/.test(part) && part.length > 1) pushCJK(result, part);
        else if (part.length > 0 && !STOP_WORDS.has(part)) result.push(part);
      }
    } else if (hasCJK && token.length > 1) {
      pushCJK(result, token);
    } else if (!STOP_WORDS.has(token) && token.length > 0) {
      result.push(token);
    }
  }
  return result;
}

function pushCJK(result, token) {
  const chars = [...token];
  for (let index = 0; index < chars.length - 1; index += 1) result.push(chars[index] + chars[index + 1]);
  result.push(token);
}

export function slugify(input) {
  const tokens = [];
  let buffer = "";
  let kind = "";
  const flush = () => {
    if (!buffer) return;
    tokens.push(kind === "latin" ? buffer.toLowerCase() : buffer);
    buffer = "";
    kind = "";
  };
  for (const char of String(input ?? "").trim()) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(char)) {
      if (kind !== "cjk") flush();
      kind = "cjk";
      buffer += char;
    } else if (/[a-zA-Z0-9]/.test(char)) {
      if (kind !== "latin") flush();
      kind = "latin";
      buffer += char;
    } else flush();
  }
  flush();
  return tokens.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function createSearchableWiki(rootDir) {
  function wikiPath(wikiId) {
    assertWikiId(wikiId);
    return join(rootDir, wikiId);
  }

  function prepare(wikiId) {
    const path = wikiPath(wikiId);
    const statePath = join(path, ".llm-wiki", "state.json");
    const state = readState(statePath);
    if (state.promptVersion !== PROMPT_VERSION) {
      rmSync(join(path, "wiki"), { recursive: true, force: true });
      rmSync(join(path, "raw"), { recursive: true, force: true });
      writeState(statePath, { promptVersion: PROMPT_VERSION, sources: {} });
    }
    mkdirSync(join(path, "raw", "sources"), { recursive: true });
    mkdirSync(join(path, "wiki", "entities"), { recursive: true });
    mkdirSync(join(path, "wiki", "concepts"), { recursive: true });
    mkdirSync(join(path, "wiki", "sources"), { recursive: true });
    mkdirSync(join(path, "wiki", "comparisons"), { recursive: true });
    mkdirSync(join(path, "wiki", "synthesis"), { recursive: true });
    mkdirSync(join(path, ".llm-wiki"), { recursive: true });
    writeIfMissing(join(path, "wiki", "purpose.md"), `---\ntype: purpose\ntitle: 用途\n---\n\n${PURPOSE}\n`);
    writeIfMissing(join(path, "wiki", "schema.md"), `---\ntype: schema\ntitle: 抽取约定\n---\n\n${SCHEMA}\n`);
    return path;
  }

  async function ingest({ wikiId, sourceName, sourceText, quote, complete }) {
    const path = prepare(wikiId);
    const filename = safeSourceName(sourceName);
    const statePath = join(path, ".llm-wiki", "state.json");
    const state = readState(statePath);
    const digest = sha256(`${PROMPT_VERSION}\n${sourceText}\n${quote ?? ""}`);
    if (state.sources[filename] === digest) {
      return { skipped: true, written: [], modelCalls: 0, pageCount: pageCount(wikiId) };
    }

    const existing = loadPages(join(path, "wiki")).filter((page) => !STRUCTURAL.has(page.type) && page.type !== "source");
    const user = buildUserPrompt(filename, sourceText, existing);
    let modelCalls = 0;
    let reply = await complete(SYSTEM_PROMPT, user);
    modelCalls += 1;
    let blocks = parsePages(reply);
    if (blocks.length === 0) {
      reply = await complete(SYSTEM_PROMPT, `${user}\n\n上一次没有解析出页面。请只输出 FILE 块；如果做不到，就只返回 JSON：{"pages":[{"path":"wiki/concepts/example.md","type":"concept","title":"示例","description":"一句话","body":"现行表述"}]}`);
      modelCalls += 1;
      blocks = parsePages(reply);
    }
    const written = [];
    for (const block of blocks) {
      const placed = placeBlock(block);
      if (!placed || placed.startsWith("wiki/sources/")) continue;
      const file = join(path, placed);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, normalizePage(block.content, placed), "utf8");
      written.push(placed);
    }
    const sourceRel = `wiki/sources/${filename}`;
    writeFileSync(join(path, sourceRel), sourcePage(filename, quote || sourceText), "utf8");
    written.push(sourceRel);
    writeFileSync(join(path, "raw", "sources", filename), sourceText, "utf8");
    rebuildIndex(path);
    state.sources[filename] = digest;
    state.promptVersion = PROMPT_VERSION;
    writeState(statePath, state);
    return { skipped: false, written, maintained: written.length - 1, modelCalls, pageCount: pageCount(wikiId) };
  }

  function search(wikiId, query, options = {}) {
    const path = wikiPath(wikiId);
    const wikiDir = join(path, "wiki");
    if (!existsSync(wikiDir)) return { results: [], links: [], count: 0 };
    const pages = loadPages(wikiDir).filter((page) => !STRUCTURAL.has(page.type));
    const limit = options.limit > 0 ? options.limit : DEFAULT_LIMIT;
    const hop = clamp(options.hop ?? DEFAULT_HOP, 0, 5);
    const decay = clamp(options.decay ?? DEFAULT_DECAY, 0, 1);
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    const ranked = rank(pages, query);
    const hits = hop === 0
      ? ranked.filter((hit) => hit.score >= minScore).slice(0, limit)
      : expand(ranked, pages, { hop, decay, minScore }).filter((hit) => hit.score >= minScore).slice(0, limit);
    const byId = new Map(pages.map((page) => [page.id, page]));
    const { outAdj, inAdj } = linkGraph(pages);
    const results = hits.map((hit) => {
      const page = byId.get(hit.id);
      return {
        path: page.relPath,
        title: page.title,
        type: page.type,
        snippet: snippetOf(page),
        score: hit.score,
        hop: hit.hop,
        ...(hit.via ? { via: hit.via } : {}),
        related: relatedOf(page.id, byId, outAdj, inAdj)
      };
    });
    return { results, links: resultLinks(results, byId, outAdj), count: results.length };
  }

  function read(wikiId, refs) {
    const wikiDir = join(wikiPath(wikiId), "wiki");
    const byPath = new Map(loadPages(wikiDir).map((page) => [page.relPath, page]));
    const items = [];
    for (const ref of refs ?? []) {
      const page = byPath.get(String(ref).replace(/\\/g, "/"));
      if (!page) {
        items.push({ path: ref, notFound: true });
        continue;
      }
      items.push({ path: page.relPath, title: page.title, type: page.type, body: bodyOf(page.content), content: page.content });
    }
    return items;
  }

  function pageCount(wikiId) {
    const wikiDir = join(wikiPath(wikiId), "wiki");
    if (!existsSync(wikiDir)) return 0;
    return loadPages(wikiDir).filter((page) => !STRUCTURAL.has(page.type)).length;
  }

  return { ingest, search, read, pageCount };
}

function assertWikiId(wikiId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(wikiId ?? ""))) throw new Error(`bad wiki id ${wikiId}`);
}

function safeSourceName(name) {
  const base = String(name ?? "").replace(/\\/g, "/").split("/").pop();
  if (!base || !/^[\w.-]+\.md$/.test(base)) throw new Error(`bad source name ${name}`);
  return base;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readState(path) {
  if (!existsSync(path)) return { promptVersion: PROMPT_VERSION, sources: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      promptVersion: parsed.promptVersion ?? "",
      sources: parsed.sources ?? {}
    };
  } catch {
    return { promptVersion: "", sources: {} };
  }
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function writeIfMissing(path, content) {
  if (!existsSync(path)) writeFileSync(path, content, "utf8");
}

function buildUserPrompt(sourceName, sourceText, maintainedPages) {
  const catalog = maintainedPages.length === 0
    ? "（还没有实体或概念页）"
    : maintainedPages.map((page) => `- [${page.type}] ${page.relPath} — ${page.title}${page.description ? `：${page.description}` : ""}`).join("\n");
  const ranked = [...maintainedPages].sort((left, right) => overlap(sourceText, right) - overlap(sourceText, left)).slice(0, 3);
  const updates = ranked.length === 0
    ? ""
    : `\n\n## 可能要合并的已有页\n保留页上与本次无关的事实。如果本源否定了其中某句，输出合并后的整页，并删掉被否定的原句。\n\n${ranked.map((page) => `### ${page.relPath}\n\`\`\`\n${clip(page.content, 1800)}\n\`\`\``).join("\n\n")}`;
  return `## 要纳入的源：${sourceName}\n\n## 已有实体和概念\n${catalog}${updates}\n\n## 源文档\n${sourceText}\n\n请输出 FILE 块。`;
}

function overlap(text, page) {
  const query = new Set(tokenize(text));
  let score = 0;
  for (const token of tokenize(`${page.title}\n${page.content}`)) if (query.has(token)) score += 1;
  return score;
}

function clip(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

function parsePages(reply) {
  const blocks = parseFileBlocks(reply);
  return blocks.length > 0 ? blocks : parseJsonPages(reply);
}

function parseFileBlocks(reply) {
  const blocks = [];
  const pattern = /<<<FILE\s+path=(?:"([^">\n]+)"?|'([^'>\n]+)'?|([^\s>]+))\s*>>>([\s\S]*?)(?=<<<END>>>|<<<FILE|$)/g;
  let match = pattern.exec(String(reply ?? ""));
  while (match) {
    const path = (match[1] || match[2] || match[3] || "").trim();
    const content = match[4].trim();
    if (path && content) blocks.push({ path, content });
    match = pattern.exec(String(reply ?? ""));
  }
  return blocks;
}

function parseJsonPages(reply) {
  const text = String(reply ?? "").trim().replace(/^```(?:json)?\s*|```$/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
    return pages.flatMap((page) => {
      const path = typeof page?.path === "string" ? page.path : "";
      const body = typeof page?.body === "string" ? page.body : "";
      if (!path || !body) return [];
      const type = typeof page.type === "string" && page.type ? page.type : "concept";
      const title = typeof page.title === "string" && page.title ? page.title : "未命名";
      const description = typeof page.description === "string" ? page.description : "";
      return [{
        path,
        content: `---\ntype: ${type}\ntitle: ${yamlString(title)}\ndescription: ${yamlString(description)}\n---\n\n${body}\n`
      }];
    });
  } catch {
    return [];
  }
}

function placeBlock(block) {
  const raw = String(block.path ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!raw.includes("..")) {
    const matched = raw.match(/^wiki\/(sources|entities|concepts|comparisons|synthesis)\/([^/]+)\.md$/);
    if (matched && /^[\p{L}\p{N}_-]+$/u.test(matched[2])) return raw;
  }
  const parsed = parseFrontmatter(block.content);
  const dir = PAGE_DIRS.has(dirOf(parsed.type)) ? dirOf(parsed.type) : "";
  const slug = slugify(parsed.title);
  if (!dir || !slug || dir === "sources") return null;
  return `wiki/${dir}/${slug}.md`;
}

function dirOf(type) {
  if (type === "entity") return "entities";
  if (type === "concept") return "concepts";
  if (type === "comparison") return "comparisons";
  if (type === "synthesis") return "synthesis";
  if (type === "source") return "sources";
  return "";
}

function normalizePage(content, relPath) {
  const parsed = parseFrontmatter(content);
  const type = parsed.type || typeFromPath(relPath);
  const title = parsed.title || relPath.split("/").pop().replace(/\.md$/, "");
  const lines = ["---", `type: ${type}`, `title: ${yamlString(title)}`];
  if (parsed.description) lines.push(`description: ${yamlString(parsed.description)}`);
  lines.push("---", "", parsed.body.trim(), "");
  return lines.join("\n");
}

function typeFromPath(relPath) {
  const dir = relPath.split("/")[1];
  if (dir === "entities") return "entity";
  if (dir === "concepts") return "concept";
  if (dir === "comparisons") return "comparison";
  if (dir === "synthesis") return "synthesis";
  if (dir === "sources") return "source";
  return "concept";
}

function sourcePage(filename, quote) {
  const title = filename.replace(/\.md$/, "");
  const description = String(quote).replace(/\s+/g, " ").trim().slice(0, 80);
  return `---\ntype: source\ntitle: ${yamlString(title)}\ndescription: ${yamlString(description)}\nsources: ["${filename}"]\n---\n\n## 原文\n\n${quote.trim()}\n`;
}

function yamlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseFrontmatter(content) {
  const match = String(content ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const yaml = match ? match[1] : "";
  const body = match ? content.slice(match[0].length) : String(content ?? "");
  const take = (key) => {
    const line = yaml.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    if (!line) return "";
    return line[1].trim().replace(/^["']|["']$/g, "");
  };
  return { type: take("type").toLowerCase(), title: take("title"), description: take("description"), body };
}

function rebuildIndex(path) {
  const pages = loadPages(join(path, "wiki")).filter((page) => !STRUCTURAL.has(page.type));
  const section = (type, heading) => {
    const lines = pages.filter((page) => page.type === type).map((page) => `- [[${page.title}]]`);
    return `## ${heading}\n\n${lines.length > 0 ? lines.join("\n") : "（空）"}`;
  };
  const content = `---\ntype: index\ntitle: 索引\n---\n\n# 索引\n\n${section("entity", "实体")}\n\n${section("concept", "概念")}\n\n${section("source", "来源")}\n`;
  writeFileSync(join(path, "wiki", "index.md"), content, "utf8");
}

function loadPages(wikiDir) {
  if (!existsSync(wikiDir)) return [];
  return walk(wikiDir).map((file) => {
    const rel = relative(wikiDir, file).split(sep).join("/");
    const content = readFileSync(file, "utf8");
    const parsed = parseFrontmatter(content);
    const id = rel.replace(/\.md$/, "");
    return {
      id,
      relPath: `wiki/${rel}`,
      title: parsed.title || id.split("/").pop(),
      type: parsed.type || typeFromPath(`wiki/${rel}`),
      description: parsed.description,
      content,
      links: wikilinks(content)
    };
  });
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "media" && entry !== ".llm-wiki") walk(full, out);
    } else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

function wikilinks(content) {
  const links = [];
  const pattern = /\[\[([^\]|#]+?)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match = pattern.exec(content);
  while (match) {
    links.push(match[1].trim());
    match = pattern.exec(content);
  }
  return links;
}

function linkGraph(pages) {
  const outAdj = new Map(pages.map((page) => [page.id, new Set()]));
  const inAdj = new Map(pages.map((page) => [page.id, new Set()]));
  for (const page of pages) {
    for (const target of page.links) {
      const id = resolveTarget(target, pages);
      if (!id || id === page.id) continue;
      outAdj.get(page.id)?.add(id);
      inAdj.get(id)?.add(page.id);
    }
  }
  return { outAdj, inAdj };
}

function resolveTarget(raw, pages) {
  const cleaned = raw.trim().replace(/\.md$/i, "");
  const direct = pages.find((page) => page.id === cleaned || page.id.toLowerCase() === cleaned.toLowerCase());
  if (direct) return direct.id;
  const target = slugify(cleaned);
  if (!target) return null;
  for (const page of pages) {
    const base = page.id.split("/").pop() ?? page.id;
    if (slugify(base) === target) return page.id;
  }
  for (const page of pages) {
    if (slugify(page.title) === target) return page.id;
  }
  return null;
}

function rank(pages, query) {
  const docs = pages.map((page) => ({
    id: page.id,
    title: tokenize(page.title),
    body: tokenize(bodyOf(page.content))
  }));
  const df = new Map();
  for (const doc of docs) {
    for (const token of new Set([...doc.title, ...doc.body])) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const queryTokens = tokenize(query);
  const avgTitle = average(docs.map((doc) => doc.title.length));
  const avgBody = average(docs.map((doc) => doc.body.length));
  return docs.map((doc) => ({
    id: doc.id,
    score: TITLE_WEIGHT * bm25(queryTokens, doc.title, avgTitle, df, docs.length)
      + BODY_WEIGHT * bm25(queryTokens, doc.body, avgBody, df, docs.length),
    hop: 0
  })).filter((hit) => hit.score > 0).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function bm25(queryTokens, fieldTokens, avgdl, df, docs) {
  if (fieldTokens.length === 0 || avgdl === 0) return 0;
  const tf = new Map();
  for (const token of fieldTokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const freq = tf.get(token) ?? 0;
    if (!freq) continue;
    const seen = df.get(token) ?? 0;
    const idf = Math.log(1 + (docs - seen + 0.5) / (seen + 0.5));
    const normal = 1 - B + B * (fieldTokens.length / avgdl);
    score += idf * ((freq * (K1 + 1)) / (freq + K1 * normal));
  }
  return score;
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function expand(seeds, pages, { hop, decay, minScore }) {
  const { outAdj, inAdj } = linkGraph(pages);
  const adj = new Map();
  for (const page of pages) {
    adj.set(page.id, new Set([...(outAdj.get(page.id) ?? []), ...(inAdj.get(page.id) ?? [])]));
  }
  const titles = new Map(pages.map((page) => [page.id, page.title]));
  const seedIds = new Set(seeds.map((seed) => seed.id));
  const best = new Map();
  for (const seed of seeds) best.set(seed.id, { id: seed.id, score: seed.score, hop: 0 });
  let frontier = [...best.values()];
  for (let depth = 1; depth <= hop && frontier.length > 0; depth += 1) {
    const next = [];
    for (const current of frontier) {
      for (const neighbor of adj.get(current.id) ?? []) {
        if (seedIds.has(neighbor)) continue;
        const score = current.score * decay;
        if (score < minScore) continue;
        const existing = best.get(neighbor);
        if (existing && existing.score >= score) continue;
        const hit = { id: neighbor, score, hop: existing?.hop ?? depth, via: titles.get(current.id) ?? current.id };
        best.set(neighbor, hit);
        if (!existing) next.push(hit);
      }
    }
    frontier = next;
  }
  return [...best.values()].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function relatedOf(id, byId, outAdj, inAdj) {
  const out = outAdj.get(id) ?? new Set();
  const incoming = inAdj.get(id) ?? new Set();
  const items = [];
  for (const neighbor of new Set([...out, ...incoming])) {
    const page = byId.get(neighbor);
    if (!page) continue;
    const direction = out.has(neighbor) && incoming.has(neighbor) ? "both" : out.has(neighbor) ? "out" : "in";
    const degree = (outAdj.get(neighbor)?.size ?? 0) + (inAdj.get(neighbor)?.size ?? 0);
    items.push({ title: page.title, path: page.relPath, type: page.type, direction, degree });
  }
  items.sort((left, right) => right.degree - left.degree || left.path.localeCompare(right.path));
  return items.slice(0, RELATED_CAP).map(({ degree, ...item }) => item);
}

function resultLinks(results, byId, outAdj) {
  const ids = new Set(results.map((result) => {
    const page = [...byId.values()].find((item) => item.relPath === result.path);
    return page?.id;
  }).filter(Boolean));
  const pathOf = new Map([...byId.values()].map((page) => [page.id, page.relPath]));
  const seen = new Set();
  const links = [];
  for (const id of ids) {
    for (const target of outAdj.get(id) ?? []) {
      if (!ids.has(target)) continue;
      const key = [id, target].sort().join("::");
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: pathOf.get(id), target: pathOf.get(target), weight: 1 });
    }
  }
  return links;
}

function snippetOf(page) {
  if (page.description) return clip(page.description, 80);
  return clip(bodyOf(page.content).replace(/\n/g, " ").trim(), 80);
}

function bodyOf(content) {
  return String(content).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

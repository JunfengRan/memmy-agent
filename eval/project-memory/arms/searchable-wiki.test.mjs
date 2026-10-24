import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSearchableWiki, tokenize } from "./searchable-wiki.mjs";

test("tokenize keeps Chinese bigrams and drops English stop words", () => {
  const tokens = tokenize("整数分 the");
  assert.ok(tokens.includes("整数"));
  assert.ok(tokens.includes("数分"));
  assert.ok(tokens.includes("整数分"));
  assert.equal(tokens.includes("the"), false);
});

test("search stays inside one wiki and ranks the titled page first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-"));
  const calls = [];
  const wiki = createSearchableWiki(dir);
  const complete = async (_system, user) => {
    calls.push(user);
    if (user.includes("catalog-only")) {
      return file("wiki/concepts/catalog.md", "concept", "目录价格", "目录价格按两位小数。");
    }
    return [
      file("wiki/concepts/rounding.md", "concept", "整数分", "这里提到整数分。"),
      file("wiki/concepts/other.md", "concept", "其他", "这里提到整数分。"),
      file("wiki/concepts/jia.md", "concept", "甲页", "甲乙丙见 [[乙页]]。"),
      file("wiki/concepts/yi.md", "concept", "乙页", "普通内容。")
    ].join("\n");
  };
  try {
    await wiki.ingest({
      wikiId: "proj_ledger",
      sourceName: "t_round.md",
      sourceText: "问: 精度\n答: 别的内容",
      quote: "别的内容",
      complete
    });
    await wiki.ingest({
      wikiId: "proj_catalog",
      sourceName: "t_cat.md",
      sourceText: "catalog-only",
      quote: "目录价格按两位小数。",
      complete
    });
    const again = await wiki.ingest({
      wikiId: "proj_ledger",
      sourceName: "t_round.md",
      sourceText: "问: 精度\n答: 别的内容",
      quote: "别的内容",
      complete
    });
    assert.equal(again.skipped, true);
    assert.equal(calls.length, 2);

    const titled = wiki.search("proj_ledger", "整数分", { limit: 5 });
    assert.equal(titled.results[0].title, "整数分");
    assert.equal(wiki.search("proj_catalog", "整数分").count, 0);

    const direct = wiki.search("proj_ledger", "甲乙丙", { hop: 0, limit: 5 });
    assert.deepEqual(direct.results.map((hit) => hit.title), ["甲页"]);
    const expanded = wiki.search("proj_ledger", "甲乙丙", { hop: 1, limit: 5 });
    assert.ok(expanded.results.some((hit) => hit.title === "乙页" && hit.hop === 1));
    assert.equal(direct.links.length, 0);
    assert.ok(expanded.links.some((link) => link.source.includes("jia") && link.target.includes("yi")));

    const source = wiki.read("proj_ledger", ["wiki/sources/t_round.md"])[0];
    assert.match(source.body, /别的内容/);
    assert.equal(existsSync(join(dir, "tmp-pwn.md")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a later source replaces a contradicted maintained page but keeps the old source page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-"));
  const wiki = createSearchableWiki(dir);
  const complete = async (_system, user) => {
    if (user.includes("整数分")) {
      return file("wiki/concepts/rounding.md", "concept", "金额精度", "现行表述：金额按整数分累加。");
    }
    return file("wiki/concepts/rounding.md", "concept", "金额精度", "现行表述：金额按两位小数取整。");
  };
  try {
    await wiki.ingest({
      wikiId: "proj_ledger",
      sourceName: "t_old.md",
      sourceText: "答: 金额按两位小数取整。",
      quote: "金额按两位小数取整。",
      complete
    });
    await wiki.ingest({
      wikiId: "proj_ledger",
      sourceName: "t_new.md",
      sourceText: "答: 金额按整数分累加。",
      quote: "金额按整数分累加。",
      complete
    });
    const concept = wiki.read("proj_ledger", ["wiki/concepts/rounding.md"])[0];
    assert.match(concept.body, /整数分/);
    assert.doesNotMatch(concept.body, /两位小数/);
    const oldSource = wiki.read("proj_ledger", ["wiki/sources/t_old.md"])[0];
    assert.match(oldSource.body, /两位小数/);
    const found = wiki.search("proj_ledger", "整数分", { limit: 5 });
    assert.ok(found.results.some((hit) => hit.type === "concept"));
    assert.ok(found.results.some((hit) => hit.type === "source"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("path traversal in a FILE block is not written outside the wiki", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-"));
  const outside = join(dir, "tmp-pwn.md");
  const wiki = createSearchableWiki(dir);
  const complete = async () => [
    `<<<FILE path="wiki/../../../tmp-pwn.md">>>\npwn\n<<<END>>>`,
    file("wiki/concepts/ok.md", "concept", "正常页", "正常内容写在这里。")
  ].join("\n");
  try {
    await wiki.ingest({
      wikiId: "proj_ledger",
      sourceName: "t_ok.md",
      sourceText: "答: 正常",
      quote: "正常",
      complete
    });
    assert.equal(existsSync(outside), false);
    assert.match(wiki.read("proj_ledger", ["wiki/concepts/ok.md"])[0].body, /正常内容/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a JSON page list is accepted when FILE blocks are absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-"));
  const wiki = createSearchableWiki(dir);
  const complete = async () => JSON.stringify({
    pages: [{ path: "wiki/concepts/rounding.md", type: "concept", title: "金额精度", description: "整数分", body: "现行表述：金额按整数分累加。" }]
  });
  try {
    const result = await wiki.ingest({
      wikiId: "proj_ledger",
      sourceName: "t_json.md",
      sourceText: "答: 金额按整数分累加。",
      quote: "金额按整数分累加。",
      complete
    });
    assert.equal(result.modelCalls, 1);
    assert.match(wiki.read("proj_ledger", ["wiki/concepts/rounding.md"])[0].body, /整数分/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reply without pages still records the source verbatim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-"));
  const wiki = createSearchableWiki(dir);
  let calls = 0;
  const complete = async () => {
    calls += 1;
    return "我来总结一下。";
  };
  try {
    const result = await wiki.ingest({
      wikiId: "proj_ledger",
      sourceName: "t_bad.md",
      sourceText: "答: 一句",
      quote: "一句",
      complete
    });
    assert.equal(calls, 2);
    assert.equal(result.maintained, 0);
    assert.match(wiki.read("proj_ledger", ["wiki/sources/t_bad.md"])[0].body, /一句/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a FILE block with a missing closing quote is still stored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-"));
  const wiki = createSearchableWiki(dir);
  const complete = async () => `<<<FILE path="wiki/concepts/reply-split.md>>>
---
type: concept
title: 回复拆段
---

现行表述：我按句子把这轮拆开了，每句一段。
<<<END>>>`;
  try {
    const result = await wiki.ingest({
      wikiId: "proj_ledger",
      sourceName: "t_split.md",
      sourceText: "答: 我按句子把这轮拆开了，每句一段。",
      quote: "我按句子把这轮拆开了，每句一段。",
      complete
    });
    assert.equal(result.modelCalls, 1);
    assert.equal(result.maintained, 1);
    assert.match(wiki.read("proj_ledger", ["wiki/concepts/reply-split.md"])[0].body, /每句一段/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function file(path, type, title, body) {
  return `<<<FILE path="${path}">>>\n---\ntype: ${type}\ntitle: ${title}\n---\n\n${body}\n<<<END>>>`;
}

#!/usr/bin/env node
/**
 * Updates only the marked run-B gallery appendix in the authored handoff HTML.
 * The gallery is run B's final state. Chart aggregates are read from report.json.
 * Split / wrong-merge marks are applied only when whitespace-normalized content
 * equality reproduces that run's duplicateTopics and wrongMerges.
 *
 * Usage: node eval/project-memory/gold-add-memory/build-add-showcase.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const outPath = join(repo, "docs", "project-memory", "algorithm-handoff.html");

const RUN_IDS = {
  A: "2026-11-11T04-08-59-655Z",
  B: "2026-11-11T04-21-01-504Z",
  legacy: "2026-11-11T03-56-46-995Z",
};

const EXPECTED = {
  A: { topics: 65, gold: 50, f1: "0.676", dup: 10, wm: 1, entriesF1: "0.816" },
  B: { topics: 58, gold: 50, f1: "0.700", dup: 9, wm: 3, entriesF1: "0.861" },
  legacy: { topics: 30, gold: 50, f1: "0.407", dup: 1, wm: 2, entriesF1: "0.487" },
};

const SPACE_NAME = {
  space_ledger: "记账",
  space_catalog: "价格目录",
  space_clinic: "门诊",
  space_warehouse: "仓储",
  space_fleet: "车队",
  space_kitchen: "厨房",
};

const FIELDS = [
  ["decisions", "decision"],
  ["experiences", "experience"],
  ["timeline", "timeline"],
];

const norm = (text) => String(text ?? "").replace(/\s+/g, "").trim();
const round3 = (value) => Number(value).toFixed(3);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadRun(id) {
  const report = readJson(join(repo, "eval", "project-memory", "runs", id, "report.json"));
  return {
    id,
    topics: report.detail.counts.actualTopics,
    gold: report.detail.counts.goldTopics,
    entries: report.detail.counts.actualEntries,
    precision: report.scores["topics.bcubed.precision"],
    recall: report.scores["topics.bcubed.recall"],
    f1: report.scores["topics.bcubed.f1"],
    entriesF1: report.scores["entries.f1"],
    dup: report.errors["topics.duplicateTopics"],
    wm: report.errors["topics.wrongMerges"],
  };
}

function assertRun(key, run) {
  const expected = EXPECTED[key];
  const problems = [];
  if (run.topics !== expected.topics) problems.push(`topics ${run.topics}`);
  if (run.gold !== expected.gold) problems.push(`gold ${run.gold}`);
  if (round3(run.f1) !== expected.f1) problems.push(`f1 ${run.f1}`);
  if (run.dup !== expected.dup) problems.push(`duplicateTopics ${run.dup}`);
  if (run.wm !== expected.wm) problems.push(`wrongMerges ${run.wm}`);
  if (round3(run.entriesF1) !== expected.entriesF1) problems.push(`entries.f1 ${run.entriesF1}`);
  if (problems.length) throw new Error(`${key} report drifted: ${problems.join(", ")}`);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function people(ids, names) {
  return (ids ?? []).map((id) => names.get(id) ?? id).join("、");
}

function metaLine(raw, names) {
  const parts = [];
  if (raw.time) parts.push(raw.time);
  const who = people(raw.user_ids, names);
  if (who) parts.push(who);
  return parts.join(" · ");
}

function listItems(items, names) {
  if (!items?.length) return "<p>没有。</p>";
  return `<ul>${items.map((item) => {
    const line = metaLine(item, names);
    const reason = norm(item.reason) ? ` 理由：${escapeHtml(item.reason)}` : "";
    return `<li>${escapeHtml(item.content || "内容为空。")}${line ? ` ${escapeHtml(line)}` : ""}${reason}</li>`;
  }).join("")}</ul>`;
}

function matchRequired(gold, finalTopics) {
  const required = gold.entries.filter((entry) => !entry.optional);
  const product = [];
  for (const [space, topics] of Object.entries(finalTopics)) {
    (topics ?? []).forEach((topic, index) => {
      const topicKey = `${space}#${topic.id ?? index}`;
      for (const [field, kind] of FIELDS) {
        (topic[field] ?? []).forEach((raw, entryIndex) => {
          product.push({
            space,
            topicKey,
            topicName: topic.topic_name ?? "",
            kind,
            norm: norm(raw.content),
            uid: `${topicKey}#${kind}#${entryIndex}`,
          });
        });
      }
    });
  }
  const buckets = new Map();
  for (const entry of required) {
    const key = `${entry.space_id}|${norm(entry.content)}`;
    const list = buckets.get(key) ?? [];
    list.push(entry);
    buckets.set(key, list);
  }
  const pairs = [];
  for (const actual of product) {
    if (!actual.norm) continue;
    const list = buckets.get(`${actual.space}|${actual.norm}`) ?? [];
    const ids = [...new Set(list.map((entry) => entry.id))];
    if (ids.length !== 1) continue;
    pairs.push({ gold: list[0], actual });
  }
  const hits = new Map();
  for (const pair of pairs) hits.set(pair.gold.id, (hits.get(pair.gold.id) ?? 0) + 1);
  const unique = pairs.filter((pair) => hits.get(pair.gold.id) === 1);

  let duplicateTopics = 0;
  const splitByTopic = new Map();
  for (const goldTopic of gold.topics) {
    const keys = new Set(unique.filter((pair) => pair.gold.topic === goldTopic.id).map((pair) => pair.actual.topicKey));
    if (keys.size > 1) {
      duplicateTopics += keys.size - 1;
      for (const key of keys) {
        const notes = splitByTopic.get(key) ?? [];
        notes.push(goldTopic.topic_name);
        splitByTopic.set(key, notes);
      }
    }
  }
  let wrongMerges = 0;
  const mergeByTopic = new Map();
  const byProduct = new Map();
  for (const pair of unique) {
    const set = byProduct.get(pair.actual.topicKey) ?? new Map();
    set.set(pair.gold.topic, true);
    byProduct.set(pair.actual.topicKey, set);
  }
  const goldName = new Map(gold.topics.map((topic) => [topic.id, topic.topic_name]));
  for (const [key, set] of byProduct) {
    if (set.size > 1) {
      wrongMerges += set.size - 1;
      mergeByTopic.set(key, [...set.keys()].map((id) => goldName.get(id) ?? id));
    }
  }
  return { required: required.length, matched: unique.length, pairs: unique, duplicateTopics, wrongMerges, splitByTopic, mergeByTopic };
}

function renderDecision(raw, index, names) {
  const line = metaLine(raw, names);
  return `<details>
    <summary>决策 ${index + 1}</summary>
    <div class="details-body">
      <p>${escapeHtml(raw.content || "内容为空。")}</p>
      ${line ? `<p>${escapeHtml(line)}</p>` : ""}
      <p><strong>冲突</strong></p>
      ${raw.conflicts?.length ? listItems(raw.conflicts, names) : "<p>没有冲突。</p>"}
      <p><strong>历史</strong></p>
      ${raw.history?.length ? listItems(raw.history, names) : "<p>没有历史。</p>"}
    </div>
  </details>`;
}

function renderPlainList(items, names) {
  if (!items?.length) return "<p>没有。</p>";
  return listItems(items, names);
}

function renderTopic(topic, space, index, names, marks) {
  const key = `${space}#${topic.id ?? index}`;
  const decisions = topic.decisions ?? [];
  const experiences = topic.experiences ?? [];
  const timeline = topic.timeline ?? [];
  const split = marks.split.get(key) ?? [];
  const merge = marks.merge.get(key) ?? [];
  const flags = [
    ...merge.map((namesInTopic) => `<div class="callout risk"><span class="callout-title">误并</span><p>按正文相等，这个主题里的必写条目来自多个金标主题：${namesInTopic.map((name) => escapeHtml(name)).join("、")}。</p></div>`),
    ...split.map((name) => `<div class="callout info"><span class="callout-title">拆开</span><p>金标主题「${escapeHtml(name)}」的必写条目落在多个产品主题里，这里是其中一块。</p></div>`),
  ].join("");
  return `<details>
    <summary>${escapeHtml(topic.topic_name || "未命名")} · ${escapeHtml(topic.domain || "领域未写")}</summary>
    <div class="details-body">
      <p>${escapeHtml(topic.topic_summary || "没有摘要。")}</p>
      <p>决策 ${decisions.length} 条，经验 ${experiences.length} 条，时间线 ${timeline.length} 条。</p>
      ${flags}
      <p><strong>决策</strong></p>
      ${decisions.length ? decisions.map((item, itemIndex) => renderDecision(item, itemIndex, names)).join("") : "<p>没有决策。</p>"}
      <p><strong>经验</strong></p>
      ${renderPlainList(experiences, names)}
      <p><strong>时间线</strong></p>
      ${renderPlainList(timeline, names)}
    </div>
  </details>`;
}

function renderGallery(finalTopics, corpus, names, marks) {
  const order = corpus.spaces.map((space) => space.space_id);
  const seen = new Set(order);
  for (const space of Object.keys(finalTopics)) if (!seen.has(space)) order.push(space);
  const blocks = [];
  const links = [];
  for (const space of order) {
    const topics = finalTopics[space];
    if (!topics) continue;
    const title = SPACE_NAME[space] ?? space;
    const instruction = corpus.spaces.find((item) => item.space_id === space)?.instructions ?? "";
    links.push(`<li><a href="#${escapeHtml(space)}">${escapeHtml(title)}</a>，${topics.length} 个主题</li>`);
    blocks.push(`<h3 id="${escapeHtml(space)}">${escapeHtml(title)}</h3>`);
    if (instruction) {
      const brief = instruction.endsWith("。") ? instruction : `${instruction}。`;
      blocks.push(`<p>${escapeHtml(brief)}这一空间写下 ${topics.length} 个主题。</p>`);
    }
    blocks.push(topics.map((topic, index) => renderTopic(topic, space, index, names, marks)).join(""));
  }
  return { links: `<ul>${links.join("")}</ul>`, body: blocks.join("\n") };
}

/** Never generate the authored narrative. Missing/duplicate markers fail closed. */
function updateAppendix(page, gallery) {
  const start = "<!-- ADD-GALLERY:START -->";
  const end = "<!-- ADD-GALLERY:END -->";
  if (page.split(start).length !== 2 || page.split(end).length !== 2) {
    throw new Error("handoff HTML must contain exactly one gallery marker pair");
  }
  const from = page.indexOf(start) + start.length;
  const to = page.indexOf(end);
  if (to < from) throw new Error("gallery markers are reversed");
  const content = `
<p>运行 B 的固定终态，按空间分组；不是逐主题拆分或误并标注。</p>
${gallery.links}
${gallery.body}
`;
  return page.slice(0, from) + content + page.slice(to);
}

function countEntries(finalTopics) {
  let topics = 0;
  let entries = 0;
  const kinds = { decision: 0, experience: 0, timeline: 0 };
  for (const list of Object.values(finalTopics)) {
    for (const topic of list ?? []) {
      topics += 1;
      for (const [field, kind] of FIELDS) {
        const items = topic[field] ?? [];
        kinds[kind] += items.length;
        entries += items.length;
      }
    }
  }
  return { topics, entries, kinds };
}

function main() {
  const runs = {
    A: loadRun(RUN_IDS.A),
    B: loadRun(RUN_IDS.B),
    legacy: loadRun(RUN_IDS.legacy),
  };
  for (const key of Object.keys(runs)) assertRun(key, runs[key]);

  const gold = readJson(join(repo, "eval", "project-memory", "gold-add-memory", "dataset", "gold.json"));
  const corpus = readJson(join(repo, "eval", "project-memory", "gold-add-memory", "dataset", "corpus.json"));
  const live = readJson(join(repo, "eval", "project-memory", "runs", RUN_IDS.B, "live-run.json"));
  const counted = countEntries(live.final ?? {});
  if (counted.topics !== runs.B.topics) throw new Error(`gallery topics ${counted.topics} != report ${runs.B.topics}`);
  if (counted.entries !== runs.B.entries) throw new Error(`gallery entries ${counted.entries} != report ${runs.B.entries}`);
  if (gold.topics.length !== 50) throw new Error(`gold topics ${gold.topics.length}`);

  const match = matchRequired(gold, live.final ?? {});
  const highlight = match.duplicateTopics === runs.B.dup && match.wrongMerges === runs.B.wm;
  const names = new Map(corpus.members.map((member) => [member.user_id, member.name]));
  const marks = highlight
    ? { split: match.splitByTopic, merge: match.mergeByTopic }
    : { split: new Map(), merge: new Map() };
  const gallery = renderGallery(live.final ?? {}, corpus, names, marks);
  const page = readFileSync(outPath, "utf8");
  const html = updateAppendix(page, gallery);
  if (process.argv.includes("--check")) {
    if (html !== page) throw new Error("gallery is stale; run this script without --check");
    console.log("Gallery is current; authored narrative unchanged.");
  } else {
    writeFileSync(outPath, html);
  }
  console.log(`陈列：运行 B ${counted.topics} 个主题，决策 ${counted.kinds.decision}，经验 ${counted.kinds.experience}，时间线 ${counted.kinds.timeline}`);
  console.log(`正文相等：必写 ${match.required}，匹配 ${match.matched}，拆开超额 ${match.duplicateTopics}，误并超额 ${match.wrongMerges}`);
  for (const pair of match.pairs) console.log(`  ${pair.gold.id} -> ${pair.actual.topicName}`);
  console.log(`报告运行 B：拆开 ${runs.B.dup}，误并 ${runs.B.wm}；逐主题标记 ${highlight ? "有" : "无"}`);
  for (const key of ["A", "B", "legacy"]) {
    const run = runs[key];
    console.log(`${key} 主题 ${run.topics} P ${run.precision} R ${run.recall} F1 ${run.f1} 拆开 ${run.dup} 误并 ${run.wm} 条目F1 ${run.entriesF1}`);
  }
  console.log(`${process.argv.includes("--check") ? "已校验" : "写出"} ${outPath}`);
}

main();

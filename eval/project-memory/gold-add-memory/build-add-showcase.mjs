#!/usr/bin/env node
/**
 * Builds the colleague-facing add showcase from dataset v2.1 and three scored runs.
 * The gallery is run B's final state. Chart aggregates are read from report.json.
 * Split / wrong-merge marks are applied only when whitespace-normalized content
 * equality reproduces that run's duplicateTopics and wrongMerges.
 *
 * Usage: node eval/project-memory/gold-add-memory/build-add-showcase.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const outPath = join(repo, "docs", "project-memory", "add-showcase.html");
const templatePath = join(homedir(), "memtensor", "templates", "explainer.html");

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

const SESSION_ROWS = [
  { name: "词法", sessions: 2, sessionsLabel: "2", purity: 0.043 },
  { name: "Jev · gpt-6-luna", sessions: 4.3, sessionsLabel: "4.3", purity: 0.246 },
  { name: "Jev 协议 · DeepSeek", sessions: 6, sessionsLabel: "6.0", purity: 0.391 },
  { name: "Super Agent 协议 · gpt-6-luna", sessions: 14.3, sessionsLabel: "14.3", purity: 0.899 },
  { name: "Super Agent · DeepSeek", sessions: 16, sessionsLabel: "16", purity: 0.986 },
];

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

function textWidth(text, fontSize) {
  const ascii = fontSize === 13 ? 8 : 7;
  const cjk = fontSize === 13 ? 14 : 12;
  let width = 0;
  for (const char of text) width += char.codePointAt(0) > 255 ? cjk : ascii;
  return width;
}

function boxOf(label) {
  const width = textWidth(label.text, label.size);
  const height = label.size;
  const left = label.anchor === "middle" ? label.x - width / 2 : label.anchor === "end" ? label.x - width : label.x;
  const top = label.y - label.size * 0.82;
  return { left, top, right: left + width, bottom: top + height * 0.25 + label.size * 0.82, text: label.text };
}

function overlaps(a, b) {
  return a.right + 4 > b.left && a.left < b.right + 4 && a.bottom + 4 > b.top && a.top < b.bottom + 4;
}

function crosses(box, line) {
  const left = box.left - 4;
  const right = box.right + 4;
  const top = box.top - 4;
  const bottom = box.bottom + 4;
  if (line.x1 === line.x2) return line.x1 >= left && line.x1 <= right && Math.max(line.y1, top) <= Math.min(line.y2, bottom);
  if (line.y1 === line.y2) return line.y1 >= top && line.y1 <= bottom && Math.max(line.x1, left) <= Math.min(line.x2, right);
  return false;
}

function assertLayout(boxes, lines, width, height) {
  for (const box of boxes) {
    if (box.left < 0 || box.top < 0 || box.right > width || box.bottom > height) {
      throw new Error(`label outside the chart: ${box.text}`);
    }
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (overlaps(boxes[i], boxes[j])) throw new Error(`labels overlap: ${boxes[i].text} / ${boxes[j].text}`);
    }
    if (boxes[i].allowLine) continue;
    for (const line of lines) {
      if (crosses(boxes[i], line)) throw new Error(`line crosses ${boxes[i].text}`);
    }
  }
}

function svgText(label) {
  const anchor = label.anchor ? ` text-anchor="${label.anchor}"` : "";
  return `<text class="${label.cls}" x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" font-size="${label.size}" fill="${label.fill}"${anchor}>${escapeHtml(label.text)}</text>`;
}

function marker(x, y, kind) {
  const cls = kind === "recall" ? "node" : "node-focus";
  const fill = kind === "recall" ? "#FFFFFF" : "#EEF0FF";
  const stroke = kind === "recall" ? "#E2E8F0" : "#4044ED";
  const width = kind === "recall" ? "1" : "1.5";
  return `<rect class="${cls}" x="${(x - 5).toFixed(1)}" y="${(y - 5).toFixed(1)}" width="10" height="10" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="${width}" />`;
}

function chip(x, y, text) {
  const width = textWidth(text, 11) + 20;
  return {
    width,
    svg: `<rect class="chip" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="24" rx="12" fill="#FFFFFF" stroke="#D8DAFB" /><text class="t-chip" x="${(x + width / 2).toFixed(1)}" y="${(y + 16).toFixed(1)}" font-size="11" fill="#4044ED" text-anchor="middle">${escapeHtml(text)}</text>`,
    box: { left: x, top: y, right: x + width, bottom: y + 24, text },
  };
}

function renderChart(runs) {
  const width = 720;
  const height = 880;
  const p1 = { l: 88, r: 692, t: 64, b: 236 };
  const p2 = { l: 88, r: 692, t: 400, b: 820 };
  const xTopic = (topics) => p1.l + ((topics - 20) / 56) * (p1.r - p1.l);
  const yScore = (value) => p1.b - ((value + 0.02) / 1.1) * (p1.b - p1.t);
  const xSession = (sessions) => p2.l + (sessions / 18) * (p2.r - p2.l);
  const yPurity = (value) => p2.b - ((value + 0.05) / 1.13) * (p2.b - p2.t);

  const boxes = [];
  const lines = [];
  const parts = [];
  const addLabel = (label) => {
    boxes.push(boxOf(label));
    parts.push(svgText(label));
  };
  const addLine = (line, svg) => {
    lines.push(line);
    parts.push(svg);
  };

  addLabel({ text: "上 · 产品写入", x: 16, y: 28, size: 13, cls: "t-title", fill: "#141D32" });
  addLabel({ text: "精确率", x: 548, y: 28, size: 11, cls: "t-sub", fill: "#62748E" });
  addLabel({ text: "召回", x: 640, y: 28, size: 11, cls: "t-sub", fill: "#62748E" });
  parts.push(marker(532, 24, "precision"));
  parts.push(marker(624, 24, "recall"));
  boxes.push({ left: 527, top: 19, right: 537, bottom: 29, text: "精确率点", allowLine: true });
  boxes.push({ left: 619, top: 19, right: 629, bottom: 29, text: "召回点", allowLine: true });

  addLine(
    { x1: p1.l, y1: p1.t, x2: p1.l, y2: p1.b },
    `<line class="edge" x1="${p1.l}" y1="${p1.t}" x2="${p1.l}" y2="${p1.b}" stroke="#62748E" stroke-width="1" />`,
  );
  addLine(
    { x1: p1.l, y1: p1.b, x2: p1.r, y2: p1.b },
    `<line class="edge" x1="${p1.l}" y1="${p1.b}" x2="${p1.r}" y2="${p1.b}" stroke="#62748E" stroke-width="1" />`,
  );
  for (const tick of [0, 0.5, 1]) {
    const y = yScore(tick);
    addLabel({ text: String(tick), x: p1.l - 8, y: y + 4, size: 11, anchor: "end", cls: "t-mono t-sub", fill: "#62748E" });
  }
  const goldX = xTopic(50);
  addLine(
    { x1: goldX, y1: p1.t, x2: goldX, y2: p1.b },
    `<line class="edge-main" x1="${goldX.toFixed(1)}" y1="${p1.t}" x2="${goldX.toFixed(1)}" y2="${p1.b}" stroke="#4044ED" stroke-width="1.5" />`,
  );
  addLabel({ text: "金标 50", x: goldX, y: p1.t - 12, size: 11, anchor: "middle", cls: "t-chip", fill: "#4044ED" });

  const productPoints = [
    { name: "旧实现", run: runs.legacy },
    { name: "运行 B", run: runs.B },
    { name: "运行 A", run: runs.A },
  ];
  for (const point of productPoints) {
    const x = xTopic(point.run.topics);
    const precisionY = yScore(point.run.precision);
    const recallY = yScore(point.run.recall);
    parts.push(marker(x, precisionY, "precision"));
    parts.push(marker(x, recallY, "recall"));
    boxes.push({ left: x - 5, top: precisionY - 5, right: x + 5, bottom: precisionY + 5, text: `${point.name}精确率`, allowLine: true });
    boxes.push({ left: x - 5, top: recallY - 5, right: x + 5, bottom: recallY + 5, text: `${point.name}召回`, allowLine: true });
    const precisionLabel = round3(point.run.precision);
    const recallLabel = round3(point.run.recall);
    if (point.name === "运行 A") {
      addLabel({ text: precisionLabel, x: x + 12, y: precisionY + 4, size: 11, cls: "t-mono t-sub", fill: "#62748E" });
      addLabel({ text: recallLabel, x: x + 12, y: recallY + 4, size: 11, cls: "t-mono t-sub", fill: "#62748E" });
    } else {
      addLabel({ text: precisionLabel, x: x - 12, y: precisionY + 4, size: 11, anchor: "end", cls: "t-mono t-sub", fill: "#62748E" });
      addLabel({ text: recallLabel, x: x - 12, y: recallY + 4, size: 11, anchor: "end", cls: "t-mono t-sub", fill: "#62748E" });
    }
    addLabel({ text: point.name, x, y: p1.b + 26, size: 13, anchor: "middle", cls: "t-title", fill: "#141D32" });
  }

  const coarse = chip(p1.l, p1.b + 40, "粗端");
  const fine = chip(p1.r - textWidth("细端", 11) - 20, p1.b + 40, "细端");
  parts.push(coarse.svg, fine.svg);
  boxes.push(coarse.box, fine.box);

  addLabel({ text: "下 · 会话路由", x: 16, y: 348, size: 13, cls: "t-title", fill: "#141D32" });
  addLabel({ text: "23 条消息，6 个原始会话", x: 16, y: 370, size: 11, cls: "t-sub", fill: "#62748E" });

  addLine(
    { x1: p2.l, y1: p2.t, x2: p2.l, y2: p2.b },
    `<line class="edge" x1="${p2.l}" y1="${p2.t}" x2="${p2.l}" y2="${p2.b}" stroke="#62748E" stroke-width="1" />`,
  );
  addLine(
    { x1: p2.l, y1: p2.b, x2: p2.r, y2: p2.b },
    `<line class="edge" x1="${p2.l}" y1="${p2.b}" x2="${p2.r}" y2="${p2.b}" stroke="#62748E" stroke-width="1" />`,
  );
  for (const tick of [0, 0.5, 1]) {
    const y = yPurity(tick);
    addLabel({ text: String(tick), x: p2.l - 8, y: y + 4, size: 11, anchor: "end", cls: "t-mono t-sub", fill: "#62748E" });
  }
  const sourceX = xSession(6);
  addLine(
    { x1: sourceX, y1: p2.t, x2: sourceX, y2: p2.b },
    `<line class="edge-main" x1="${sourceX.toFixed(1)}" y1="${p2.t}" x2="${sourceX.toFixed(1)}" y2="${p2.b}" stroke="#4044ED" stroke-width="1.5" />`,
  );
  addLabel({ text: "6 个原始会话", x: sourceX, y: p2.t - 12, size: 11, anchor: "middle", cls: "t-chip", fill: "#4044ED" });

  const sessionAnchors = [
    { dx: 14, dy: 4, anchor: "start" },
    { dx: -14, dy: 4, anchor: "end" },
    { dx: 14, dy: 4, anchor: "start" },
    { dx: -14, dy: 4, anchor: "end" },
    { dx: -14, dy: -18, anchor: "end" },
  ];
  SESSION_ROWS.forEach((row, index) => {
    const x = xSession(row.sessions);
    const y = yPurity(row.purity);
    parts.push(marker(x, y, "precision"));
    boxes.push({ left: x - 5, top: y - 5, right: x + 5, bottom: y + 5, text: `${row.name}点`, allowLine: true });
    const anchor = sessionAnchors[index];
    addLabel({ text: row.name, x: x + anchor.dx, y: y + anchor.dy, size: 11, anchor: anchor.anchor, cls: "t-sub", fill: "#62748E" });
  });

  const coarse2 = chip(p2.l, p2.b + 16, "粗端");
  const fine2 = chip(p2.r - textWidth("细端", 11) - 20, p2.b + 16, "细端");
  parts.push(coarse2.svg, fine2.svg);
  boxes.push(coarse2.box, fine2.box);

  assertLayout(boxes, lines, width, height);
  return `<figure class="diagram">
    <svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="上图是产品写入的主题数对 B³ 精确率和召回，金标竖线在 50。下图是会话路由的会话数对纯度，竖线在 6 个原始会话。">
      ${parts.join("\n")}
    </svg>
    <figcaption><span class="fig-no">图 1</span>同一张取舍的两种读法。上图横轴是主题数，焦点点是 B³ 精确率，普通点是 B³ 召回，竖线是金标 50 个主题。右端主题更多、精确率更高，是切得细的一端；左端主题更少、召回更高，是切得粗的一端。旧实现在竖线左边，是 30 个主题。下图横轴是会话数，纵轴是会话纯度，竖线是 6 个原始会话。它统计 23 条消息怎样归组。</figcaption>
  </figure>`;
}

function renderTable(headers, rows, oursIndex) {
  const head = headers.map((header, index) => `<th${index ? ' class="num"' : ""}>${escapeHtml(header)}</th>`).join("");
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((cell, index) => `<td${index ? ' class="num"' : ""}>${escapeHtml(cell)}</td>`).join("");
    return `<tr${rowIndex === oursIndex ? ' class="row-ours"' : ""}>${cells}</tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderPage({ runs, gallery, match, highlight, shell }) {
  const productRows = [
    ["旧实现", String(runs.legacy.topics), round3(runs.legacy.precision), round3(runs.legacy.recall), round3(runs.legacy.f1), round3(runs.legacy.entriesF1)],
    ["运行 B", String(runs.B.topics), round3(runs.B.precision), round3(runs.B.recall), round3(runs.B.f1), round3(runs.B.entriesF1)],
    ["运行 A", String(runs.A.topics), round3(runs.A.precision), round3(runs.A.recall), round3(runs.A.f1), round3(runs.A.entriesF1)],
  ];
  const sessionRows = SESSION_ROWS.map((row) => [row.name, row.sessionsLabel, row.purity.toFixed(3)]);
  const rawLines = ["A", "B", "legacy"].map((key) => {
    const run = runs[key];
    const label = key === "legacy" ? "旧实现" : `运行 ${key}`;
    return `${label}  主题 ${run.topics}  精确率 ${run.precision}  召回 ${run.recall}  F1 ${run.f1}  拆开 ${run.dup}  误并 ${run.wm}  条目 F1 ${run.entriesF1}`;
  }).join("\n");
  const markNote = highlight
    ? `正文相等对上 ${match.matched} 条必写条目，拆开超额 ${match.duplicateTopics}、误并超额 ${match.wrongMerges}，与运行 B 的评分合计一致，主题上标了这两种情况。`
    : `按同一空间里、去掉空白后的正文完全相等，运行 B 对上 ${match.matched} 条必写条目，拆开超额 ${match.duplicateTopics}，误并超额 ${match.wrongMerges}。评分报告里这一次是拆开 ${runs.B.dup}、误并 ${runs.B.wm}。两套合计不一致，所以主题上不标拆开或误并。上面的拆开和误并数字取自评分报告。`;

  const main = `<header class="doc-head">
        <p class="eyebrow">内部对照 <span class="tag tag-memos">MemOS</span></p>
        <h1>写入偏细，人看的列表不能当匹配键</h1>
        <div class="title-rule" aria-hidden="true"></div>
        <p class="lead"><strong>一句话：</strong>数据集 v2.1 上，这次产品写入留下 ${runs.B.topics} 个主题，金标是 ${runs.B.gold} 个，B³ 精确率 ${round3(runs.B.precision)}，召回 ${round3(runs.B.recall)}。Agent 做归属和检索时对着切得细的主题；另用一个整理模型把细主题折成人看的列表。人看的列表不能反过来当匹配键。这一层没有写进 v3，当前代码里也没有。</p>
        <dl class="meta">
          <div><dt>来源</dt><dd>数据集 v2.1 · 2026-11-11 三次写入评分</dd></div>
          <div><dt>日期</dt><dd>2026-11-11</dd></div>
          <div><dt>读者</dt><dd>做项目记忆的同事</dd></div>
        </dl>
      </header>

      <section id="s1">
        <h2><span class="sec-no">01</span>写下的主题</h2>
        <p>这一页展示 2026-11-11 04:21 那一次写入的终态，按空间分组。每张卡片是产品写下的主题名、摘要和领域，条目分成决策、经验和时间线。决策展开后能看到正文、冲突和历史。这是当时写下的结果，不是规格说明。</p>
        <p>卡片不标拆开或误并。合计在下一节，来自同一次评分报告：${runs.B.topics} 个主题对金标 ${runs.B.gold} 个，拆开 ${runs.B.dup}，误并 ${runs.B.wm}。</p>
        ${gallery.links}
        ${gallery.body}
      </section>

      <section id="s2">
        <h2><span class="sec-no">02</span>粗细是跷跷板</h2>
        <p>切得细，主题更纯，归属和检索不容易选错，人要扫的列表会变长。切得粗，人看得少，主题里混进别的事，后面就会选错。B³ F1 把精确率和召回折中，两端可以差不多，所以不能靠一个 F1 决定切多细。</p>
        <p>上图是产品在数据集 v2.1 上的三次写入。金标是 50 个主题。运行 A 是 04:08 那一次，运行 B 是 04:21 这一次，也就是上一节的卡片。旧实现是 03:56 那一次，<strong>30 个主题，少于金标的 50。</strong>它的召回是 ${round3(runs.legacy.recall)}。</p>
        ${renderChart(runs)}
        ${renderTable(["运行", "主题数", "精确率", "召回", "B³ F1", "条目 F1"], productRows, 1)}
        <p>拆开和误并是评分报告里的合计。运行 A 拆开 ${runs.A.dup}、误并 ${runs.A.wm}。运行 B 拆开 ${runs.B.dup}、误并 ${runs.B.wm}。旧实现拆开 ${runs.legacy.dup}、误并 ${runs.legacy.wm}。</p>
        <div class="callout info">
          <span class="callout-title">为什么卡片上没有标记</span>
          <p>${markNote}</p>
        </div>
        <p>下图是同一种取舍的另一次测量，统计的是会话路由：23 条消息、6 个原始会话。纵轴是会话纯度，横轴是归出来的会话数。这些是已经发表的均值，本页没有重算。</p>
        ${renderTable(["方法", "会话数", "纯度"], sessionRows, -1)}
        <p>词法把消息收成 2 个会话，纯度 0.043。Super Agent 用 DeepSeek 时拆成 16 个会话，纯度 0.986。协议换到 gpt-6-luna 之后是 14.3 个会话，纯度 0.899。Jev 用 gpt-6-luna 是 4.3 个会话，纯度 0.246；Jev 的协议换到 DeepSeek 是 6.0 个会话，纯度 0.391。</p>
        <p>建议两层都留下。Agent 做归属和检索时，对着切得细的主题。另用一个整理模型，把这些细主题折成给人看的列表。审计、可视化和界面读那一层。</p>
        <p><strong>给人看的列表是细主题的视图，不能反过来当 Agent 的匹配键。</strong></p>
        <p>这是测量之后的建议。还没有写进 v3，当前代码里也没有这一层。</p>
      </section>

      <section id="appendix">
        <h2><span class="sec-no">A</span>附录</h2>
        <details open>
          <summary>材料</summary>
          <div class="details-body">
            <div class="table-wrap">
              <table>
                <thead><tr><th>结论</th><th>材料</th></tr></thead>
                <tbody>
                  <tr><td>上一节的卡片是 04:21 那一次的终态</td><td>该次写入结束时的主题列表，${runs.B.topics} 个主题</td></tr>
                  <tr><td>主题数、精确率、召回、F1、拆开、误并、条目 F1</td><td>2026-11-11 三份评分，图和表直接读这些字段</td></tr>
                  <tr><td>会话数和纯度</td><td>已发表均值，本页不重算</td></tr>
                  <tr><td>人看的列表还不能当匹配键</td><td>v3 没有这一层；当前代码也没有把人看的列表做成另一套键</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </details>
        <details>
          <summary>评分原值</summary>
          <div class="details-body">
            <pre><code>${escapeHtml(rawLines)}</code></pre>
          </div>
        </details>
      </section>

      <footer class="site-foot">
        <span>MEMTENSOR · 研究文档</span>
        <span>2026-11-11</span>
      </footer>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${shell.themeBoot}
  <title>写入偏细，人看的列表不能当匹配键</title>
  ${shell.style}
</head>
<body>
  ${shell.tools}
  <div class="layout">
    <nav class="toc" aria-label="目录">
      <p class="toc-brand"><span class="toc-org">MemTensor</span><span class="toc-kind">研究文档</span></p>
      <a href="#s1" aria-current="true"><span class="toc-no">01</span>写下的主题</a>
      <a href="#s2"><span class="toc-no">02</span>粗细是跷跷板</a>
      <a href="#appendix"><span class="toc-no">A</span>附录</a>
    </nav>
    <main>
      ${main}
    </main>
  </div>
  ${shell.bodyScript}
</body>
</html>
`;
}

function loadShell() {
  const template = readFileSync(templatePath, "utf8");
  const styleStart = template.indexOf("<style>");
  const styleEnd = template.indexOf("</style>");
  const themeStart = template.indexOf("<script>");
  const themeEnd = template.indexOf("</script>", themeStart);
  const toolsStart = template.indexOf('<div class="page-tools">');
  const toolsEnd = template.indexOf("</div>", toolsStart);
  const marker = template.indexOf("nav.toc a[href^=\"#\"]");
  const scriptStart = template.lastIndexOf("<script>", marker);
  const scriptEnd = template.indexOf("</script>", marker);
  if ([styleStart, styleEnd, themeStart, themeEnd, toolsStart, toolsEnd, marker, scriptStart, scriptEnd].some((index) => index < 0)) {
    throw new Error(`research-doc template is missing expected sections: ${templatePath}`);
  }
  return {
    style: template.slice(styleStart, styleEnd + "</style>".length),
    themeBoot: template.slice(themeStart, themeEnd + "</script>".length),
    tools: template.slice(toolsStart, toolsEnd + "</div>".length),
    bodyScript: template.slice(scriptStart, scriptEnd + "</script>".length),
  };
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
  const html = renderPage({ runs, gallery, match, highlight, shell: loadShell() });
  if (!html.includes('class="eyebrow"') || !html.includes('class="lead"') || !html.includes("data-theme-toggle") || !html.includes("调整排版")) {
    throw new Error("generated page is missing the research-doc chrome");
  }
  if (!html.includes("<figure class=\"diagram\">") || !html.includes("没有写进 v3")) {
    throw new Error("generated page is missing the chart or the recommendation");
  }
  writeFileSync(outPath, html);
  console.log(`陈列：运行 B ${counted.topics} 个主题，决策 ${counted.kinds.decision}，经验 ${counted.kinds.experience}，时间线 ${counted.kinds.timeline}`);
  console.log(`正文相等：必写 ${match.required}，匹配 ${match.matched}，拆开超额 ${match.duplicateTopics}，误并超额 ${match.wrongMerges}`);
  for (const pair of match.pairs) console.log(`  ${pair.gold.id} -> ${pair.actual.topicName}`);
  console.log(`报告运行 B：拆开 ${runs.B.dup}，误并 ${runs.B.wm}；逐主题标记 ${highlight ? "有" : "无"}`);
  for (const key of ["A", "B", "legacy"]) {
    const run = runs[key];
    console.log(`${key} 主题 ${run.topics} P ${run.precision} R ${run.recall} F1 ${run.f1} 拆开 ${run.dup} 误并 ${run.wm} 条目F1 ${run.entriesF1}`);
  }
  console.log(`写出 ${outPath}`);
}

main();

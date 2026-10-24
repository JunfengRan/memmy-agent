"""Render eval/project-memory/report.html from the committed run files.

Usage: python3 eval/project-memory/render-report.py

The page shell comes from the studio template ($MEMTENSOR_TEMPLATE, default
~/memtensor/templates/explainer.html). Without it, the shell of the existing
report.html is reused, so the report still renders on a machine without the studio.
"""

import html
import json
import os
import re
from collections import Counter
from pathlib import Path

here = Path(__file__).resolve().parent
runs = here / "runs"
pre = runs / "pre-fix"
out = here / "report.html"
body_path = here / "report-body.html"
template_path = Path(os.environ.get("MEMTENSOR_TEMPLATE", Path.home() / "memtensor/templates/explainer.html"))

ARMS = [
    ("baseline", "空白对照"),
    ("project", "项目记忆（标注上限）"),
    ("wiki", "项目记忆+Wiki"),
    ("lookup", "自行检索"),
    ("attr-tree", "属性树"),
    ("memos", "MemOS 叶子合并"),
    ("graphiti", "Graphiti 事实边"),
]
LABEL = dict(ARMS)
CURSOR_ARMS = [("baseline", "空白对照"), ("project", "项目记忆（标注上限）"), ("attr-tree", "属性树")]
KINDS = [
    ("cross-project", "跨项目"),
    ("stale", "过时"),
    ("overridden", "被改口"),
    ("plain", "普通"),
    ("scope-leak", "无项目窗口"),
]
KIND_LABEL = dict(KINDS)
ERRORS = [
    ("none", "答对"),
    ("empty", "答不出"),
    ("superseded", "把旧说法当现行"),
    ("wrong_project", "用了别的项目"),
    ("other", "其他"),
]
ERROR_LABEL = {"none": "答对", "empty": "召回空或答不出", "superseded": "把旧说法当现行",
               "ambiguous": "相似信息没选", "wrong_project": "用了别的项目", "other": "其他"}


def load(path):
    return json.loads(path.read_text()) if path.exists() else None


def esc(value):
    return html.escape(str(value if value is not None else ""), quote=True)


def by_id(data):
    return {q["id"]: q for q in (data or {}).get("questions", [])}


def passed(data):
    return sum(1 for q in (data or {}).get("questions", []) if q.get("passed"))


def total(data):
    return (data or {}).get("questionCount", 29)


def score(data):
    if not data:
        return "—"
    return f"{passed(data)}/{total(data)}"


def pct(data):
    return round(100 * passed(data) / total(data)) if data else 0


def flips(before, after):
    a, b = by_id(before), by_id(after)
    return sorted(k for k in a if k in b and bool(a[k].get("passed")) != bool(b[k].get("passed")))


recall = {arm: load(runs / f"{arm}-recall.json") for arm, _ in ARMS}
answer = {arm: load(runs / f"{arm}-answer.json") for arm, _ in ARMS}
cursor = {arm: load(runs / f"cursor-answer-{arm}.json") for arm, _ in CURSOR_ARMS}
before = {
    "recall": {arm: load(pre / f"{arm}-recall.json") for arm in ("baseline", "project", "wiki", "lookup")},
    "answer": {arm: load(pre / f"{arm}-answer.json") for arm in ("baseline", "project", "wiki", "lookup")},
    "cursor": load(pre / "cursor-answer-project.json"),
}
cost = load(runs / "cost.json")
missing = [f"{arm}-{kind}" for arm, _ in ARMS for kind, data in (("recall", recall[arm]), ("answer", answer[arm])) if not data]
if missing:
    raise SystemExit(f"missing run files: {', '.join(missing)}")


def table(head, rows, num_from=1, ours=None):
    """head: list of column names. Columns at index >= num_from are numeric unless head starts with '~'."""
    cells = []
    for i, name in enumerate(head):
        text = name.lstrip("~")
        cls = " class='num'" if i >= num_from and not name.startswith("~") else ""
        cells.append(f"<th{cls}>{esc(text)}</th>")
    body = []
    for key, row in rows:
        mark = " class='row-ours'" if ours is not None and key == ours else ""
        tds = []
        for i, value in enumerate(row):
            cls = " class='num'" if i >= num_from and not head[i].startswith("~") else ""
            tds.append(f"<td{cls}>{value}</td>")
        body.append(f"<tr{mark}>{''.join(tds)}</tr>")
    return (f"<div class='table-wrap'><table><thead><tr>{''.join(cells)}</tr></thead>"
            f"<tbody>{''.join(body)}</tbody></table></div>")


# ---- figures -----------------------------------------------------------------------------------

def node(cls, x, y, w, h, title, sub=None, title_cls="t-title"):
    fill, stroke, extra = {
        "node": ("#FFFFFF", "#E2E8F0", ""),
        "node-focus": ("#EEF0FF", "#4044ED", ' stroke-width="1.5"'),
        "risk": ("#FEF2F2", "#DC2626", ""),
    }[cls]
    color = {"t-title": "#141D32", "t-focus": "#4044ED", "t-risk": "#B91C1C"}[title_cls]
    cx = x + w / 2
    ty = y + (24 if sub else h / 2 + 4.5)
    parts = [
        f'<rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}"{extra} />',
        f'<text class="{title_cls}" x="{cx}" y="{ty}" text-anchor="middle" font-size="13" font-weight="600" fill="{color}">{esc(title)}</text>',
    ]
    if sub:
        parts.append(f'<text class="t-sub" x="{cx}" y="{y + 42}" text-anchor="middle" font-size="11" fill="#62748E">{esc(sub)}</text>')
    return "".join(parts)


def pipeline_figure():
    columns = [
        ("工作记录", f"{len(recall['project'].get('ingested') or [])} 条，按时间回放", [("node", "各方式共用", "同一份语料和题")]),
        ("写入", "摘要、向量、L1", [("node", "项目记忆", "项目归一、判重"), ("risk", "评测脚本", "按金标写现行结论")]),
        ("召回", "检索候选", [("node", "项目记忆", "作用域系数"), ("node", "自行检索", "模型调工具查")]),
        ("注入", "拼进上下文", [("node", "属性树等三种", "读时重排截断"), ("node", "项目记忆+Wiki", "再接两页 wiki")]),
        ("回答", "模型加裁判", [("node", "Memmy 模型", "只看注入"), ("node", "Cursor", "只看注入")]),
    ]
    w, gap, x0, y0 = 120, 20, 20, 48
    parts = [
        '<defs><marker id="arr-pm-main" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">'
        '<path class="arrow-main" d="M0,0 L6,3 L0,6 Z" fill="#4044ED" /></marker>'
        '<marker id="arr-pm" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">'
        '<path class="arrow" d="M0,0 L6,3 L0,6 Z" fill="#62748E" /></marker></defs>',
        '<g class="legend">'
        '<line class="edge-main" x1="470" y1="20" x2="494" y2="20" stroke="#4044ED" stroke-width="1.5" />'
        '<text class="t-sub" x="500" y="24" font-size="11" fill="#62748E">数据流</text>'
        '<line class="edge-async" x1="560" y1="20" x2="584" y2="20" stroke="#62748E" stroke-width="1" stroke-dasharray="4 3" />'
        '<text class="t-sub" x="590" y="24" font-size="11" fill="#62748E">在这一步改了什么</text>'
        '</g>',
    ]
    for i, (title, sub, below) in enumerate(columns):
        x = x0 + i * (w + gap)
        parts.append(node("node", x, y0, w, 56, title, sub))
        if i < len(columns) - 1:
            parts.append(f'<line class="edge-main" x1="{x + w}" y1="{y0 + 28}" x2="{x + w + gap - 2}" y2="{y0 + 28}" '
                         'stroke="#4044ED" stroke-width="1.5" marker-end="url(#arr-pm-main)" />')
        cx = x + w / 2
        parts.append(f'<line class="edge-async" x1="{cx}" y1="{y0 + 56}" x2="{cx}" y2="{y0 + 86}" '
                     'stroke="#62748E" stroke-width="1" stroke-dasharray="4 3" marker-end="url(#arr-pm)" />')
        for j, (cls, t, s) in enumerate(below):
            title_cls = "t-risk" if cls == "risk" else "t-title"
            parts.append(node(cls, x, y0 + 88 + j * 76, w, 56, t, s, title_cls))
    return (
        '<figure class="diagram">'
        '<svg viewBox="0 0 720 300" xmlns="http://www.w3.org/2000/svg" role="img" '
        'aria-label="七种方式共用一条回放链路，各自只改写入、召回或注入中的一步">'
        + "".join(parts)
        + '</svg><figcaption><span class="fig-no">图 2</span>七种方式共用同一条回放链路，各自只改一步。'
        '红框是这次复盘最要紧的一点：项目记忆的现行结论不是产品写的，是评测脚本按金标写的。</figcaption></figure>'
    )


import math as _math


def units(arm, text):
    """One injected item. Lookup counts a tool row (a trace_ line plus its wrap).
    Other arms count a numbered memory block, plus every '- ' line."""
    text = text or ""
    if arm == "lookup":
        return [part.strip() for part in re.split(r"(?=^trace_)", text, flags=re.M) if part.startswith("trace_")]
    items = [part.strip() for part in re.split(r"(?m)^(?=\d+\.\s)", text) if re.match(r"\d+\.\s", part)]
    items += [line[2:].strip() for line in text.splitlines() if line.startswith("- ")]
    return items


def analyze():
    ids = [q["id"] for q in recall["baseline"]["questions"]]
    stats, cells = {}, {qid: {} for qid in ids}
    for arm, _label in ARMS:
        recalled, answered = by_id(recall[arm]), by_id(answer[arm])
        items = hits = chars = bullets = bullet20 = 0
        cover = up = down = trap_q = trap_answered = no_phrase = 0
        for qid in ids:
            question = recalled[qid]
            body = question.get("context") or ""
            rows = units(arm, body)
            phrase = (question.get("mustInclude") or [""])[0]
            trap = (question.get("mustNotInclude") or [None])[0]
            hit = sum(1 for row in rows if phrase and phrase in row)
            bullet_n = sum(1 for line in body.splitlines() if line.startswith("- "))
            items += len(rows)
            hits += hit
            chars += len(body)
            bullets += bullet_n
            bullet20 += bullet_n == 20
            has_phrase, has_trap = phrase in body, bool(trap) and trap in body
            cover += has_phrase
            no_phrase += not has_phrase
            if has_phrase and has_trap and not question.get("passed"):
                trap_q += 1
                trap_answered += bool(answered[qid].get("passed"))
            up += (not question.get("passed")) and bool(answered[qid].get("passed"))
            down += bool(question.get("passed")) and not answered[qid].get("passed")
            cells[qid][arm] = f"{len(rows)} 条 · 命中 {hit}"
        stats[arm] = {
            "items": items, "hits": hits, "ratio": hits / items if items else 0,
            "cover": cover, "mean": items / len(ids), "chars": chars / len(ids),
            "bullets": bullets, "bullet20": bullet20, "up": up, "down": down,
            "trap_q": trap_q, "trap_answered": trap_answered, "no_phrase": no_phrase,
        }
    return stats, cells


STATS, VOLUME_CELLS = analyze()
SHORT = {
    "baseline": "空白对照", "project": "项目记忆", "wiki": "Wiki", "lookup": "自行检索",
    "attr-tree": "属性树", "memos": "MemOS", "graphiti": "Graphiti",
}


def column_figure(groups, series, maximum, number, caption, aria, bar_w=40):
    """Vertical bars. groups: (key, label). series: (name, fill, stroke, values-by-key).
    A bar is at least 24px tall; the count is printed inside it."""
    inner = 6
    group_w = len(series) * bar_w + (len(series) - 1) * inner
    gaps = max(1, len(groups) - 1)
    group_gap = min(16, (704 - len(groups) * group_w) / gaps)
    if group_gap < 8:
        raise SystemExit(f"column chart does not fit: bar {bar_w}, groups {len(groups)}")
    total_w = len(groups) * group_w + (len(groups) - 1) * group_gap
    x0 = (720 - total_w) / 2
    legend_y, plot_top, plot_h, label_h = 8, 52, 150, 36
    baseline = plot_top + plot_h
    parts = []
    legend_x = 16
    for name, rect_cls, fill, stroke, _values in series:
        width = max(88, 14 * len(name) + 24)
        parts.append(
            f'<rect class="{rect_cls}" x="{legend_x}" y="{legend_y}" width="{width}" height="24" rx="12" '
            f'fill="{fill}" stroke="{stroke}" />'
            f'<text class="t-chip" x="{legend_x + width / 2}" y="{legend_y + 16}" text-anchor="middle" '
            f'font-size="11" fill="#4044ED">{esc(name)}</text>'
        )
        legend_x += width + 16
    for i, (key, label) in enumerate(groups):
        gx = x0 + i * (group_w + group_gap)
        focus = key == "project" or key == "项目记忆"
        cls, tcls, color = ("node-focus", "t-focus", "#4044ED") if focus else ("badge", "t-chip", "#4044ED")
        stroke = "#4044ED" if focus else "none"
        fill = "#EEF0FF" if focus else "#FFFFFF"
        extra = ' stroke-width="1.5"' if focus else ""
        parts.append(
            f'<rect class="{cls}" x="{gx}" y="{baseline + 8}" width="{group_w}" height="{label_h}" rx="8" '
            f'fill="{fill}" stroke="{stroke}"{extra} />'
            f'<text class="{tcls}" x="{gx + group_w / 2}" y="{baseline + 30}" text-anchor="middle" '
            f'font-size="11" font-weight="600" fill="{color}">{esc(label)}</text>'
        )
        for j, (_name, rect_cls, fill, stroke, values) in enumerate(series):
            value = values[key]
            height = max(24, round(plot_h * float(value) / maximum)) if maximum else 24
            printed = f"{value:.1f}" if isinstance(value, float) else str(value)
            bx = gx + j * (bar_w + inner)
            by = baseline - height
            parts.append(
                f'<rect class="{rect_cls}" x="{bx}" y="{by}" width="{bar_w}" height="{height}" rx="8" '
                f'fill="{fill}" stroke="{stroke}" />'
                f'<text class="t-chip" x="{bx + bar_w / 2}" y="{by + 16}" text-anchor="middle" '
                f'font-size="11" fill="#4044ED">{esc(printed)}</text>'
            )
    height = baseline + 8 + label_h + 16
    return (
        '<figure class="diagram">'
        f'<svg viewBox="0 0 720 {height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{esc(aria)}">'
        + "".join(parts)
        + f'</svg><figcaption><span class="fig-no">图 {number}</span>{caption}</figcaption></figure>'
    )


METHODS = [
    ("baseline", "空白对照", "#62748E", 88),
    ("project", "项目记忆", "#4044ED", 88),
    ("wiki", "项目记忆+Wiki", "#0E9D88", 132),
    ("lookup", "自行检索", "#408DFC", 88),
    ("attr-tree", "属性树", "#AA75EF", 76),
    ("memos", "MemOS", "#D97706", 76),
    ("graphiti", "Graphiti", "#F1623D", 84),
]


def grouped_bars(groups, maximum, number, caption, aria, methods=None, max_bar=120):
    """groups is a list of (title, {arm: value}). Color is the method. Bars are paths so the
    fill stays saturated in both themes; the number sits in a pale badge above the bar."""
    methods = METHODS if methods is None else methods
    bar_w, bar_gap = 36, 12
    group_w = len(methods) * bar_w + (len(methods) - 1) * bar_gap
    group_gap = 24
    total_w = len(groups) * group_w + (len(groups) - 1) * group_gap
    x0 = (720 - total_w) / 2
    parts = []
    lx, ly = 16, 8
    for _arm, label, color, name_w in methods:
        if lx + 52 + name_w > 704:
            lx, ly = 16, ly + 40
        parts.append(
            f'<path class="edge" d="M {lx} {ly} L {lx + 40} {ly} L {lx + 40} {ly + 24} L {lx} {ly + 24} Z" '
            f'fill="{color}" stroke="{color}" />'
        )
        nx = lx + 52
        parts.append(
            f'<rect class="badge" x="{nx}" y="{ly}" width="{name_w}" height="24" rx="12" fill="#EEF0FF" stroke="none" />'
            f'<text class="t-chip" x="{nx + name_w / 2}" y="{ly + 16}" text-anchor="middle" font-size="11" fill="#4044ED">'
            f'{esc(label)}</text>'
        )
        lx = nx + name_w + 12
    title_y = ly + 40
    badge_h, badge_gap = 24, 8
    baseline = title_y + 28 + 12 + badge_h + badge_gap + max_bar
    for g, (title, values) in enumerate(groups):
        gx = x0 + g * (group_w + group_gap)
        title_w = min(group_w, max(88, 14 * len(title) + 28))
        parts.append(
            f'<rect class="badge" x="{gx + (group_w - title_w) / 2}" y="{title_y}" width="{title_w}" height="28" '
            f'rx="8" fill="#EEF0FF" stroke="none" />'
            f'<text class="t-chip" x="{gx + group_w / 2}" y="{title_y + 18}" text-anchor="middle" font-size="13" '
            f'font-weight="600" fill="#4044ED">{esc(title)}</text>'
        )
        for i, (arm, _label, color, _name_w) in enumerate(methods):
            value = values[arm]
            bar_h = max(12, round(max_bar * float(value) / maximum)) if maximum else 12
            bx = gx + i * (bar_w + bar_gap)
            by = baseline - bar_h
            parts.append(
                f'<path class="edge" d="M {bx:.1f} {by:.1f} L {bx + bar_w:.1f} {by:.1f} '
                f'L {bx + bar_w:.1f} {baseline:.1f} L {bx:.1f} {baseline:.1f} Z" fill="{color}" stroke="{color}" />'
            )
            printed = f"{value:.1f}" if isinstance(value, float) else str(value)
            ny = by - badge_gap - badge_h
            parts.append(
                f'<rect class="badge" x="{bx - 2:.1f}" y="{ny:.1f}" width="40" height="{badge_h}" rx="12" '
                f'fill="#EEF0FF" stroke="none" />'
                f'<text class="t-chip" x="{bx + bar_w / 2:.1f}" y="{ny + 16:.1f}" text-anchor="middle" font-size="11" '
                f'fill="#4044ED">{esc(printed)}</text>'
            )
    height = baseline + 16
    return (
        '<figure class="diagram">'
        f'<svg viewBox="0 0 720 {height:.0f}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{esc(aria)}">'
        + "".join(parts)
        + f'</svg><figcaption><span class="fig-no">图 {number}</span>{caption}</figcaption></figure>'
    )


def score_figure():
    recall_values = {arm: passed(recall[arm]) for arm, _label in ARMS}
    answer_values = {arm: passed(answer[arm]) for arm, _label in ARMS}
    return grouped_bars(
        [("召回", recall_values), ("模型回答", answer_values)],
        29, 1,
        "左边一组是题级召回，右边一组是 Memmy 中模型回答，满分 29。颜色是方式："
        "灰蓝是空白对照，靛蓝是项目记忆，青绿是项目记忆+Wiki。项目记忆是标注上限。"
        "Cursor 只评了三列，数字在下面的总表里。同一份代码重跑会翻约 6 题，差距小于这个数的两根柱不要比高低。",
        "左组是题级召回，右组是 Memmy 中模型回答，颜色区分七种方式",
    )


def ratio_figure():
    values = {arm: round(STATS[arm]["ratio"] * 1000) / 10 for arm, _label in ARMS}
    return grouped_bars(
        [("对应比例", values)],
        50, 3,
        "这一张只有一个数：含现行要点的条数，除以注入条数，再乘 100。颜色和文首那张相同，青绿是项目记忆+Wiki。"
        "项目记忆这一柱低，是因为每题都贴了整份现行结论。精确条数在下面的表里。",
        "七种方式的注入对应比例，按方式上色",
    )


def gap_figure():
    return grouped_bars(
        [
            ("仍答对", {arm: STATS[arm]["up"] for arm, _label in ARMS}),
            ("过了却答错", {arm: STATS[arm]["down"] for arm, _label in ARMS}),
        ],
        11, 5,
        "左边一组是题级没过、Memmy 回答过了的题数；右边一组是题级过了、回答没过的题数。颜色是方式。"
        "青绿是项目记忆+Wiki。Graphiti 的「仍答对」最高：旧句还在上下文里，模型自己放下了。0 也留一根短柱。",
        "题级召回和 Memmy 回答对不上的题数，左组仍答对，右组过了却答错",
    )


def cost_figure():
    by_label = {item["label"]: item for item in cost["rows"]}
    methods = [item for item in METHODS if item[0] in ("baseline", "project", "wiki")]
    keys = {"baseline": "空白对照记忆", "project": "项目记忆", "wiki": "项目记忆+Wiki 建页"}
    incoming = {arm: round(by_label[keys[arm]]["in"] / 1000) / 10 for arm, _l, _c, _w in methods}
    outgoing = {arm: round(by_label[keys[arm]]["out"] / 1000) / 10 for arm, _l, _c, _w in methods}
    ceiling = max(list(incoming.values()) + list(outgoing.values()))
    return grouped_bars(
        [("输入", incoming), ("输出", outgoing)],
        ceiling, 6,
        "左边一组是输入 token，右边一组是输出 token，单位是万，同一刻度。颜色和前面的图相同，青绿是项目记忆+Wiki 的建页。"
        "数字来自修复前的网关导出，不是这次重跑。建页的输出比项目记忆的写入还高。",
        "修复前写入的输入和输出 token，左组输入，右组输出",
        methods=methods,
    )


def _token_columns(groups, raw_in, raw_out, shown_in, shown_out, ceiling):
    bar_w, inner, group_gap = 56, 12, 28
    group_w = bar_w * 2 + inner
    total_w = len(groups) * group_w + (len(groups) - 1) * group_gap
    x0 = (720 - total_w) / 2
    plot_top, plot_h, label_h = 52, 150, 36
    baseline = plot_top + plot_h
    parts = []
    legend_x = 16
    for name, rect_cls, fill, stroke in (
        ("输入 token 万", "badge", "#EEF0FF", "none"),
        ("输出 token 万", "legend-box", "#FFFFFF", "#4044ED"),
    ):
        width = 132
        parts.append(
            f'<rect class="{rect_cls}" x="{legend_x}" y="8" width="{width}" height="24" rx="12" fill="{fill}" stroke="{stroke}" />'
            f'<text class="t-chip" x="{legend_x + width / 2}" y="24" text-anchor="middle" font-size="11" fill="#4044ED">{name}</text>'
        )
        legend_x += width + 16
    series = (
        ("in", "badge", "#EEF0FF", "none", raw_in, shown_in),
        ("out", "legend-box", "#FFFFFF", "#4044ED", raw_out, shown_out),
    )
    for i, (key, label) in enumerate(groups):
        gx = x0 + i * (group_w + group_gap)
        focus = key == "项目记忆"
        cls, tcls, color = ("node-focus", "t-focus", "#4044ED") if focus else ("badge", "t-chip", "#4044ED")
        stroke = "#4044ED" if focus else "none"
        fill = "#EEF0FF" if focus else "#FFFFFF"
        extra = ' stroke-width="1.5"' if focus else ""
        parts.append(
            f'<rect class="{cls}" x="{gx}" y="{baseline + 8}" width="{group_w}" height="{label_h}" rx="8" '
            f'fill="{fill}" stroke="{stroke}"{extra} />'
            f'<text class="{tcls}" x="{gx + group_w / 2}" y="{baseline + 30}" text-anchor="middle" '
            f'font-size="11" font-weight="600" fill="{color}">{esc(label)}</text>'
        )
        for j, (_name, rect_cls, fill, stroke, raw, shown) in enumerate(series):
            height = max(24, round(plot_h * raw[key] / ceiling))
            bx = gx + j * (bar_w + inner)
            by = baseline - height
            parts.append(
                f'<rect class="{rect_cls}" x="{bx}" y="{by}" width="{bar_w}" height="{height}" rx="8" '
                f'fill="{fill}" stroke="{stroke}" />'
                f'<text class="t-chip" x="{bx + bar_w / 2}" y="{by + 16}" text-anchor="middle" '
                f'font-size="11" fill="#4044ED">{shown[key]}</text>'
            )
    height = baseline + 8 + label_h + 16
    return (
        '<figure class="diagram">'
        f'<svg viewBox="0 0 720 {height}" xmlns="http://www.w3.org/2000/svg" role="img" '
        'aria-label="修复前那次写入的输入和输出 token，竖柱">'
        + "".join(parts)
        + '</svg><figcaption><span class="fig-no">图 6</span>左柱是输入，右柱是输出，单位是万 token，同一刻度。'
        '数字来自修复前的网关导出，不是这次重跑。Wiki 建页的输出比项目记忆的写入还高。</figcaption></figure>'
    )


SLICE_COLORS = [
    ("none", "答对", "#0E9D88", "#E7F7F3"),
    ("empty", "答不出", "#4044ED", "#EEF0FF"),
    ("superseded", "旧说法", "#DC2626", "#FEF2F2"),
    ("wrong_project", "别的项目", "#F1623D", "#FFF1EC"),
    ("other", "其他", "#D97706", "#FFFBEB"),
]


def _counts(data):
    counter = {key: 0 for key, _label, _pie, _chip in SLICE_COLORS}
    for question in data["questions"]:
        key = "none" if question.get("passed") else (question.get("errorType") or "other")
        if key not in counter:
            key = "other"
        counter[key] += 1
    return counter


def _wedge(cx, cy, radius, start, end, fill):
    large = 1 if end - start > _math.pi else 0
    x0 = cx + radius * _math.cos(start)
    y0 = cy + radius * _math.sin(start)
    x1 = cx + radius * _math.cos(end)
    y1 = cy + radius * _math.sin(end)
    return (
        f'<path class="edge" d="M {cx:.1f} {cy:.1f} L {x0:.1f} {y0:.1f} '
        f'A {radius} {radius} 0 {large} 1 {x1:.1f} {y1:.1f} Z" fill="{fill}" stroke="#FFFFFF" stroke-width="1" />'
    )


def pie_figure():
    names = {arm: label for arm, label, _color, _width in METHODS}
    pitch, radius = 180, 32
    rows = [[arm for arm, _label in ARMS[:4]], [arm for arm, _label in ARMS[4:]]]
    row_h = 280
    parts = []
    for r, arms in enumerate(rows):
        x0 = (720 - len(arms) * pitch) / 2
        top = 8 + r * row_h
        cy = top + 24 + 12 + radius
        legend_top = cy + radius + 14
        for i, arm in enumerate(arms):
            cx = x0 + i * pitch + pitch / 2
            name = names[arm]
            name_w = 148
            parts.append(
                f'<rect class="badge" x="{cx - name_w / 2}" y="{top}" width="{name_w}" height="24" rx="12" '
                f'fill="#EEF0FF" stroke="none" />'
                f'<text class="t-chip" x="{cx}" y="{top + 16}" text-anchor="middle" font-size="11" fill="#4044ED">'
                f'{esc(name)}</text>'
            )
            counts = _counts(answer[arm])
            slices = [(label, counts[key], pie, chip) for key, label, pie, chip in SLICE_COLORS if counts[key]]
            if len(slices) == 1:
                parts.append(
                    f'<path class="edge" d="M {cx:.1f} {cy - radius:.1f} '
                    f'A {radius} {radius} 0 1 1 {cx:.1f} {cy + radius:.1f} '
                    f'A {radius} {radius} 0 1 1 {cx:.1f} {cy - radius:.1f} Z" '
                    f'fill="{slices[0][2]}" stroke="{slices[0][2]}" />'
                )
            else:
                angle = -_math.pi / 2
                for _label, count, fill, _chip in slices:
                    sweep = 2 * _math.pi * count / 29
                    parts.append(_wedge(cx, cy, radius, angle, angle + sweep, fill))
                    angle += sweep
            for n, (label, count, fill, _chip) in enumerate(slices):
                by = legend_top + n * 36
                parts.append(
                    f'<path class="edge" d="M {cx - 62} {by} L {cx - 38} {by} L {cx - 38} {by + 24} L {cx - 62} {by + 24} Z" '
                    f'fill="{fill}" stroke="{fill}" />'
                    f'<rect class="badge" x="{cx - 26}" y="{by}" width="96" height="24" rx="12" fill="#EEF0FF" stroke="none" />'
                    f'<text class="t-chip" x="{cx + 22}" y="{by + 16}" text-anchor="middle" font-size="11" fill="#4044ED">'
                    f'{esc(label)} {count}</text>'
                )
    height = 8 + len(rows) * row_h
    return (
        '<figure class="diagram">'
        f'<svg viewBox="0 0 720 {height}" xmlns="http://www.w3.org/2000/svg" role="img" '
        'aria-label="七种方式的 Memmy 中模型回答错因构成">'
        + "".join(parts)
        + '</svg><figcaption><span class="fig-no">图 4</span>每张饼是 29 题。青绿是答对，靛蓝是答不出，红是把旧说法当现行，'
        '橙是用了别的项目，琥珀是其他。其他不是同一种错，每一题的具体错法写在表下面。</figcaption></figure>'
    )


# ---- tables ------------------------------------------------------------------------------------

def main_table():
    what = {
        "baseline": "原始 Memmy，只多一处价格过滤修正",
        "project": "项目归一、作用域系数，加金标写的现行结论",
        "wiki": "项目记忆之上，再读当前项目 wiki 的前两页",
        "lookup": "不注入正文，模型用工具查 L1",
        "attr-tree": "空白对照的召回，按文件树重排注入",
        "memos": "空白对照的召回，叶子只在明确更正时替换",
        "graphiti": "空白对照的召回，按事实边的生效时间取舍",
    }
    rows = []
    for arm, label in ARMS:
        c = cursor.get(arm)
        rows.append((arm, [esc(label), score(recall[arm]), score(answer[arm]), score(c) if c else "未评", esc(what[arm])]))
    return table(["方式", "直接召回", "Memmy 回答", "Cursor 回答", "~做了什么"], rows, ours="project")


def kind_table(source, arm_list):
    rows = []
    for arm, label in arm_list:
        data = source[arm]
        cells = [esc(label)]
        for kind, _ in KINDS:
            group = [q for q in data["questions"] if q.get("kind") == kind]
            cells.append(f"{sum(1 for q in group if q.get('passed'))}/{len(group)}" if group else "—")
        rows.append((arm, cells))
    head = ["方式"] + [f"{name}（{sum(1 for q in recall['baseline']['questions'] if q['kind'] == kind)}）" for kind, name in KINDS]
    return table(head, rows, ours="project")


def error_table():
    rows = []
    for arm, label in ARMS:
        counter = Counter()
        for q in answer[arm]["questions"]:
            key = "none" if q.get("passed") else (q.get("errorType") or "other")
            counter[key if key in ("none", "empty", "superseded", "wrong_project") else "other"] += 1
        rows.append((arm, [esc(label)] + [str(counter.get(key, 0)) for key, _ in ERRORS]))
    return table(["方式"] + [name for _, name in ERRORS], rows, ours="project")


def fix_table():
    def line(key, label, rb, ra, ab, aa):
        recall_cell = f"{score(rb)} → {score(ra)}" if rb else "—"
        recall_flip = str(len(flips(rb, ra))) if rb else "—"
        return (key, [esc(label), recall_cell, recall_flip, f"{score(ab)} → {score(aa)}", str(len(flips(ab, aa)))])
    rows = [
        line("baseline", "空白对照（代码没改）", before["recall"]["baseline"], recall["baseline"],
             before["answer"]["baseline"], answer["baseline"]),
        line("project", "项目记忆（标注上限）", before["recall"]["project"], recall["project"],
             before["answer"]["project"], answer["project"]),
        line("cursor", "项目记忆 · Cursor 回答", None, None, before["cursor"], cursor["project"]),
        line("wiki", "项目记忆+Wiki", before["recall"]["wiki"], recall["wiki"], before["answer"]["wiki"], answer["wiki"]),
        line("lookup", "自行检索", before["recall"]["lookup"], recall["lookup"], before["answer"]["lookup"], answer["lookup"]),
    ]
    return table(["方式", "召回 修复前 → 后", "召回翻转", "回答 修复前 → 后", "回答翻转"], rows, ours="project")


def cost_table():
    rows, rows2 = [], []
    for item in cost["rows"]:
        rows.append((item["label"], [esc(item["label"]), str(item["wall"]), str(item["n"]),
                                     f"{item['in']:,}", f"{item['out']:,}", f"{item['usd']:.3f}"]))
        rows2.append((item["label"], [esc(item["label"]), f"{item['p50'] / 1000:.1f}", f"{item['p95'] / 1000:.1f}",
                                      f"{item['cache']:,}", esc(item["note"])]))
    return (table(["阶段", "墙钟秒", "请求数", "输入 token", "输出 token", "费用 USD"], rows, ours="项目记忆")
            + table(["阶段", "单次 P50 秒", "单次 P95 秒", "缓存读取 token", "~对账"], rows2, ours="项目记忆"))


def volume_table():
    rows = []
    for arm, label in ARMS:
        item = STATS[arm]
        rows.append((arm, [esc(label), str(item["items"]), str(item["hits"]),
                           f"{item['ratio'] * 100:.1f}%", f"{item['cover']}/29", score(recall[arm])]))
    return table(["方式", "注入条数", "含要点的条", "对应比例", "要点覆盖", "题级召回"], rows, ours="project")


def volume_question_tables():
    ids = [q["id"] for q in recall["baseline"]["questions"]]
    kinds = {q["id"]: q["kind"] for q in recall["baseline"]["questions"]}
    first_arms = ("baseline", "project", "wiki", "lookup")
    second_arms = ("attr-tree", "memos", "graphiti")
    first = [(qid, [qid, esc(KIND_LABEL[kinds[qid]])] + [esc(VOLUME_CELLS[qid][arm]) for arm in first_arms]) for qid in ids]
    second = [(qid, [qid, esc(KIND_LABEL[kinds[qid]])] + [esc(VOLUME_CELLS[qid][arm]) for arm in second_arms]) for qid in ids]
    return (table(["~题", "~题型", "~空白对照", "~项目记忆", "~Wiki", "~自行检索"], first)
            + table(["~题", "~题型", "~属性树", "~MemOS", "~Graphiti"], second))


def replay_table():
    def row(key, label, calls, seconds, scope):
        return (key, [esc(label), str(calls), str(seconds), esc(scope)])
    wiki = recall["wiki"]
    lookup_run = answer["lookup"]
    memos, graphiti = recall["memos"], recall["graphiti"]
    rows = [
        row("baseline", "空白对照", recall["baseline"]["modelCalls"], recall["baseline"]["seconds"], "回放和召回，不含回答"),
        row("project", "项目记忆", recall["project"]["modelCalls"], recall["project"]["seconds"], "回放和召回，不含回答"),
        row("wiki", "项目记忆+Wiki", wiki["modelCalls"], wiki["seconds"], "建页和读页，不含回答"),
        row("lookup", "自行检索", lookup_run["modelCalls"] + lookup_run["judgeCalls"], lookup_run["seconds"],
            f"检索 {lookup_run['modelCalls']} 次，裁判 {lookup_run['judgeCalls']} 次"),
        row("attr-tree", "属性树", recall["attr-tree"]["modelCalls"], recall["attr-tree"]["seconds"], "回放和召回，不含回答"),
        row("memos", "MemOS 叶子合并", memos["modelCalls"] + memos["treeModelCalls"], memos["seconds"],
            f"回放 {memos['modelCalls']} 次，叶子整理 {memos['treeModelCalls']} 次"),
        row("graphiti", "Graphiti 事实边", graphiti["modelCalls"] + graphiti["treeModelCalls"], graphiti["seconds"],
            f"回放 {graphiti['modelCalls']} 次，事实边 {graphiti['treeModelCalls']} 次"),
    ]
    return table(["方式", "模型调用", "墙钟秒", "~这次量的是哪一段"], rows, ours="project")


def mark(q):
    return "过" if q and q.get("passed") else "不过"


def question_tables():
    ids = [q["id"] for q in recall["baseline"]["questions"]]
    kinds = {q["id"]: q["kind"] for q in recall["baseline"]["questions"]}

    def cells(arm, qid):
        return f"召回{mark(by_id(recall[arm]).get(qid))} · 回答{mark(by_id(answer[arm]).get(qid))}"

    first = [(qid, [qid, esc(KIND_LABEL[kinds[qid]])] + [cells(arm, qid) for arm in ("baseline", "project", "wiki", "lookup")])
             for qid in ids]
    second = [(qid, [qid, esc(KIND_LABEL[kinds[qid]])] + [cells(arm, qid) for arm in ("attr-tree", "memos", "graphiti")]
               + [f"回答{mark(by_id(cursor['project']).get(qid))}"]) for qid in ids]
    head1 = ["~题", "~题型", "~空白对照", "~项目记忆", "~项目记忆+Wiki", "~自行检索"]
    head2 = ["~题", "~题型", "~属性树", "~MemOS", "~Graphiti", "~Cursor · 项目记忆"]
    return table(head1, first) + table(head2, second)


def failure_details():
    blocks = []
    sources = [(f"{label} · Memmy 回答", answer[arm]) for arm, label in ARMS]
    sources += [(f"{label} · Cursor 回答", cursor[arm]) for arm, label in CURSOR_ARMS]
    for title, data in sources:
        rows = [(q["id"], [q["id"], esc(KIND_LABEL.get(q.get("kind"), q.get("kind"))),
                           esc(ERROR_LABEL.get(q.get("errorType"), "其他")), esc(q.get("reason"))])
                for q in data["questions"] if not q.get("passed")]
        inner = table(["~题", "~题型", "~错因", "~裁判理由"], rows) if rows else "<p>没有错题。</p>"
        blocks.append(f"<details><summary>{esc(title)}：错 {len(rows)} 题</summary>"
                      f"<div class='details-body'>{inner}</div></details>")
    return "".join(blocks)


def clip(text, limit=110):
    text = " ".join((text or "").replace("**", "").replace("`", "").split())
    return text if len(text) <= limit else text[:limit].rstrip("，。、；： ") + "……"


def case(qid):
    base = by_id(recall["baseline"])[qid]
    rows = []
    for arm, label in (("baseline", "空白对照"), ("project", "项目记忆")):
        q = by_id(answer[arm])[qid]
        rows.append((arm, [esc(label), mark(by_id(recall[arm])[qid]), mark(q), esc(clip(q.get("answer")))]))
    q = by_id(cursor["project"])[qid]
    rows.append(("cursor", ["Cursor · 项目记忆", "—", mark(q), esc(clip(q.get("answer")))]))
    must = "、".join(f"「{p}」" for p in base["mustInclude"])
    trap = "、".join(f"「{p}」" for p in base["mustNotInclude"]) or "无"
    return (f"<p><strong>{qid} · {esc(KIND_LABEL[base['kind']])}</strong>　{esc(base['question'])}"
            f"<br>现行要点 {esc(must)}；陷阱 {esc(trap)}。</p>"
            + table(["~方式", "~召回", "~回答", "~回答原文（截断）"], rows))


# ---- tokens ------------------------------------------------------------------------------------

tokens = {
    "PIPELINE": pipeline_figure(),
    "SCORES": score_figure(),
    "VOLUME_FIG": ratio_figure(),
    "PIES": pie_figure(),
    "VOLUME": volume_table(),
    "GAP_FIG": gap_figure(),
    "COST_FIG": cost_figure(),
    "REPLAY": replay_table(),
    "VOLUME_Q": volume_question_tables(),
    "MAIN_TABLE": main_table(),
    "KIND_RECALL": kind_table(recall, ARMS),
    "KIND_ANSWER": kind_table(answer, ARMS),
    "KIND_CURSOR": kind_table(cursor, CURSOR_ARMS),
    "ERRORS": error_table(),
    "FIX_TABLE": fix_table(),
    "COST": cost_table(),
    "QTABLES": question_tables(),
    "FAILURES": failure_details(),
    "INGESTED": str(len(recall["project"].get("ingested") or [])),
    "MODEL": esc(recall["project"].get("model")),
    "CALLS_B": str(recall["baseline"].get("modelCalls")),
    "CALLS_P": str(recall["project"].get("modelCalls")),
    "SEC_B": str(recall["baseline"].get("seconds")),
    "SEC_P": str(recall["project"].get("seconds")),
    "W1": f"{recall['wiki']['variantCounts']['read1']}/{total(recall['wiki'])}",
    "W3": f"{recall['wiki']['variantCounts']['read3']}/{total(recall['wiki'])}",
    "FLIP_B": str(len(flips(before["answer"]["baseline"], answer["baseline"]))),
    "VOL_P_ITEMS": str(STATS["project"]["items"]),
    "VOL_P_HIT": str(STATS["project"]["hits"]),
    "VOL_P_PCT": f"{STATS['project']['ratio'] * 100:.1f}%",
    "VOL_P_BULLETS": str(STATS["project"]["bullets"]),
    "VOL_P_BULLET20": str(STATS["project"]["bullet20"]),
    "VOL_P_COVER": f"{STATS['project']['cover']}/29",
    "VOL_B_PCT": f"{STATS['baseline']['ratio'] * 100:.1f}%",
    "VOL_B_MEAN": f"{STATS['baseline']['mean']:.1f}",
    "VOL_B_NONE": str(STATS["baseline"]["no_phrase"]),
    "VOL_B_TRAP": str(STATS["baseline"]["trap_q"]),
    "VOL_B_TRAP_OK": str(STATS["baseline"]["trap_answered"]),
    "VOL_G_COVER": f"{STATS['graphiti']['cover']}/29",
    "VOL_G_MEAN": f"{STATS['graphiti']['mean']:.1f}",
    "VOL_G_PCT": f"{STATS['graphiti']['ratio'] * 100:.1f}%",
    "VOL_G_TRAP": str(STATS["graphiti"]["trap_q"]),
    "VOL_G_TRAP_OK": str(STATS["graphiti"]["trap_answered"]),
    "VOL_W_COVER": f"{STATS['wiki']['cover']}/29",
    "VOL_W_ITEMS": str(STATS["wiki"]["items"]),
    "VOL_W_TRAP": str(STATS["wiki"]["trap_q"]),
    "VOL_W_TRAP_OK": str(STATS["wiki"]["trap_answered"]),
    "VOL_L_ITEMS": str(STATS["lookup"]["items"]),
    "VOL_L_HIT": str(STATS["lookup"]["hits"]),
    "VOL_L_PCT": f"{STATS['lookup']['ratio'] * 100:.1f}%",
    "VOL_L_COVER": f"{STATS['lookup']['cover']}/29",
}
for arm, _ in ARMS:
    key = arm.replace("-", "").upper()
    tokens[f"R_{key}"] = score(recall[arm])
    tokens[f"A_{key}"] = score(answer[arm])
for arm, _ in CURSOR_ARMS:
    tokens[f"C_{arm.replace('-', '').upper()}"] = score(cursor[arm])
for qid in ("q19", "q09", "q25", "q14", "q20"):
    tokens[f"CASE_{qid.upper()}"] = case(qid)

body = body_path.read_text()
for key, value in tokens.items():
    body = body.replace(f"@@{key}@@", value)
left = [part.split("@@")[0] for part in body.split("@@")[1::2]]
if left:
    raise SystemExit(f"unfilled tokens: {sorted(set(left))}")

nav_items = [("s1", "01", "结论"), ("s2", "02", "怎么测"), ("s3", "03", "结果"), ("s4", "04", "修复前后"),
             ("s5", "05", "召回与回答"), ("s6", "06", "案例"), ("s7", "07", "没解决的"), ("s8", "08", "写入开销"),
             ("appendix", "A", "附录")]
current = ' aria-current="true"'
nav = ('<nav class="toc" aria-label="目录">\n      <p class="toc-brand"><span class="toc-org">MemTensor</span>'
       '<span class="toc-kind">研究文档</span></p>\n'
       + "\n".join(f'      <a href="#{sid}"{current if i == 0 else ""}><span class="toc-no">{no}</span>{name}</a>'
                   for i, (sid, no, name) in enumerate(nav_items))
       + "\n    </nav>\n\n    <main>\n")

shell = template_path.read_text() if template_path.exists() else out.read_text()
head, rest = shell.split('<nav class="toc"', 1)
_, tail = rest.split("</main>", 1)
head = head.replace("<title>研究文档模板</title>", "<title>项目记忆先行开发评测报告</title>")
out.write_text(head + nav + body + "\n    </main>" + tail)
print("wrote", out.relative_to(here.parent.parent))

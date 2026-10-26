"""Render eval/project-memory/项目记忆report.html from the committed run files.

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
out = here / "项目记忆report.html"
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
    ("ambiguous", "相似信息没选"),
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


def pctcell(data):
    return f"<span class='nw'>{pct(data)}% · {passed(data)}/{total(data)}</span>" if data else "—"


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


W = 720
LABEL_X, PLOT_X0, PLOT_X1, VAL_X = 120, 132, 588, 704

CHART_CSS = """
    /* 图表：横向条形。所有比较都按百分比，绝对数写在表里。 */
    .diagram .grid { stroke: var(--d-group-line); stroke-width: 1; }
    .diagram .ax { fill: var(--d-sub); font-size: 11px; font-family: var(--font-mono); }
    .diagram .mlabel { fill: var(--d-title); font-size: 12.5px; font-weight: 600; }
    .diagram .gtitle { fill: var(--d-title); font-size: 13px; font-weight: 600; }
    .diagram .vl { fill: var(--d-sub); font-size: 11.5px; font-family: var(--font-mono); }
    .diagram .seg-in { fill: light-dark(#FFFFFF, #0B1020); font-size: 11px; font-family: var(--font-mono); font-weight: 600; }
    .diagram .fill-a { fill: light-dark(#4044ED, #7275F7); }
    .diagram .fill-b { fill: light-dark(#0E9D88, #5CBFAE); }
    .diagram .fill-c { fill: light-dark(#D97706, #FBBF24); }
    .diagram .fill-d { fill: light-dark(#DC2626, #F87171); }
    .diagram .fill-e { fill: light-dark(#F1623D, #FB8A6B); }
    .diagram .fill-f { fill: light-dark(#62748E, #90A1B9); }
    .diagram .fill-g { fill: light-dark(#AA75EF, #BFA0F5); }
    .diagram .fill-dim { opacity: 0.4; }
    .nw { white-space: nowrap; }
"""


def _ticks(x_max):
    step = x_max / 4
    return [round(step * i, 1) for i in range(5)]


def _tick_text(value):
    return f"{value:g}%"


def _legend(series, y=10):
    """series: (name, cls). Chips left to right, wrapping is not needed for <= 6 items."""
    parts, x = [], 16
    for name, cls in series:
        width = 30 + 13 * len(name)
        parts.append(f'<rect class="{cls}" x="{x}" y="{y}" width="10" height="10" rx="2" />')
        parts.append(f'<text class="ax" x="{x + 16}" y="{y + 9.5}">{esc(name)}</text>')
        x += width
    return "".join(parts)


def _grid(y_top, y_bottom, x_max):
    parts = []
    for tick in _ticks(x_max):
        x = PLOT_X0 + (PLOT_X1 - PLOT_X0) * tick / x_max
        cls = "edge-main" if tick == 0 else "grid"
        parts.append(f'<line class="{cls}" x1="{x:.1f}" y1="{y_top}" x2="{x:.1f}" y2="{y_bottom}" />')
        parts.append(f'<text class="ax" x="{x:.1f}" y="{y_bottom + 17}" text-anchor="middle">{_tick_text(tick)}</text>')
    return "".join(parts)


def hbar_figure(rows, series, number, caption, aria, x_max=100.0, bar_h=17):
    """rows: [(label, {key: (raw value, printed text)})]. series: [(key, name, css class)]."""
    legend = [(name, cls) for _key, name, cls in series]
    bar_gap, group_gap, head_h = 4, 18, 40
    y = head_h
    laid = []
    for label, values in rows:
        height = len(series) * bar_h + (len(series) - 1) * bar_gap
        laid.append((label, values, y, height))
        y += height + group_gap
    bottom = y - group_gap
    parts = [_legend(legend), _grid(head_h - 4, bottom, x_max)]
    for label, values, gy, gh in laid:
        parts.append(f'<text class="mlabel" x="{LABEL_X}" y="{gy + gh / 2 + 4.5}" text-anchor="end">{esc(label)}</text>')
        for j, (key, _name, cls) in enumerate(series):
            raw, text = values[key]
            by = gy + j * (bar_h + bar_gap)
            width = (PLOT_X1 - PLOT_X0) * float(raw) / x_max
            parts.append(f'<rect class="{cls}" x="{PLOT_X0}" y="{by:.1f}" width="{max(width, 1.5):.1f}" '
                         f'height="{bar_h}" rx="3" />')
            parts.append(f'<text class="vl" x="{VAL_X}" y="{by + bar_h - 4.5:.1f}" text-anchor="end">{esc(text)}</text>')
    height = bottom + 34
    return (
        '<figure class="diagram">'
        f'<svg viewBox="0 0 {W} {height:.0f}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{esc(aria)}">'
        + "".join(parts)
        + f'</svg><figcaption><span class="fig-no">图 {number}</span>{caption}</figcaption></figure>'
    )


def stacked_figure(rows, series, number, caption, aria, bar_h=20, note_col=True):
    """rows: [(label, [(key, (share percent, text)), ...], total text)]. Shares sum to 100."""
    legend = [(name, cls) for _key, name, cls in series]
    head_h, gap = 40, 14
    y = head_h
    parts = [_legend(legend)]
    for label, segments, total in rows:
        parts.append(f'<text class="mlabel" x="{LABEL_X}" y="{y + bar_h / 2 + 4.5}" text-anchor="end">{esc(label)}</text>')
        x = PLOT_X0
        span = PLOT_X1 - PLOT_X0
        for key, (share, text) in segments:
            width = span * share / 100
            cls = dict((k, c) for k, _n, c in series)[key]
            if width <= 0:
                continue
            parts.append(f'<rect class="{cls}" x="{x:.1f}" y="{y}" width="{width:.1f}" height="{bar_h}" />')
            if width >= 30:
                parts.append(f'<text class="seg-in" x="{x + width / 2:.1f}" y="{y + bar_h / 2 + 4:.1f}" '
                             f'text-anchor="middle">{esc(text)}</text>')
            x += width
        if note_col:
            parts.append(f'<text class="vl" x="{VAL_X}" y="{y + bar_h / 2 + 4:.1f}" text-anchor="end">{esc(total)}</text>')
        y += bar_h + gap
    height = y - gap + 20
    return (
        '<figure class="diagram">'
        f'<svg viewBox="0 0 {W} {height:.0f}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{esc(aria)}">'
        + "".join(parts)
        + f'</svg><figcaption><span class="fig-no">图 {number}</span>{caption}</figcaption></figure>'
    )


def _pct(part, whole):
    return 100.0 * part / whole


def _label(part, whole, digits=0):
    return f"{_pct(part, whole):.{digits}f}% · {part}/{whole}"


def score_figure():
    rows = []
    for arm, label in ARMS:
        rows.append((SHORT[arm], {
            "recall": (_pct(passed(recall[arm]), total(recall[arm])), _label(passed(recall[arm]), total(recall[arm]))),
            "answer": (_pct(passed(answer[arm]), total(answer[arm])), _label(passed(answer[arm]), total(answer[arm]))),
        }))
    return hbar_figure(
        rows,
        [("recall", "直接召回", "fill-a"), ("answer", "Memmy 中模型回答", "fill-b")],
        1,
        "每行一种方式，组内上条是题级召回、下条是 Memmy 中模型回答；横轴是按 29 题算的通过比例，条尾是百分比和题数。"
        "项目记忆的现行结论由评测脚本按金标写入，这一行只能当上限看；Cursor 只评了三种方式，不在图里。",
        "七种方式的题级召回与 Memmy 中模型回答通过率",
    )


def ratio_figure():
    rows = []
    for arm, label in ARMS:
        item = STATS[arm]
        rows.append((SHORT[arm], {
            "hit": (item["ratio"] * 100, f"{item['ratio'] * 100:.1f}% · {item['hits']}/{item['items']}"),
            "cover": (_pct(item["cover"], 29), _label(item["cover"], 29)),
        }))
    return hbar_figure(
        rows,
        [("hit", "注入里含要点的条", "fill-a"), ("cover", "上下文里有要点的题", "fill-b")],
        3,
        "上条是含现行要点的条数除以注入条数，下条是上下文里出现过现行要点的题数除以 29。"
        "两条都不是题级召回：题级还要求一条陷阱原句都不剩。",
        "七种方式的注入条命中比例与要点覆盖比例",
    )


def gap_figure():
    rows = []
    for arm, label in ARMS:
        item = STATS[arm]
        rows.append((SHORT[arm], {
            "up": (_pct(item["up"], 29), f"{item['up']} 题"),
            "down": (_pct(item["down"], 29), f"{item['down']} 题"),
        }))
    return hbar_figure(
        rows,
        [("up", "召回没过、回答过了", "fill-c"), ("down", "召回过了、回答没过", "fill-d")],
        5,
        "横轴是占 29 题的比例，条尾是题数。橙色这类是上下文里同时有旧句和要点、模型自己挑对了；"
        "红色这类是上下文里有现行要点、模型却没答好。",
        "题级召回与模型回答不一致的题数占比",
        x_max=50,
    )


ERROR_SERIES = [
    ("none", "答对", "fill-b"),
    ("empty", "答不出", "fill-a"),
    ("superseded", "把旧说法当现行", "fill-d"),
    ("ambiguous", "相似信息没选", "fill-c"),
    ("wrong_project", "用了别的项目", "fill-e"),
    ("other", "其他", "fill-f"),
]


def error_figure():
    rows = []
    for arm, label in ARMS:
        counter = Counter()
        for q in answer[arm]["questions"]:
            key = "none" if q.get("passed") else (q.get("errorType") or "other")
            counter[key if key in dict((k, n) for k, n, _c in ERROR_SERIES) else "other"] += 1
        segments = [(key, (_pct(counter[key], 29), f"{round(_pct(counter[key], 29))}%"))
                    for key, _name, _cls in ERROR_SERIES if counter[key]]
        rows.append((SHORT[arm], segments, f"{passed(answer[arm])}/29"))
    return stacked_figure(
        rows,
        ERROR_SERIES,
        4,
        "每一条是一个方式的 29 题怎么分布的，段宽是百分比。右列是通过题数。"
        "「其他」不是一种错，下面按题写开。",
        "七种方式的回答结果与错因构成",
    )


def cost_figure():
    by_label = {item["label"]: item for item in cost["rows"]}
    base, proj, wiki = (by_label["空白对照记忆"], by_label["项目记忆"], by_label["项目记忆+Wiki 建页"])
    series = [("baseline", "空白对照", "fill-f"), ("project", "项目记忆", "fill-a"), ("wiki", "Wiki 建页", "fill-b")]

    def row(name, pick):
        return (name, {key: (_pct(pick(data), pick(base)), f"{_pct(pick(data), pick(base)):.0f}%")
                       for key, _n, _c, data in (("baseline", "", "", base), ("project", "", "", proj), ("wiki", "", "", wiki))})

    rows = [row("费用", lambda d: d["usd"]),
            row("输入 token", lambda d: d["in"]),
            row("输出 token", lambda d: d["out"]),
            row("写入墙钟", lambda d: d["wall"]),
            row("单次 P50", lambda d: d["p50"])]
    return hbar_figure(
        rows,
        series,
        6,
        "以空白对照的写入为 100%，越短越省，绝对数在下面两张表里。Wiki 建页是叠在项目记忆写入之上的增量，"
        "用 Wiki 的总开销是蓝条加青条。数据来自修复前那一轮的网关用量导出，不是这次重跑。",
        "写入阶段的输入、输出 token、墙钟和单次 P50，相对空白对照的百分比",
        x_max=200,
    )


def runtime_figure():
    order = [("baseline", "空白对照"), ("project", "项目记忆"), ("wiki", "项目记忆+Wiki"),
             ("attr-tree", "属性树"), ("memos", "MemOS"), ("graphiti", "Graphiti")]
    base = recall["baseline"]["seconds"]
    base_calls = recall["baseline"]["modelCalls"]
    rows = []
    for arm, label in order:
        data = recall[arm]
        rows.append((label, {
            "wall": (_pct(data["seconds"], base), f"{_pct(data['seconds'], base):.0f}% · {data['seconds']} 秒"),
            "calls": (_pct(data["modelCalls"] + (data.get("treeModelCalls") or 0), base_calls),
                      f"{data['modelCalls'] + (data.get('treeModelCalls') or 0)} 次"),
        }))
    return hbar_figure(
        rows,
        [("wall", "回放与召回墙钟（空白对照为 100%）", "fill-a"), ("calls", "模型调用次数（占 92 次）", "fill-b")],
        7,
        "这六行量的是同一段：回放语料加召回，不含模型回答与裁判。自行检索的 712 秒把作答和裁判也算在里面，"
        "不同段，没放进图里。MemOS 和 Graphiti 共用一次回放，所以两条墙钟相同。",
        "回放与召回的墙钟和模型调用次数",
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
        rows.append((arm, [esc(label), pctcell(recall[arm]), pctcell(answer[arm]),
                           pctcell(c) if c else "未评", esc(what[arm])]))
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
            counter[key if key in ("none", "empty", "superseded", "ambiguous", "wrong_project") else "other"] += 1
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


def overview_table():
    """One row per arm: effect, cost, runtime. Cost comes from the pre-fix gateway export."""
    by_label = {item["label"]: item for item in cost["rows"]}
    cost_of = {"baseline": by_label["空白对照记忆"], "project": by_label["项目记忆"],
               "wiki": by_label["项目记忆+Wiki 建页"]}
    rows = []
    for arm, label in ARMS:
        r, a = recall[arm], answer[arm]
        c = cursor.get(arm)
        item = cost_of.get(arm)
        cost_cell = (f"+${item['usd']:.3f}" if arm == "wiki" else f"${item['usd']:.3f}") if item else "—"
        token_cell = f"{item['in'] / 1000:.0f}k / {item['out'] / 1000:.0f}k" if item else "—"
        wall = f"{r['seconds']} 秒" if r.get("seconds") else "—"
        rows.append((arm, [
            esc(label),
            pctcell(r),
            pctcell(a),
            pctcell(c) if c else "未评",
            wall,
            cost_cell,
            token_cell,
        ]))
    return table(["方式", "题级召回", "Memmy 回答", "Cursor 回答", "回放+召回墙钟",
                  "写入费用", "写入 token 入/出"], rows, ours="project")


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
    return "<span class='nw'>过</span>" if q and q.get("passed") else "<span class='nw'>不过</span>"


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
    "ERROR_FIG": error_figure(),
    "RUNTIME_FIG": runtime_figure(),
    "VOLUME": volume_table(),
    "GAP_FIG": gap_figure(),
    "COST_FIG": cost_figure(),
    "REPLAY": replay_table(),
    "VOLUME_Q": volume_question_tables(),
    "MAIN_TABLE": main_table(),
    "OVERVIEW": overview_table(),
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
for arm, _ in ARMS:
    key = arm.replace("-", "").upper()
    tokens[f"PCT_R_{key}"] = f"{pct(recall[arm])}%"
    tokens[f"PCT_A_{key}"] = f"{pct(answer[arm])}%"
for arm, _ in CURSOR_ARMS:
    tokens[f"PCT_C_{arm.replace('-', '').upper()}"] = f"{pct(cursor[arm])}%"
tokens.update({
    "FLIP_PR": str(len(flips(before["recall"]["project"], recall["project"]))),
    "FLIP_P": str(len(flips(before["answer"]["project"], answer["project"]))),
    "FLIP_WR": str(len(flips(before["recall"]["wiki"], recall["wiki"]))),
    "FLIP_W": str(len(flips(before["answer"]["wiki"], answer["wiki"]))),
    "FLIP_L": str(len(flips(before["answer"]["lookup"], answer["lookup"]))),
    "FLIP_LR": str(len(flips(before["recall"]["lookup"], recall["lookup"]))),
    "FLIP_C": str(len(flips(before["cursor"], cursor["project"]))),
    "FLIP_BR": str(len(flips(before["recall"]["baseline"], recall["baseline"]))),
    "PASS_B_BEFORE": score(before["answer"]["baseline"]),
    "PASS_P_BEFORE": score(before["answer"]["project"]),
    "PASS_B_AFTER": score(answer["baseline"]),
    "PASS_P_AFTER": score(answer["project"]),
    "COST_B_USD": f"{cost['rows'][0]['usd']:.3f}",
    "COST_P_USD": f"{cost['rows'][1]['usd']:.3f}",
    "COST_W_USD": f"{cost['rows'][2]['usd']:.3f}",
    "COST_B_IN": f"{cost['rows'][0]['in'] / 1000:.1f}",
    "COST_P_IN": f"{cost['rows'][1]['in'] / 1000:.1f}",
    "COST_B_OUT": f"{cost['rows'][0]['out'] / 1000:.1f}",
    "COST_P_OUT": f"{cost['rows'][1]['out'] / 1000:.1f}",
    "COST_W_OUT": f"{cost['rows'][2]['out'] / 1000:.1f}",
    "COST_B_WALL": str(cost["rows"][0]["wall"]),
    "COST_P_WALL": str(cost["rows"][1]["wall"]),
    "COST_W_WALL": str(cost["rows"][2]["wall"]),
    "COST_W_CALLS": str(cost["rows"][2]["n"]),
    "SEC_L": str(answer["lookup"]["seconds"]),
    "SEC_W": str(recall["wiki"]["seconds"]),
    "SEC_AT": str(recall["attr-tree"]["seconds"]),
    "SEC_G": str(recall["graphiti"]["seconds"]),
    "CALLS_W": str(recall["wiki"]["modelCalls"]),
    "CALLS_L": str(answer["lookup"]["modelCalls"]),
    "CALLS_G": str(recall["graphiti"]["modelCalls"] + recall["graphiti"]["treeModelCalls"]),
    "CALLS_AT": str(recall["attr-tree"]["modelCalls"]),
})
for qid in ("q19", "q09", "q25", "q14", "q20"):
    tokens[f"CASE_{qid.upper()}"] = case(qid)

body = body_path.read_text()
for key, value in tokens.items():
    body = body.replace(f"@@{key}@@", value)
left = [part.split("@@")[0] for part in body.split("@@")[1::2]]
if left:
    raise SystemExit(f"unfilled tokens: {sorted(set(left))}")

nav_items = [("s1", "01", "结论"), ("s2", "02", "怎么测"), ("s3", "03", "结果"), ("s4", "04", "召回与回答"),
             ("s5", "05", "修复前后"), ("s6", "06", "案例"), ("s7", "07", "开销与时长"),
             ("s8", "08", "没解决的"), ("appendix", "A", "附录")]
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
if ".diagram .vl" not in head:
    head = head.replace("  </style>", CHART_CSS + "  </style>", 1)
out.write_text(head + nav + body + "\n    </main>" + tail)
print("wrote", out.relative_to(here.parent.parent))

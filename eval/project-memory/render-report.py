"""Render eval/project-memory/report.html from the committed run files.

Usage: python3 eval/project-memory/render-report.py

The page shell comes from the studio template ($MEMTENSOR_TEMPLATE, default
~/memtensor/templates/explainer.html). Without it, the shell of the existing
report.html is reused, so the report still renders on a machine without the studio.
"""

import html
import json
import os
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
        + '</svg><figcaption><span class="fig-no">图 1</span>七种方式共用同一条回放链路，各自只改一步。'
        '红框是这次复盘最要紧的一点：项目记忆的现行结论不是产品写的，是评测脚本按金标写的。</figcaption></figure>'
    )


def score_figure():
    rows = [arm for arm, _ in ARMS]
    label_w, bar_x, bar_max = 168, 204, 496
    top, bar_h, inner, row_gap = 16, 24, 20, 20
    row_h = bar_h * 2 + inner
    parts = []
    for i, arm in enumerate(rows):
        y = top + i * (row_h + row_gap)
        cls, tcls = ("node-focus", "t-focus") if arm == "project" else ("node", "t-title")
        parts.append(node(cls, 16, y, label_w, row_h, LABEL[arm], None, tcls))
        for j, (kind, data, rect_cls, fill, stroke) in enumerate((
            ("召回", recall[arm], "badge", "#EEF0FF", "none"),
            ("回答", answer[arm], "badge", "#FFFFFF", "#D8DAFB"),
        )):
            by = y + j * (bar_h + inner)
            width = max(120, round(bar_max * passed(data) / total(data)))
            parts.append(f'<rect class="{rect_cls}" x="{bar_x}" y="{by}" width="{width}" height="{bar_h}" rx="12" '
                         f'fill="{fill}" stroke="{stroke}" />')
            parts.append(f'<text class="t-chip" x="{bar_x + 12}" y="{by + 16}" font-size="11" fill="#4044ED">'
                         f'{kind} {score(data)} · {pct(data)}%</text>')
    height = top * 2 + len(rows) * row_h + (len(rows) - 1) * row_gap
    return (
        '<figure class="diagram">'
        f'<svg viewBox="0 0 720 {height}" xmlns="http://www.w3.org/2000/svg" role="img" '
        'aria-label="七种方式的直接召回和 Memmy 中模型回答通过题数">'
        + "".join(parts)
        + '</svg><figcaption><span class="fig-no">图 2</span>每种方式两条：上面是直接召回，下面是 Memmy 中模型回答。'
        '条长按通过题数除以 29。项目记忆一行是标注上限。同一份代码重跑会有约 6 题的翻转，差距小于这个数的两行不要比大小。</figcaption></figure>'
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
             ("s5", "05", "每种方式"), ("s6", "06", "案例"), ("s7", "07", "没解决的"), ("s8", "08", "写入开销"),
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

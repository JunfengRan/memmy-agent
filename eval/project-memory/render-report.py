import html
import json
import math
from collections import Counter
from pathlib import Path

repo = Path("/Users/junfengran/repos/memmy-agent")
template = Path("/Users/junfengran/memtensor/templates/explainer.html").read_text()
root = repo / "eval/project-memory/runs"
out = repo / "eval/project-memory/report.html"

arms = [
    ("baseline", "空白对照"),
    ("project", "项目记忆"),
    ("attr-tree", "属性树"),
]
kinds = [
    ("cross-project", "跨项目"),
    ("stale", "过时"),
    ("overridden", "被改口"),
    ("plain", "普通"),
    ("scope-leak", "作用域串扰"),
]
error_order = ["none", "empty", "superseded", "ambiguous", "wrong_project", "other"]
error_label = {
    "none": "答对",
    "empty": "召回空或答不出",
    "superseded": "把过时说法当现行",
    "ambiguous": "相似信息没选",
    "wrong_project": "用了另一个项目",
    "other": "其他",
}
error_color = {
    "none": "var(--positive)",
    "empty": "var(--muted)",
    "superseded": "var(--risk)",
    "ambiguous": "var(--verify)",
    "wrong_project": "var(--brand-violet)",
    "other": "var(--primary)",
}

def load(name):
    path = root / name
    if not path.exists():
        return None
    return json.loads(path.read_text())

def esc(value):
    return html.escape(str(value or ""), quote=True)

def counts(data):
    counter = Counter()
    for question in (data or {}).get("questions", []):
        key = "none" if question.get("passed") else (question.get("errorType") or "other")
        if key not in error_label:
            key = "other"
        counter[key] += 1
    return counter

def complete(data):
    return bool(data) and len(data.get("questions") or []) >= data.get("questionCount", 1)

def rate(data):
    if not data or not data.get("questionCount"):
        return "待验证"
    saved = len(data.get("questions") or [])
    if saved < data["questionCount"]:
        return f"进行中 {saved}/{data['questionCount']}"
    return f"{data['passed']}/{data['questionCount']}"

def kind_cells(data, kind):
    if not complete(data):
        return "待验证"
    group = [q for q in data["questions"] if q.get("kind") == kind]
    if not group:
        return ""
    passed = sum(1 for q in group if q.get("passed"))
    return f"{passed}/{len(group)}"

def pie(data, title):
    counter = counts(data)
    total = sum(counter.values()) or 1
    cx, cy, radius = 118, 118, 86
    start = -math.pi / 2
    shapes = []
    present = [key for key in error_order if counter.get(key)]
    if len(present) == 1:
        shapes.append(f'<circle cx="{cx}" cy="{cy}" r="{radius}" fill="{error_color[present[0]]}" />')
    else:
        for key in present:
            fraction = counter[key] / total
            end = start + fraction * math.tau
            large = 1 if end - start > math.pi else 0
            x0 = cx + radius * math.cos(start)
            y0 = cy + radius * math.sin(start)
            x1 = cx + radius * math.cos(end)
            y1 = cy + radius * math.sin(end)
            shapes.append(
                f'<path fill="{error_color[key]}" d="M {cx} {cy} L {x0:.2f} {y0:.2f} '
                f'A {radius} {radius} 0 {large} 1 {x1:.2f} {y1:.2f} Z" />'
            )
            start = end
    legend = []
    y = 46
    for key in present:
        legend.append(
            f'<rect x="250" y="{y - 12}" width="14" height="14" rx="2" fill="{error_color[key]}" />'
            f'<text class="t-title" x="274" y="{y}" font-size="13">{esc(error_label[key])}</text>'
            f'<text class="t-sub t-mono" x="470" y="{y}" font-size="13">{counter[key]}</text>'
        )
        y += 28
    body = "".join(shapes + legend)
    return f'''<figure class="diagram">
      <svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{esc(title)}">
        {body}
        <text class="t-sub" x="118" y="228" text-anchor="middle" font-size="12">{esc(rate(data))} 题</text>
      </svg>
      <figcaption><span class="fig-no">{esc(title)}</span>分母不含 q21。答对和五种错因来自同一份裁判结果。</figcaption>
    </figure>'''

def failure_table(data):
    if not data:
        return ""
    rows = []
    for question in data["questions"]:
        if question.get("passed"):
            continue
        key = question.get("errorType") or "other"
        rows.append(
            "<tr>"
            f"<td>{esc(question.get('id'))}</td>"
            f"<td>{esc(dict(kinds).get(question.get('kind'), question.get('kind')))}</td>"
            f"<td>{esc(error_label.get(key, key))}</td>"
            f"<td>{esc(question.get('reason'))}</td>"
            "</tr>"
        )
    if not rows:
        return "<p>这一列没有错题。</p>"
    return (
        "<div class='table-wrap'><table><thead><tr>"
        "<th>题</th><th>题型</th><th>错因</th><th>裁判理由</th>"
        f"</tr></thead><tbody>{''.join(rows)}</tbody></table></div>"
    )

recall = {key: load(f"{key}-recall.json") for key, _ in arms}
answer = {key: load(f"{key}-answer.json") for key, _ in arms}
cursor = load("cursor-answer-project.json")

def row(label, mapping, pattern_note=""):
    cells = "".join(f"<td class='num'>{esc(rate(mapping[key]))}</td>" for key, _ in arms)
    return f"<tr><td>{esc(label)}</td>{cells}</tr>"

model_name = esc((recall["project"] or {}).get("model") or "评测模型")
ingested = len((recall["project"] or {}).get("ingested") or [])
kind_rows = []
for key, label in kinds:
    recall_cells = "".join(f"<td class='num'>{esc(kind_cells(recall[arm], key))}</td>" for arm, _ in arms)
    answer_cells = "".join(f"<td class='num'>{esc(kind_cells(answer[arm], key))}</td>" for arm, _ in arms)
    kind_rows.append(f"<tr><td>{esc(label)}</td>{recall_cells}{answer_cells}</tr>")

cursor_block = ""
if complete(cursor):
    cursor_block = pie(cursor, "图 4 · 项目记忆 · Cursor 回答")
elif cursor:
    cursor_block = f'''
      <div class="callout verify">
        <span class="callout-title">进行中</span>
        <p>项目记忆的 Cursor 裁判写到 {esc(rate(cursor))}。写完后再生成这一张饼图。</p>
      </div>
    '''
else:
    cursor_block = '''
      <div class="callout verify">
        <span class="callout-title">待验证</span>
        <p>Cursor 原文在 <code>runs/cursor-answers.json</code>，只有项目记忆这一列，而且当时没有裁判，所以没有错因。空白对照和属性树的 Cursor 回答这份材料里没有。</p>
      </div>
    '''

pies = []
for index, (key, label) in enumerate(arms, start=1):
    if complete(answer[key]):
        pies.append(pie(answer[key], f"图 {index} · {label} · 模型回答"))
    else:
        pies.append(f"<p>{esc(label)}的模型回答还没有完整裁判结果。</p>")

cursor_kinds = ""
if complete(cursor):
    cursor_kinds = "、".join(
        f"{label} {kind_cells(cursor, key)}" for key, label in kinds
    )

body = (repo / "eval/project-memory/report-body.html").read_text()
replacements = {
    "@@RB@@": esc(rate(recall["baseline"])),
    "@@RP@@": esc(rate(recall["project"])),
    "@@RA@@": esc(rate(recall["attr-tree"])),
    "@@AB@@": esc(rate(answer["baseline"])),
    "@@AP@@": esc(rate(answer["project"])),
    "@@AA@@": esc(rate(answer["attr-tree"])),
    "@@CP@@": esc(rate(cursor)),
    "@@MODEL@@": model_name,
    "@@INGESTED@@": str(ingested),
    "@@SEC_B@@": str((recall["baseline"] or {}).get("seconds", "")),
    "@@SEC_P@@": str((recall["project"] or {}).get("seconds", "")),
    "@@SEC_A@@": str((recall["attr-tree"] or {}).get("seconds", "")),
    "@@CALL_B@@": str((recall["baseline"] or {}).get("modelCalls", "")),
    "@@CALL_P@@": str((recall["project"] or {}).get("modelCalls", "")),
    "@@CALL_A@@": str((recall["attr-tree"] or {}).get("modelCalls", "")),
    "@@KINDS@@": "".join(kind_rows),
    "@@CURSOR_KINDS@@": esc(cursor_kinds or "待验证"),
    "@@PIE_B@@": pie(answer["baseline"], "图 1 · 空白对照 · 模型回答"),
    "@@PIE_P@@": pie(answer["project"], "图 2 · 项目记忆 · 模型回答"),
    "@@PIE_A@@": pie(answer["attr-tree"], "图 3 · 属性树 · 模型回答"),
    "@@CURSOR@@": cursor_block,
    "@@FAIL_B@@": failure_table(answer["baseline"]),
    "@@FAIL_P@@": failure_table(answer["project"]),
    "@@FAIL_A@@": failure_table(answer["attr-tree"]),
    "@@FAIL_C@@": failure_table(cursor) if complete(cursor) else "<p>待验证。</p>",
}
for key, value in replacements.items():
    body = body.replace(key, value)
nav = """<nav class="toc" aria-label="目录">
      <p class="toc-brand"><span class="toc-org">MemTensor</span><span class="toc-kind">研究文档</span></p>
      <a href="#s1" aria-current="true"><span class="toc-no">01</span>摘要</a>
      <a href="#s2"><span class="toc-no">02</span>问题</a>
      <a href="#s3"><span class="toc-no">03</span>算法</a>
      <a href="#s4"><span class="toc-no">04</span>实验</a>
      <a href="#s5"><span class="toc-no">05</span>结论</a>
      <a href="#s6"><span class="toc-no">06</span>错因</a>
      <a href="#s7"><span class="toc-no">07</span>样例</a>
      <a href="#s8"><span class="toc-no">08</span>总结</a>
      <a href="#appendix"><span class="toc-no">A</span>附录</a>
    </nav>
    <main>
"""
main = nav + body + "\n    </main>"

head, rest = template.split('<nav class="toc"', 1)
_, tail = rest.split("</main>", 1)
head = head.replace("<title>研究文档模板</title>", "<title>项目记忆三种方式对照</title>")
out.write_text(head + main + tail)
print("wrote", out)
print("cursor", rate(cursor))

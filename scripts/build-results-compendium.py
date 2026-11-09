#!/usr/bin/env python3
"""Builds the bilingual results compendium of a set of finished question runs: one HTML page and the report folders.

Each question's section is rendered from the run's own report documents (.report.zh.json / .report.en.json), so the page says
exactly what the downloadable reports say; figures are embedded. The curated text (grades, main limits, how to read, appendices)
comes from a notes file kept with the deliverable, because it is written by people and quotes results. This script holds no
data. The output is restricted: it contains aggregate results derived from MIMIC-IV.

  .venv/bin/python3 scripts/build-results-compendium.py --runs-dir .local/team-show-2026-10-26/runs \\
      --ids .local/team-show-2026-10-26/after-ids.json --notes .local/deliverables/2026-10-27/compendium-notes.json \\
      --out .local/deliverables/2026-10-27 --date 2026-10-27
"""
import argparse, base64, html, io, json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CSS = """
:root{--bg:#fff;--fg:#1c2330;--mut:#5b6678;--line:#d9dee7;--card:#f6f8fb;--acc:#1d5fa8}
@media(prefers-color-scheme:dark){:root{--bg:#14181f;--fg:#e6eaf0;--mut:#9aa6b8;--line:#2d3644;--card:#1b212b;--acc:#7db4f0}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif}
main{max-width:1040px;margin:0 auto;padding:16px}
h1{font-size:24px}h2{font-size:21px;border-top:2px solid var(--line);padding-top:18px;margin-top:36px}h3{font-size:17px}h4{font-size:15px;color:var(--mut)}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}th,td{border:1px solid var(--line);padding:5px 8px;vertical-align:top;text-align:left}th{background:var(--card)}
code{background:var(--card);padding:1px 5px;border-radius:4px}details{background:var(--card);border-radius:6px;padding:6px 12px;margin:8px 0}summary{cursor:pointer;color:var(--acc)}
.badge{display:inline-block;min-width:22px;text-align:center;border-radius:5px;padding:0 7px;font-size:14px;color:#fff}.bA{background:#2e7d32}.bB{background:#b26a00}.bC{background:#8a2c2c}
.q{background:var(--card);border-left:4px solid var(--acc);padding:8px 12px}.meta{color:var(--mut);font-size:12px}.note{color:var(--mut)}
figure{margin:10px 0}figure img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:4px;background:#fff}figcaption{color:var(--mut);font-size:12px}
.warn{border:1px solid #b26a00;background:rgba(178,106,0,.1);padding:10px 14px;border-radius:6px}
.bar{position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);z-index:5}.bar button{margin-right:6px;padding:4px 12px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:5px;cursor:pointer}
body[data-lang=zh] .en{display:none}body[data-lang=en] .zh{display:none}
@media print{.bar{display:none}details{display:block}h2{break-before:page}}
.grp td{background:var(--card);font-weight:600}.demo{font-size:12px;color:var(--mut);font-weight:400;border:1px solid var(--line);border-radius:9px;padding:0 8px;margin-left:6px}
.chg{color:#b26a00}
"""
# The page always opens in Chinese; English is one click away (a remembered choice would open a shared copy in the last reader's language).
SCRIPT = "function setLang(l){document.body.dataset.lang=l}setLang('zh')"
# Report sections shown collapsed: long lookup tables that most readers skip.
COLLAPSED = {"变量与 MIMIC-IV 数据映射", "Variables and MIMIC-IV data mapping", "可重复性信息", "Reproducibility"}
NOT_PRIMARY = {"proportion", "mean", "test_statistic", "logrank_chisq"}
MEASURE = {"odds_ratio": ("OR", "OR"), "risk_ratio": ("RR", "RR"), "hazard_ratio": ("HR", "HR"), "rate_ratio": ("率比", "rate ratio"),
           "risk_difference": ("风险差", "risk difference"), "mean_difference": ("均值差", "mean difference"), "location_shift": ("位置差", "location shift"),
           "auc": ("AUC", "AUC"), "indirect_effect": ("间接效应", "indirect effect"), "indirect_effect_product": ("间接效应（系数乘积）", "indirect effect (product)")}
ESTIMABILITY = {"effect_size_plausible", "group_sizes", "outcome_events"}

esc = lambda text: html.escape(str(text), quote=False)


def number(value):
    if value is None: return "–"
    if abs(value) >= 1000: return f"{value:.0f}"
    # Three significant figures keeping trailing zeros (1.60, not 1.6), so neighbouring numbers show the same precision.
    text = f"{value:#.3g}"
    return text[:-1] if text.endswith(".") else text


def interval(low, high):
    # "−2.39 to −1.71" reads better than "−2.39–−1.71".
    return f"{number(low)} to {number(high)}" if (low is not None and low < 0) or (high is not None and high < 0) else f"{number(low)}–{number(high)}"


def p_text(value):
    return "–" if value is None else "<0.001" if value < 0.001 else f"{value:.3f}"


def reliable(plan):
    return not any(c["check_id"] in ESTIMABILITY and c["status"] == "fail" for c in (plan.get("quality") or {}).get("checks", []))


def headline(plan):
    """The same rule as backend question-pipeline/headline.ts: AUC for prediction, the interaction test for effect modification."""
    result = plan.get("result") or {}
    estimates = result.get("estimates") or []
    if (plan.get("chosen_method") or "").startswith("prediction."):
        auc = next((e for e in estimates if e["term"] == "auc"), None)
        return f"AUC {number(auc['estimate'])} ({interval(auc['ci_low'], auc['ci_high'])})" if auc else "–"
    main = next((e for e in estimates if e["measure"] not in NOT_PRIMARY), estimates[0] if estimates else None)
    if not main: return "–"
    zh, en = MEASURE.get(main["measure"], (main["measure"], main["measure"]))
    label = lambda estimate: f"{zh if zh == en else f'{zh} / {en}'} {number(estimate['estimate'])} ({interval(estimate['ci_low'], estimate['ci_high'])})"
    interaction = (result.get("diagnostics") or {}).get("p_interaction")
    if not isinstance(interaction, (int, float)): return label(main)
    # An interaction test compares the subgroups' estimates: show each, named, beside it.
    levels = [e for e in estimates if e["measure"] == main["measure"] and " in " in e["label"] and "sensitivity" not in e["label"]]
    name = lambda e: {"Gender = F": "女 / women", "Gender = M": "男 / men"}.get(e["label"].split(" in ")[-1].replace(" (IPTW)", ""), e["label"].split(" in ")[-1])
    sex = all(" in Gender = " in e["label"] for e in levels)
    test = "性别差异 P / P for sex difference" if sex else "效应差异 P / P for difference"
    return f"{test} {p_text(interaction)}; " + "; ".join(f"{name(e)} {label(e)}" for e in levels)


def main_result(run):
    plans = run["plans"]; done = [p for p in plans if p["status"] == "completed"]; blocked = len(plans) - len(done)
    shown = lambda plan: headline(plan) if reliable(plan) else "无法可靠估计 / not reliably estimable"
    if len(plans) == 1 and done:
        return shown(done[0]) + f", n={done[0]['result']['n_analysed']:,}"
    if len(done) <= 2 and not blocked:
        name = lambda p: " → ".join(filter(None, [p.get("exposure_level"), ((p.get("study_spec") or {}).get("outcome") or {}).get("name")])) or p["plan_id"]
        return " · ".join(f"{name(p)}: {shown(p)}" for p in done)
    count = f"{len(done)} 个完成、{blocked} 个阻断 / {len(done)} completed, {blocked} blocked" if blocked else f"{len(done)} 个分析 / {len(done)} analyses"
    family = run.get("multiplicity") or {}
    if family.get("analyses"):
        return count + f"；其中 {family['analyses']} 个不同的可靠分析，{family.get('significant_after', 0)} 个经多重比较（Holm）校正后显著 / {family['analyses']} distinct reliable analyses, {family.get('significant_after', 0)} significant after the Holm correction"
    return count


# Each figure file is embedded once (the Chinese and English reports, and plans sharing a figure, show the same file) and the
# images take their data from it when the page loads.
FIGURES = {}


def figure(path, caption):
    if path not in FIGURES:
        try:
            from PIL import Image
            image = Image.open(path).convert("RGB"); image.thumbnail((640, 640))
            buffer = io.BytesIO(); image.save(buffer, "JPEG", quality=70); data, kind = buffer.getvalue(), "jpeg"
        except ImportError:
            data, kind = open(path, "rb").read(), "png"
        except OSError:
            return f"<p class=note>{esc(caption)} (figure file missing)</p>"
        # Plans that share a step (the propensity overlap of one exposure across outcomes) draw identical images: keep one.
        uri = f"data:image/{kind};base64,{base64.b64encode(data).decode()}"
        FIGURES[path] = next((key for key, known in FIGURES.values() if known == uri), f"f{len(FIGURES)}"), uri
    return f'<figure><img alt="{html.escape(caption)}" data-f="{FIGURES[path][0]}"><figcaption>{esc(caption)}</figcaption></figure>'


def render_document(document):
    """Report blocks to HTML: level-1 title dropped, levels shifted down one, lookup sections collapsed."""
    out, open_details = [], False
    for block in document["blocks"]:
        kind = block["kind"]
        if kind == "heading":
            if block["level"] == 1: continue
            if open_details: out.append("</details>"); open_details = False
            if block["text"] in COLLAPSED:
                out.append(f"<details><summary>{esc(block['text'])}</summary>"); open_details = True; continue
            level = min(block["level"] + 1, 4)
            out.append(f"<h{level}>{esc(block['text'])}</h{level}>")
        elif kind == "paragraph": out.append(f"<p>{esc(block['text'])}</p>")
        elif kind == "list": out.append("<ul>" + "".join(f"<li>{esc(item)}</li>" for item in block["items"]) + "</ul>")
        elif kind == "table":
            caption = f"<p><b>{esc(block['caption'])}</b></p>" if block.get("caption") else ""
            head = "".join(f"<th>{esc(c)}</th>" for c in block["columns"])
            rows = "".join("<tr>" + "".join(f"<td>{esc(c)}</td>" for c in row) + "</tr>" for row in block["rows"])
            out.append(f"{caption}<div class=tw><table><tr>{head}</tr>{rows}</table></div>")
        elif kind == "figure": out.append(figure(block["path"], block["caption"]))
    if open_details: out.append("</details>")
    return "\n".join(out)


def pair(zh, en, tag="p"):
    close = tag.split()[0]
    return f"<div class=zh><{tag}>{zh}</{close}></div><div class=en><{tag}>{en}</{close}></div>"


def paragraphs(section):
    return f"<div class=zh>{''.join(f'<p>{esc(t)}</p>' for t in section['zh'])}</div><div class=en>{''.join(f'<p>{esc(t)}</p>' for t in section['en'])}</div>"


def table(spec):
    """A notes table ({columns, rows}); cells are plain text, bilingual in the cell itself."""
    if not spec: return ""
    head = "".join(f"<th>{esc(c)}</th>" for c in spec["columns"])
    return f"<div class=tw><table><tr>{head}</tr>" + "".join("<tr>" + "".join(f"<td>{esc(c)}</td>" for c in row) + "</tr>" for row in spec["rows"]) + "</table></div>"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs-dir", required=True); parser.add_argument("--ids", required=True); parser.add_argument("--notes", required=True)
    parser.add_argument("--out", required=True); parser.add_argument("--date", required=True)
    args = parser.parse_args()
    ids = json.load(open(args.ids)); notes = json.load(open(args.notes)); questions = notes["questions"]
    os.makedirs(args.out, exist_ok=True)
    runs = {}
    for qid, run_id in ids.items():
        folder = os.path.join(args.runs_dir, run_id)
        if not os.path.exists(os.path.join(folder, "run.json")): sys.exit(f"{qid}: run {run_id} has no result yet")
        runs[qid] = (run_id, folder, json.load(open(os.path.join(folder, "run.json"))))

    parts = [f'<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MIMIC results compendium</title><style>{CSS}</style></head>',
             '<body data-lang="zh"><main>',
             "<div class=bar><button onclick=\"setLang('zh')\">中文</button><button onclick=\"setLang('en')\">English</button><button onclick=\"window.print()\">打印 / PDF · Print</button></div>",
             f'<h1>MIMIC-IV 研究平台：分析结果汇编<br><small style="font-size:14px;color:var(--mut)">MIMIC-IV research platform: results compendium · {esc(args.date)}</small></h1>',
             pair("<b>使用限制：</b>本文件含由 MIMIC-IV 全量数据生成的汇总结果，只能提供给已获 PhysioNet 授权的人员。不含患者明细。",
                  "<b>Restricted:</b> this file holds aggregate results derived from the full MIMIC-IV data and may only be shared with people who hold PhysioNet credentialed access. It contains no patient-level data.").replace("<p>", "<p class=warn>"),
             '<h2><span class=zh>怎么读这份文件</span><span class=en>How to read this file</span></h2>', paragraphs(notes["how_to_read"])]
    # The notes name the version they compare with; the defaults are the wording of earlier compendiums.
    changes = notes.get("changes") or {}
    title = changes.get("title", {"zh": "本版与上一版的区别", "en": "What changed since the previous version"})
    marker = changes.get("marker", {"zh": "结果相对上一版有实质变化，见“本版与上一版的区别”。", "en": "The result changed materially since the previous version; see “What changed”."})
    if changes:
        parts += [f'<h2><span class=zh>{esc(title["zh"])}</span><span class=en>{esc(title["en"])}</span></h2>', paragraphs(changes), table(changes.get("table"))]
    parts.append('<h2>总览 / Overview</h2>' + pair("A　可用于报告（须附限制说明）；B　仅作探索或初步结果，不建议直接引用数值", "A  Usable in a report (with the stated limitations); B  Exploratory or preliminary; do not quote the numbers directly"))
    rows = ["<tr><th>编号</th><th>可用性</th><th>问题 / Question</th><th>主要结果 / Main result</th><th>主要限制 / Main limit</th></tr>"]
    for group in notes["groups"]:
        rows.append(f"<tr class=grp><td colspan=5><div class=zh>{esc(group['zh'])}</div><div class=en>{esc(group['en'])}</div></td></tr>")
        for qid in group["ids"]:
            note = questions[qid]; run = runs[qid][2]
            changed = " <span class=chg>●</span>" if note.get("changed") else ""
            rows.append(f'<tr><td><a href="#q{qid}">{qid}</a>{changed}</td><td><span class="badge b{note["grade"]}">{note["grade"]}</span></td><td>{esc(run["question"])}</td><td>{esc(main_result(run))}</td>'
                        f'<td><div class=zh>{esc(note["limit"]["zh"])}</div><div class=en>{esc(note["limit"]["en"])}</div></td></tr>')
    parts.append(f"<div class=tw><table>{''.join(rows)}</table></div>")
    if any(q.get("changed") for q in questions.values()):
        parts.append(pair(f"<span class=chg>●</span> {esc(marker['zh'])}", f"<span class=chg>●</span> {esc(marker['en'])}", "p class=note"))

    for group in notes["groups"]:
        for qid in group["ids"]:
            run_id, folder, run = runs[qid]; note = questions[qid]; s = run["summary"]
            demo = ' <span class=demo>推导变量演示 / derived-variable demo</span>' if note.get("demo") else ""
            parts.append(f'<h2 id="q{qid}">{qid}　<span class="badge b{note["grade"]}">{note["grade"]}</span>{demo}</h2><p class=q>{esc(run["question"])}</p>'
                         f'<p class=meta>run: {esc(run_id)} · {s["plans"]} 个分析计划 / plans: {s["completed"]} completed, {s["blocked"]} blocked, {s["failed"]} failed</p>')
            parts.append(pair(f"<b>可用性：</b>{esc(note['readiness']['zh'])}", f"<b>Readiness:</b> {esc(note['readiness']['en'])}"))
            for language in ("zh", "en"):
                path = os.path.join(folder, f".report.{language}.json")
                body = render_document(json.load(open(path))) if os.path.exists(path) else "<p class=note>report missing</p>"
                definitions = "完整变量定义（每个 ICD 编码、药物标签和 itemid）" if language == "zh" else "Full variable definitions (every ICD code, drug label and itemid)"
                parts.append(f"<div class={language}><p class=note>{definitions}: <code>variable-definitions/{qid}/variable-definitions.csv</code></p>{body}</div>")

    parts.append('<h2>附录 / Appendix</h2>')
    key = "".join(f"<tr><td>{qid}</td><td>{esc(questions[qid].get('earlier_label', ''))}</td></tr>" for group in notes["groups"] for qid in group["ids"])
    parts.append('<h3><span class=zh>附录 A　编号对照</span><span class=en>Appendix A  Number key</span></h3>' + f"<div class=tw><table><tr><th>编号 / Number</th><th>此前的标签 / Earlier label</th></tr>{key}</table></div>")
    for letter, name in (("b", "B"), ("c", "C"), ("d", "D"), ("e", "E")):
        section = notes.get(f"appendix_{letter}")
        if not section: continue
        title = section.get("title", {"zh": f"附录 {name}", "en": f"Appendix {name}"})
        parts.append(f'<h3><span class=zh>{esc(title["zh"])}</span><span class=en>{esc(title["en"])}</span></h3>' + paragraphs(section) + table(section.get("table")))
    figures = json.dumps({key: data for key, data in FIGURES.values()})
    parts.append(f"</main><script>const F={figures};document.querySelectorAll('img[data-f]').forEach(function(i){{i.src=F[i.dataset.f]}});{SCRIPT}</script></body></html>")
    page = os.path.join(args.out, f"MIMIC_results_{args.date}.html")
    open(page, "w", encoding="utf-8").write("\n".join(parts))

    # Report folders and variable definitions next to the page, as in earlier versions.
    for qid, (run_id, folder, run) in runs.items():
        target = os.path.join(args.out, "reports", qid); os.makedirs(target, exist_ok=True)
        for name in os.listdir(folder):
            if name.startswith("report.") or name == "run.json": shutil.copy2(os.path.join(folder, name), target)
        open(os.path.join(target, "RUN_ID.txt"), "w").write(run_id + "\n")
        definitions = os.path.join(args.out, "variable-definitions", qid); os.makedirs(definitions, exist_ok=True)
        subprocess.run([sys.executable, os.path.join(HERE, "export-variable-definitions.py"), folder, "--out", definitions], check=True, stdout=subprocess.DEVNULL)
    print(f"{page} ({os.path.getsize(page) / 1e6:.1f} MB), {len(runs)} questions")


if __name__ == "__main__":
    main()

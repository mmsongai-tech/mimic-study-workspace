#!/usr/bin/env python3
"""Build clinician-facing aggregate DOCX/PDF reports; never accepts patient rows."""

from __future__ import annotations

import json
import math
import sys
from html import escape
from io import BytesIO
from pathlib import Path
from typing import Any

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Image as PdfImage
from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from reportlab.graphics.shapes import Circle, Drawing, Line, String

GREEN = "0B806A"
DARK = "173B33"
MINT = "DDF2EC"
PALE = "F5F8F6"
AMBER = "FFF4DD"
GRAY = "667B75"


def fmt(value: Any, digits: int = 3) -> str:
    try:
        number = float(value)
        return f"{number:.{digits}f}" if math.isfinite(number) else "NA"
    except (TypeError, ValueError):
        return "NA"


def format_p_value(value: Any) -> str:
    try:
        number = float(value)
        if not math.isfinite(number):
            return "p=NA"
        return "p<0.001" if number < 0.001 else f"p={number:.3f}"
    except (TypeError, ValueError):
        return "p=NA"


def evidence_notice(artifact: dict[str, Any], language: str) -> str:
    if artifact.get("evidence_level") == "synthetic_execution":
        return labels(language)["synthetic"]
    return (
        "真实 MIMIC-IV 观察性分析｜不可用于个体临床决策或因果推断"
        if language == "zh"
        else "REAL MIMIC-IV OBSERVATIONAL ANALYSIS | NOT FOR INDIVIDUAL CLINICAL OR CAUSAL DECISIONS"
    )


def labels(language: str) -> dict[str, str]:
    zh = language == "zh"
    return {
        "title": "临床研究统计分析报告" if zh else "Clinical Research Statistical Analysis Report",
        "synthetic": "合成数据演示报告｜不可用于临床决策或因果推断" if zh else "SYNTHETIC DATA DEMONSTRATION | NOT FOR CLINICAL OR CAUSAL DECISIONS",
        "design": "研究设计" if zh else "Study design",
        "methods": "统计方法" if zh else "Statistical methods",
        "results": "主要结果" if zh else "Primary results",
        "table1": "表 1　基线特征" if zh else "Table 1. Baseline characteristics",
        "adjusted": "调整模型与敏感性分析" if zh else "Adjusted model and sensitivity analyses",
        "diagnostics": "模型诊断与缺失数据" if zh else "Model diagnostics and missing data",
        "limitations": "解释边界与局限性" if zh else "Interpretation boundaries and limitations",
        "repro": "可复现性记录" if zh else "Reproducibility record",
        "figure1": "图 1　不同乳酸暴露组的院内死亡风险" if zh else "Figure 1. In-hospital mortality risk by lactate exposure group",
        "figure2": "图 2　不同乳酸阈值下的比值比敏感性分析" if zh else "Figure 2. Odds-ratio sensitivity across lactate thresholds",
        "question": "研究问题" if zh else "Research question",
        "population": "研究人群" if zh else "Population",
        "index": "共同起始时间" if zh else "Index time",
        "exposure": "暴露因素" if zh else "Exposure",
        "outcome": "结局" if zh else "Outcome",
        "run": "运行 ID" if zh else "Run ID",
        "evidence": "证据类型" if zh else "Evidence class",
    }


ZH_TERMS = {
    "Synthetic adult ICU admissions": "合成成人 ICU 入院记录",
    "ICU admission": "ICU 入科",
    "First eligible ICU admission": "首次符合条件的 ICU 入院记录",
    "Lactate": "乳酸",
    "In-hospital mortality": "院内死亡",
    "Characteristic": "特征",
    "Overall": "总体",
    "Exposed": "暴露组",
    "Unexposed": "非暴露组",
    "Participants, n": "研究对象，n",
    "Age, mean (SD), years": "年龄，均值（标准差），岁",
    "Female, n (%)": "女性，n（%）",
    "Lactate, median (IQR), mmol/L": "乳酸，中位数（四分位距），mmol/L",
    "In-hospital death, n (%)": "院内死亡，n（%）",
    "Synthetic fixture result; not clinical or real-data evidence.": "结果来自合成数据，仅用于演示和流程验证，不属于临床或真实数据证据。",
    "Crude association does not establish a causal treatment effect.": "粗关联不能证明因果关系或治疗效应。",
    "Synthetic internal validation only; external clinical validity is not established.": "仅完成合成数据内部验证，尚未建立外部临床有效性。",
    "The model must not be used for patient-level decisions.": "该模型不得用于患者级决策。",
    "Synthetic IPTW estimate only; unmeasured confounding is not addressed.": "仅为合成数据 IPTW 估计，未测量混杂仍无法排除。",
    "This result is not a clinical treatment recommendation.": "该结果不构成临床治疗建议。",
    "The exposure is a reproducible keyword-derived candidate phenotype, not a clinically approved ICD code set.": "暴露定义是可复现的关键词衍生候选表型，尚不是经临床审核批准的 ICD 编码集。",
    "Crude aggregate association; no covariate adjustment.": "当前为未调整协变量的汇总层面粗关联分析。",
    "Temporal ordering and confounding require separate study validation.": "时间先后关系与混杂控制仍需在后续研究设计中单独验证。",
    "Ventilation prediction": "24 小时有创机械通气预测",
    "Predict ventilation": "预测 ICU 入科后 24 小时内有创机械通气",
    "Adults": "成人 ICU 入院记录",
    "Vasopressor effect": "早期升压药治疗效果",
    "Estimate treatment effect": "估计早期升压药治疗效果",
    "Adults with hypotension": "发生低血压的成人 ICU 入院记录",
    "Invasive mechanical ventilation within 24 hours": "24 小时内有创机械通气",
}


def localize(value: Any, language: str) -> str:
    text = str(value)
    return ZH_TERMS.get(text, text) if language == "zh" else text


def localized_table(rows: list[list[Any]], language: str) -> list[list[str]]:
    return [[localize(value, language) for value in row] for row in rows]


def statistical_review_content(artifact: dict[str, Any], language: str) -> dict[str, Any]:
    """Return clinician-facing review content while remaining compatible with old runs."""
    zh = language == "zh"
    review = artifact.get("statistical_review")
    if not review:
        return {
            "status": "未记录（旧版运行）" if zh else "Not recorded (legacy run)",
            "method": "未记录" if zh else "Not recorded",
            "decision": (
                "本报告无法确认关键统计诊断是否全部执行；结果仅供复核，不应作为主要解释依据。"
                if zh else
                "This report cannot confirm that all critical statistical diagnostics were performed; results are for review only and should not support primary interpretation."
            ),
            "observations": [], "blocking": [], "warnings": [],
        }
    status = review.get("interpretation_status", "blocked")
    status_labels = {
        "allowed": "允许解释" if zh else "Interpretation allowed",
        "allowed_with_warnings": "可在警告条件下解释" if zh else "Interpretation allowed with warnings",
        "blocked": "禁止主要解释" if zh else "Primary interpretation blocked",
    }
    decision_text = {
        "allowed": "所有已登记的关键诊断均通过，可在报告所述设计与局限范围内解释结果。" if zh else "All registered critical diagnostics passed; results may be interpreted within the documented design and limitations.",
        "allowed_with_warnings": "关键诊断未触发阻断，但解释时必须同时报告下列警告。" if zh else "No critical diagnostic triggered a block, but the following warnings must accompany interpretation.",
        "blocked": "至少一项关键诊断失败或未执行。保留结果用于诊断复核，但不得进行主要统计、临床或因果解释。" if zh else "At least one critical diagnostic failed or was not evaluated. Retain results for diagnostic review, but do not make primary statistical, clinical, or causal interpretations.",
    }
    method = review.get("method", {})
    diagnostics = review.get("diagnostics", {})
    return {
        "status": status_labels.get(status, status_labels["blocked"]),
        "method": f"{method.get('method_id', 'not-recorded')} v{method.get('method_version', 'NA')}",
        "decision": decision_text.get(status, decision_text["blocked"]),
        "observations": diagnostics.get("observations", []),
        "blocking": diagnostics.get("blocking_reasons", []),
        "warnings": diagnostics.get("warnings", []),
    }


def statistical_review_rows(artifact: dict[str, Any], language: str) -> list[list[str]]:
    zh = language == "zh"
    content = statistical_review_content(artifact, language)
    state_labels = {
        "pass": "通过" if zh else "Pass", "warning": "警告" if zh else "Warning",
        "fail": "失败" if zh else "Fail", "not_evaluated": "未评估" if zh else "Not evaluated",
    }
    rows = [["方法档案" if zh else "Method profile", content["method"]], ["解释状态" if zh else "Interpretation status", content["status"]]]
    rows.extend([
        [observation.get("code", "unknown"), f"{state_labels.get(observation.get('state'), observation.get('state', 'unknown'))}: {observation.get('summary', '')}"]
        for observation in content["observations"]
    ])
    return rows


def add_docx_statistical_review(document: Document, artifact: dict[str, Any], language: str) -> None:
    zh = language == "zh"
    content = statistical_review_content(artifact, language)
    document.add_heading("统计审查结论" if zh else "Statistical review decision", level=1)
    decision = document.add_paragraph(content["decision"])
    decision.runs[0].bold = True
    decision.runs[0].font.color.rgb = RGBColor.from_string("9A6200" if content["blocking"] else DARK)
    add_docx_table(document, statistical_review_rows(artifact, language), [1.85, 4.85], header=False)
    for reason in content["blocking"]:
        document.add_paragraph(("阻断：" if zh else "Blocking: ") + reason, style="List Bullet")
    for warning in content["warnings"]:
        document.add_paragraph(("警告：" if zh else "Warning: ") + warning, style="List Bullet")


def font_path() -> str | None:
    candidates = [
        "/Library/Fonts/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    return next((path for path in candidates if Path(path).exists()), None)


def make_figures(bundle: dict[str, Any], directory: Path, language: str) -> tuple[Path, Path]:
    analysis = bundle["artifact"]["analysis"]
    kind = analysis.get("analysis_kind")
    if kind in {"binary_prediction", "propensity_weighted_treatment_effect"}:
        source_figures = analysis.get("publication_outputs", {}).get("figures", [])
        paths = []
        for index in range(2):
            path = directory / f"clinical-figure-{index + 1}.png"
            image = Image.new("RGB", (1500, 820), "white")
            draw = ImageDraw.Draw(image)
            selected_font = font_path()
            title_font = ImageFont.truetype(selected_font, 34) if selected_font else ImageFont.load_default()
            body_font = ImageFont.truetype(selected_font, 28) if selected_font else ImageFont.load_default()
            title = source_figures[index].get("title", f"Figure {index + 1}") if index < len(source_figures) else f"Figure {index + 1}"
            draw.text((80, 55), title, fill="#173B33", font=title_font)
            if kind == "binary_prediction":
                metrics = analysis["estimates"]
                items = ([("AUROC", metrics["auroc"]), ("Brier score", metrics["brier_score"]), ("Sensitivity", metrics["sensitivity"]), ("Specificity", metrics["specificity"])] if index == 0 else [("Calibration intercept", metrics["calibration_intercept"]), ("Calibration slope", metrics["calibration_slope"]), ("Probability threshold", metrics["probability_threshold"])])
            else:
                metrics = analysis["estimates"]
                diagnostics = analysis["diagnostics"]
                items = ([("Maximum SMD before", diagnostics["maximum_smd_before"]), ("Maximum SMD after", diagnostics["maximum_smd_after"]), ("Extreme weight fraction", diagnostics["extreme_weight_fraction"])] if index == 0 else [("Weighted treated risk", metrics["weighted_treated_risk"]), ("Weighted untreated risk", metrics["weighted_untreated_risk"]), ("Risk difference", metrics["risk_difference"]), ("Risk ratio", metrics["risk_ratio"])])
            for item_index, (name, value) in enumerate(items):
                y = 180 + item_index * 135
                draw.text((110, y), name, fill="#667B75", font=body_font)
                width = int(min(abs(float(value)), 1.0) * 650)
                draw.rounded_rectangle((650, y, 650 + max(width, 8), y + 48), radius=12, fill="#0B806A")
                draw.text((1320, y), fmt(value), fill="#173B33", font=body_font, anchor="ra")
            image.save(path, dpi=(300, 300))
            paths.append(path)
        return paths[0], paths[1]
    labels_ = labels(language)
    selected_font = font_path()
    regular = ImageFont.truetype(selected_font, 30) if selected_font else ImageFont.load_default()
    small = ImageFont.truetype(selected_font, 24) if selected_font else ImageFont.load_default()
    bold = regular

    risk_path = directory / "group-risks.png"
    image = Image.new("RGB", (1500, 820), "white")
    draw = ImageDraw.Draw(image)
    draw.text((80, 45), labels_["figure1"].split("　")[-1].split(". ")[-1], fill="#173B33", font=bold)
    risks = [analysis["estimates"]["exposed_risk"], analysis["estimates"]["unexposed_risk"]]
    names = (["暴露组", "非暴露组"] if language == "zh" else ["Exposed", "Unexposed"])
    colors_ = ["#0B806A", "#89BDB1"]
    for index, (risk, name) in enumerate(zip(risks, names)):
        left = 250 + index * 550
        top = 680 - int(max(0, min(1, risk)) * 480)
        draw.rounded_rectangle((left, top, left + 280, 680), radius=18, fill=colors_[index])
        draw.text((left + 70, top - 55), f"{risk * 100:.1f}%", fill="#173B33", font=regular)
        draw.text((left + 55, 710), name, fill="#173B33", font=small)
    draw.line((160, 680, 1340, 680), fill="#667B75", width=3)
    image.save(risk_path, dpi=(300, 300))

    sensitivity_path = directory / "threshold-sensitivity.png"
    image = Image.new("RGB", (1500, 900), "white")
    draw = ImageDraw.Draw(image)
    draw.text((80, 45), labels_["figure2"].split("　")[-1].split(". ")[-1], fill="#173B33", font=bold)
    results = analysis.get("sensitivity_analyses", {}).get("threshold_results", [])
    finite_upper = [row["odds_ratio_ci_95"][1] for row in results if math.isfinite(row["odds_ratio_ci_95"][1])]
    xmax = max([2.0, *finite_upper])
    x0, x1 = 350, 1340
    scale = (x1 - x0) / math.log(max(xmax, 1.01))
    xcoord = lambda value: x0 + math.log(max(value, 0.01)) * scale
    draw.line((xcoord(1), 130, xcoord(1), 780), fill="#C79020", width=3)
    for index, row in enumerate(results):
        y = 240 + index * 190
        low, high = row["odds_ratio_ci_95"]
        draw.text((80, y - 18), f"> {fmt(row['threshold_mmol_l'], 1)} mmol/L", fill="#173B33", font=small)
        draw.line((xcoord(low), y, xcoord(high), y), fill="#0B806A", width=8)
        x = xcoord(row["odds_ratio"])
        draw.ellipse((x - 15, y - 15, x + 15, y + 15), fill="#0B806A")
        label_text = f"OR {fmt(row['odds_ratio'])}"
        label_x = xcoord(high) + 28
        if label_x > 1270:
            draw.text((xcoord(low) - 28, y - 18), label_text, fill="#173B33", font=small, anchor="ra")
        else:
            draw.text((label_x, y - 18), label_text, fill="#173B33", font=small)
    draw.text((xcoord(1) - 12, 805), "1", fill="#667B75", font=small)
    image.save(sensitivity_path, dpi=(300, 300))
    return risk_path, sensitivity_path


def set_cell_shading(cell: Any, fill: str) -> None:
    shading = OxmlElement("w:shd")
    shading.set(qn("w:fill"), fill)
    cell._tc.get_or_add_tcPr().append(shading)


def add_docx_table(document: Document, rows: list[list[str]], widths: list[float], header: bool = True) -> None:
    table = document.add_table(rows=0, cols=len(widths))
    table.autofit = False
    for row_index, values in enumerate(rows):
        cells = table.add_row().cells
        cant_split = OxmlElement("w:cantSplit")
        cells[0]._tc.getparent().get_or_add_trPr().append(cant_split)
        for index, value in enumerate(values):
            cells[index].width = Inches(widths[index])
            cells[index].vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            paragraph = cells[index].paragraphs[0]
            paragraph.paragraph_format.space_after = Pt(0)
            run = paragraph.add_run(str(value))
            run.font.size = Pt(9)
            if header and row_index == 0:
                run.bold = True
                run.font.color.rgb = RGBColor(255, 255, 255)
                set_cell_shading(cells[index], DARK)
            elif row_index % 2 == 0:
                set_cell_shading(cells[index], PALE)
    document.add_paragraph().paragraph_format.space_after = Pt(0)


def configure_docx(document: Document, language: str) -> None:
    section = document.sections[0]
    section.page_width, section.page_height = Inches(8.5), Inches(11)
    section.top_margin = section.bottom_margin = section.left_margin = section.right_margin = Inches(0.72)
    for name in ["Normal", "Title", "Subtitle", "Heading 1", "Heading 2", "Heading 3"]:
        style = document.styles[name]
        style.font.name = "Arial" if language != "zh" else "Arial Unicode MS"
        style._element.rPr.rFonts.set(qn("w:eastAsia"), "Arial Unicode MS" if language == "zh" else "Arial")
    normal = document.styles["Normal"]
    normal.font.size = Pt(9.5)
    normal.paragraph_format.space_after = Pt(4)
    heading = document.styles["Heading 1"]
    heading.font.size = Pt(14)
    heading.font.color.rgb = RGBColor.from_string(GREEN)
    heading.paragraph_format.space_before = Pt(9)
    heading.paragraph_format.space_after = Pt(5)
    header = section.header.paragraphs[0]
    header.text = "MIMIC RESEARCH WORKSPACE"
    header.runs[0].font.size = Pt(8)
    header.runs[0].font.color.rgb = RGBColor.from_string(GRAY)


def apply_docx_fonts(document: Document, language: str) -> None:
    def apply(run: Any) -> None:
        family = "Arial Unicode MS" if language == "zh" else "Arial"
        run.font.name = family
        fonts = run._element.get_or_add_rPr().get_or_add_rFonts()
        for attribute in ["ascii", "hAnsi", "eastAsia", "cs"]:
            fonts.set(qn(f"w:{attribute}"), family)
        language_tag = OxmlElement("w:lang")
        language_tag.set(qn("w:val"), "zh-CN" if language == "zh" else "en-US")
        language_tag.set(qn("w:eastAsia"), "zh-CN" if language == "zh" else "en-US")
        run._element.get_or_add_rPr().append(language_tag)

    for paragraph in [*document.paragraphs, *document.sections[0].header.paragraphs, *document.sections[0].footer.paragraphs]:
        for run in paragraph.runs:
            apply(run)
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    for run in paragraph.runs:
                        apply(run)


def build_docx(bundle: dict[str, Any], output: Path, language: str, figures: tuple[Path, Path]) -> None:
    artifact, analysis = bundle["artifact"], bundle["artifact"]["analysis"]
    if analysis.get("analysis_kind"):
        build_generic_docx(bundle, output, language, figures)
        return
    spec = artifact["study"]["spec"]
    label = labels(language)
    document = Document()
    section = document.sections[0]
    section.page_width, section.page_height = Inches(8.5), Inches(11)
    section.top_margin = section.bottom_margin = section.left_margin = section.right_margin = Inches(0.82)
    styles = document.styles
    for name in ["Normal", "Title", "Subtitle", "Heading 1", "Heading 2", "Heading 3"]:
        style = styles[name]
        style.font.name = "Arial"
        style._element.rPr.rFonts.set(qn("w:eastAsia"), "PingFang SC")
    styles["Normal"].font.size = Pt(10.5)
    styles["Normal"].paragraph_format.space_after = Pt(6)
    styles["Title"].font.size = Pt(25)
    styles["Title"].font.bold = True
    styles["Title"].font.color.rgb = RGBColor.from_string(DARK)
    styles["Heading 1"].font.size = Pt(16)
    styles["Heading 1"].font.color.rgb = RGBColor.from_string(GREEN)
    styles["Heading 1"].paragraph_format.space_before = Pt(14)
    styles["Heading 1"].paragraph_format.space_after = Pt(7)
    styles["Heading 2"].font.size = Pt(12)
    styles["Heading 2"].font.color.rgb = RGBColor.from_string(DARK)

    header = section.header.paragraphs[0]
    header.text = "MIMIC RESEARCH WORKSPACE"
    header.runs[0].font.size = Pt(8)
    header.runs[0].font.color.rgb = RGBColor.from_string(GRAY)
    title = document.add_paragraph()
    title.paragraph_format.space_after = Pt(8)
    title_run = title.add_run(label["title"])
    title_run.bold = True
    title_run.font.size = Pt(25)
    title_run.font.color.rgb = RGBColor.from_string(DARK)
    subtitle = document.add_paragraph(localize(spec.get("title") or "Research analysis", language))
    subtitle.runs[0].bold = True
    subtitle.runs[0].font.size = Pt(14)
    subtitle.runs[0].font.color.rgb = RGBColor.from_string(DARK)
    notice = document.add_paragraph()
    notice.paragraph_format.space_before = Pt(9)
    notice.paragraph_format.space_after = Pt(12)
    notice_run = notice.add_run(evidence_notice(artifact, language))
    notice_run.bold = True
    notice_run.font.color.rgb = RGBColor.from_string("9A6200")

    document.add_heading(label["design"], level=1)
    facts = [
        [label["question"], spec.get("research_question", "NA")],
        [label["population"], localize(spec.get("population", {}).get("description", "NA"), language)],
        [label["index"], f"{localize(spec.get('index_time', {}).get('event', 'NA'), language)}；{localize(spec.get('index_time', {}).get('selection_rule', 'NA'), language)}"],
        [label["exposure"], ", ".join(localize(item.get("name", ""), language) for item in spec.get("exposure_or_predictors", []))],
        [label["outcome"], localize(spec.get("outcome", {}).get("name", "NA"), language)],
    ]
    add_docx_table(document, facts, [1.45, 5.25], header=False)

    document.add_heading(label["methods"], level=1)
    adjusted = analysis.get("adjusted_estimates")
    method_text = (
        "以 R 为主要统计运行时。主要分析报告暴露组与非暴露组风险、风险差及粗 OR（95% CI）；次要 Logistic 回归调整年龄和性别。零格时使用 Haldane–Anscombe 0.5 校正。"
        if language == "zh" else
        "R is the primary statistical runtime. The primary analysis reports group risks, risk difference, and crude OR (95% CI); a secondary logistic regression adjusts for age and sex. Haldane-Anscombe 0.5 correction is used only for zero cells."
    )
    document.add_paragraph(method_text)
    document.add_paragraph(f"R {analysis.get('runtime', {}).get('version', 'NA')} | {analysis['method']['id']} v{analysis['method']['version']}")
    add_docx_statistical_review(document, artifact, language)

    document.add_heading(label["results"], level=1)
    counts, estimates = analysis["counts"], analysis["estimates"]
    metrics = [
        ["总样本量（N）" if language == "zh" else "N", counts["total"], "比值比（OR，95% CI）" if language == "zh" else "OR (95% CI)", f"{fmt(estimates['odds_ratio'])} ({fmt(estimates['odds_ratio_ci_95'][0])}-{fmt(estimates['odds_ratio_ci_95'][1])})"],
        ["暴露组 / 事件数" if language == "zh" else "Exposed / events", f"{counts['exposed']} / {counts['exposed_events']}", "风险差" if language == "zh" else "Risk difference", fmt(estimates["risk_difference"])],
        ["非暴露组 / 事件数" if language == "zh" else "Unexposed / events", f"{counts['unexposed']} / {counts['unexposed_events']}", "乳酸阈值" if language == "zh" else "Threshold", f"> {fmt(analysis['threshold_mmol_l'], 1)} mmol/L"],
    ]
    add_docx_table(document, metrics, [1.35, 1.65, 1.45, 2.25], header=False)
    document.add_picture(str(figures[0]), width=Inches(5.8))
    caption = document.add_paragraph(label["figure1"])
    caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
    caption.runs[0].italic = True
    caption.runs[0].font.size = Pt(9)

    table_one = next((table for table in analysis.get("publication_outputs", {}).get("tables", []) if table.get("id") == "table_1"), None)
    if table_one:
        document.add_heading(label["table1"], level=1)
        widths = [2.25] + [4.45 / max(1, len(table_one["columns"]) - 1)] * (len(table_one["columns"]) - 1)
        add_docx_table(document, localized_table([table_one["columns"], *table_one["rows"]], language), widths)

    document.add_heading(label["adjusted"], level=1)
    if adjusted:
        document.add_paragraph(
            ("年龄、性别调整后 OR" if language == "zh" else "Age- and sex-adjusted OR")
            + f": {fmt(adjusted['exposure_odds_ratio'])} (95% CI {fmt(adjusted['exposure_odds_ratio_ci_95'][0])}-{fmt(adjusted['exposure_odds_ratio_ci_95'][1])}); {format_p_value(adjusted['p_value'])}."
        )
    sensitivity = analysis.get("sensitivity_analyses", {})
    threshold_rows = [["乳酸阈值" if language == "zh" else "Threshold", "暴露组" if language == "zh" else "Exposed", "非暴露组" if language == "zh" else "Unexposed", "OR", "95% CI"]]
    for row in sensitivity.get("threshold_results", []):
        threshold_rows.append([fmt(row["threshold_mmol_l"], 1), str(row["exposed"]), str(row["unexposed"]), fmt(row["odds_ratio"]), f"{fmt(row['odds_ratio_ci_95'][0])}-{fmt(row['odds_ratio_ci_95'][1])}"])
    if len(threshold_rows) > 1:
        add_docx_table(document, threshold_rows, [1.15, 1.15, 1.15, 1.15, 2.1])
        document.add_picture(str(figures[1]), width=Inches(5.6))
        caption = document.add_paragraph(label["figure2"])
        caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
        caption.runs[0].italic = True
        caption.runs[0].font.size = Pt(9)

    document.add_heading(label["diagnostics"], level=1)
    diagnostic = analysis.get("diagnostics", {})
    diagnostic_rows = [
        ["源队列合格记录" if language == "zh" else "Eligible source records", diagnostic.get("source_eligible_records", "NA")],
        ["缺失早期乳酸" if language == "zh" else "Missing early lactate", diagnostic.get("source_missing_exposure", "NA")],
        ["排除的异常乳酸测量" if language == "zh" else "Excluded implausible lactate measurements", diagnostic.get("excluded_source_measurements", "NA")],
        ["完整病例数" if language == "zh" else "Complete cases", diagnostic.get("complete_cases", "NA")],
        ["缺失记录数" if language == "zh" else "Missing records", diagnostic.get("missing_records", "NA")],
        ["每参数事件数（EPP）" if language == "zh" else "Events per parameter", fmt(diagnostic.get("events_per_parameter"))],
        ["模型收敛" if language == "zh" else "Model converged", diagnostic.get("model_converged", "NA")],
        ["最大方差膨胀因子（VIF）" if language == "zh" else "Maximum VIF", fmt(diagnostic.get("maximum_vif"))],
        ["稀疏数据警告" if language == "zh" else "Sparse-data warning", diagnostic.get("sparse_data_warning", "NA")],
    ]
    add_docx_table(document, diagnostic_rows, [2.3, 4.4], header=False)

    document.add_heading(label["limitations"], level=1)
    for warning in analysis.get("warnings", []):
        document.add_paragraph(localize(warning, language), style="List Bullet")

    document.add_heading(label["repro"], level=1)
    add_docx_table(document, [
        [label["run"], artifact["run_id"]],
        [label["evidence"], artifact["evidence_level"]],
        ["研究设计完整性" if language == "zh" else "Study integrity", artifact["study"]["integrity_id"]],
        ["分析制品完整性" if language == "zh" else "Artifact integrity", artifact["integrity_id"]],
        ["数据来源" if language == "zh" else "Data source", f"{analysis['provenance']['data_source_id']} ({analysis['provenance']['data_source_version']})"],
    ], [1.45, 5.25], header=False)
    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    footer.add_run(f"{artifact['run_id']} | {artifact['created_at']}").font.size = Pt(8)
    def force_font(run: Any) -> None:
        run.font.name = "Arial Unicode MS"
        fonts = run._element.get_or_add_rPr().get_or_add_rFonts()
        for attribute in ["ascii", "hAnsi", "eastAsia", "cs"]:
            fonts.set(qn(f"w:{attribute}"), "Arial Unicode MS")
        language_tag = OxmlElement("w:lang")
        language_tag.set(qn("w:val"), "zh-CN" if language == "zh" else "en-US")
        language_tag.set(qn("w:eastAsia"), "zh-CN" if language == "zh" else "en-US")
        run._element.get_or_add_rPr().append(language_tag)

    for paragraph in document.paragraphs:
        for run in paragraph.runs:
            force_font(run)
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    for run in paragraph.runs:
                        force_font(run)
    document.save(output)


def generic_report_rows(analysis: dict[str, Any], language: str) -> list[list[str]]:
    zh = language == "zh"
    if analysis["analysis_kind"] == "binary_prediction":
        e = analysis["estimates"]
        return [
            ["总样本量" if zh else "Total observations", analysis["counts"]["total"]],
            ["开发集 / 验证集" if zh else "Development / validation", f"{analysis['counts']['development']} / {analysis['counts']['validation']}"],
            ["AUROC", fmt(e["auroc"])], ["Brier 评分" if zh else "Brier score", fmt(e["brier_score"])],
            ["校准截距 / 斜率" if zh else "Calibration intercept / slope", f"{fmt(e['calibration_intercept'])} / {fmt(e['calibration_slope'])}"],
            ["开发集 Youden 阈值" if zh else "Development-set Youden threshold", fmt(e["probability_threshold"])],
            ["敏感度 / 特异度" if zh else "Sensitivity / specificity", f"{fmt(e['sensitivity'])} / {fmt(e['specificity'])}"],
        ]
    e, d = analysis["estimates"], analysis["diagnostics"]
    return [
        ["总样本量" if zh else "Total observations", analysis["counts"]["total"]],
        ["治疗组 / 对照组" if zh else "Treated / untreated", f"{analysis['counts']['treated']} / {analysis['counts']['untreated']}"],
        ["加权治疗组 / 对照组风险" if zh else "Weighted treated / untreated risk", f"{fmt(e['weighted_treated_risk'])} / {fmt(e['weighted_untreated_risk'])}"],
        ["风险差（95% CI）" if zh else "Risk difference (95% CI)", f"{fmt(e['risk_difference'])} ({fmt(e['risk_difference_ci_95'][0])}-{fmt(e['risk_difference_ci_95'][1])})"],
        ["风险比" if zh else "Risk ratio", fmt(e["risk_ratio"])],
        ["最大 SMD：加权前 / 后" if zh else "Maximum SMD: before / after", f"{fmt(d['maximum_smd_before'])} / {fmt(d['maximum_smd_after'])}"],
        ["有效样本量" if zh else "Effective sample size", fmt(d["effective_sample_size"])],
        ["Bootstrap 重复次数" if zh else "Bootstrap replicates", d["bootstrap_replicates"]],
    ]


def method_profile(analysis: dict[str, Any], language: str) -> dict[str, Any]:
    zh = language == "zh"
    if analysis["analysis_kind"] == "binary_prediction":
        diagnostics = analysis["diagnostics"]
        return {
            "rationale": (
                "预设结局为二分类事件，且分析目标是估计 ICU 入科后 24 小时内的个体事件概率，因此采用 Logistic 回归。该模型参数可解释，适合作为预设的基准预测模型。"
                if zh else
                "The prespecified outcome is binary and the target is an individual 24-hour event probability, so logistic regression was selected as an interpretable baseline prediction model."
            ),
            "specification": (
                "预设入科时预测变量；完整病例分析；固定 70/30 开发-验证划分；Youden 阈值仅在开发集选择，再在验证集评价。"
                if zh else
                "Prespecified admission predictors; complete-case analysis; fixed 70/30 development-validation split; Youden threshold selected in development and evaluated in validation."
            ),
            "assumptions": ([
                "预测变量必须早于结局，且不得包含结局发生后的信息。",
                "每位患者仅保留一条符合规则的记录，观察相互独立。",
                "连续变量与 logit 近似线性，不存在严重多重共线性。",
                "结局事件数足以支持拟合参数，开发集与验证集代表同一目标人群。",
            ] if zh else [
                "Predictors precede the outcome and contain no post-outcome information.",
                "One eligible record is retained per patient and observations are independent.",
                "Continuous predictors are approximately linear on the logit scale and severe collinearity is absent.",
                "Outcome events support the fitted parameters and both splits represent the same target population.",
            ]),
            "diagnostic": (
                f"模型{'已' if diagnostics['model_converged'] else '未'}收敛；每参数事件数为 {fmt(diagnostics['events_per_parameter'])}。AUROC评价区分度，Brier评分评价总体概率误差，校准截距和斜率评价预测风险与观察风险的一致性。"
                if zh else
                f"The model {'converged' if diagnostics['model_converged'] else 'did not converge'}; events per parameter were {fmt(diagnostics['events_per_parameter'])}. AUROC assesses discrimination, Brier score overall probabilistic error, and calibration agreement between predicted and observed risk."
            ),
            "boundary": (
                "内部验证不能替代外部验证、临床效用评价或决策曲线分析。"
                if zh else
                "Internal validation does not replace external validation, clinical-utility assessment, or decision-curve analysis."
            ),
        }
    diagnostics = analysis["diagnostics"]
    return {
        "rationale": (
            "研究目标是估计目标人群的边际平均治疗效果。采用稳定化倾向评分逆概率加权，使治疗组与对照组在已测量的治疗前混杂因素上更接近平衡。"
            if zh else
            "The target is a marginal average treatment effect. Stabilized inverse-probability weighting was selected to improve balance in measured pretreatment confounders between treatment groups."
        ),
        "specification": (
            "Logistic 倾向评分模型纳入年龄、性别、SOFA评分和基线乳酸；稳定化权重在第1和第99百分位截尾；使用百分位Bootstrap区间量化不确定性。"
            if zh else
            "The logistic propensity model includes age, sex, SOFA score, and baseline lactate; stabilized weights are truncated at the 1st and 99th percentiles; percentile bootstrap intervals quantify uncertainty."
        ),
        "assumptions": ([
            "治疗定义满足一致性，且个体之间无干扰。",
            "所有调整变量均在治疗前测量，且给定已测量混杂后满足条件交换性。",
            "每种协变量组合下均存在接受和未接受治疗的可能性，即满足阳性假设。",
            "倾向评分模型设定充分；未测量或测量不准确的混杂仍可能造成偏倚。",
        ] if zh else [
            "Treatment is well defined under consistency and there is no interference between individuals.",
            "All adjustment variables precede treatment and conditional exchangeability holds given measured confounders.",
            "Both treatment options remain possible across covariate patterns under positivity.",
            "The propensity model is adequately specified; unmeasured or poorly measured confounding can still bias the estimate.",
        ]),
        "diagnostic": (
            f"加权后最大绝对SMD为 {fmt(diagnostics['maximum_smd_after'])}，常用实践目标为低于0.10；有效样本量为 {fmt(diagnostics['effective_sample_size'])}，极端权重比例为 {fmt(diagnostics['extreme_weight_fraction'])}。"
            if zh else
            f"Maximum absolute SMD after weighting was {fmt(diagnostics['maximum_smd_after'])}, with below 0.10 used as a practical target; effective sample size was {fmt(diagnostics['effective_sample_size'])} and the extreme-weight fraction was {fmt(diagnostics['extreme_weight_fraction'])}."
        ),
        "boundary": (
            "风险差和风险比应与Bootstrap区间、平衡诊断和阳性评估一并解释。若因果识别前提不成立，不应作因果解释。"
            if zh else
            "Interpret risk difference and risk ratio together with bootstrap uncertainty, balance diagnostics, and positivity. Causal interpretation is not justified when identification assumptions fail."
        ),
    }


def build_generic_docx(bundle: dict[str, Any], output: Path, language: str, figures: tuple[Path, Path]) -> None:
    artifact, analysis = bundle["artifact"], bundle["artifact"]["analysis"]
    spec, zh = artifact["study"]["spec"], language == "zh"
    document = Document()
    configure_docx(document, language)
    title = document.add_paragraph()
    title.paragraph_format.space_after = Pt(4)
    title_run = title.add_run("临床研究统计分析报告" if zh else "Clinical Research Statistical Analysis Report")
    title_run.bold = True
    title_run.font.size = Pt(23)
    title_run.font.color.rgb = RGBColor.from_string(DARK)
    subtitle = document.add_paragraph(localize(spec.get("title", "Research analysis"), language))
    subtitle.runs[0].bold = True
    subtitle.runs[0].font.size = Pt(13)
    notice = document.add_paragraph(evidence_notice(artifact, language))
    notice.runs[0].bold = True
    notice.runs[0].font.color.rgb = RGBColor.from_string("9A6200")
    document.add_heading("研究设计" if zh else "Study design", 1)
    add_docx_table(document, [["研究问题" if zh else "Research question", localize(spec.get("research_question", "NA"), language)], ["研究人群" if zh else "Population", localize(spec.get("population", {}).get("description", "NA"), language)], ["结局" if zh else "Outcome", localize(spec.get("outcome", {}).get("name", "NA"), language)]], [1.5, 5.2], header=False)
    profile = method_profile(analysis, language)
    document.add_heading("方法选择与分析设定" if zh else "Method selection and analysis specification", 1)
    document.add_paragraph(profile["rationale"])
    add_docx_table(document, [["具体设定" if zh else "Specification", profile["specification"]], ["目标估计" if zh else "Target estimate", spec.get("estimand", {}).get("summary_measure", "NA")]], [1.5, 5.2], header=False)
    document.add_heading("适用前提与数据要求" if zh else "Assumptions and data requirements", 1)
    for assumption in profile["assumptions"]:
        document.add_paragraph(assumption, style="List Bullet")
    document.add_heading("主要结果与诊断" if zh else "Primary results and diagnostics", 1)
    add_docx_table(document, generic_report_rows(analysis, language), [2.8, 3.9], header=False)
    document.add_paragraph(profile["diagnostic"])
    add_docx_statistical_review(document, artifact, language)
    document.add_heading("统计图表" if zh else "Statistical figures", 1)
    figure_table = document.add_table(rows=1, cols=2)
    figure_table.autofit = False
    for index, figure in enumerate(figures):
        cell = figure_table.cell(0, index)
        cell.width = Inches(3.25)
        paragraph = cell.paragraphs[0]
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        paragraph.add_run().add_picture(str(figure), width=Inches(3.05))
        caption = cell.add_paragraph(("图" if zh else "Figure") + f" {index + 1}")
        caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
    document.add_heading("统计解释与边界" if zh else "Statistical interpretation and boundaries", 1)
    document.add_paragraph(profile["boundary"])
    for warning in analysis["warnings"]: document.add_paragraph(localize(warning, language), style="List Bullet")
    document.add_heading("可复现性" if zh else "Reproducibility", 1)
    add_docx_table(document, [["运行 ID" if zh else "Run ID", artifact["run_id"]], ["统计方法" if zh else "Method", f"{analysis['method']['id']} v{analysis['method']['version']}"], ["数据来源" if zh else "Data source", analysis["provenance"]["data_source_id"]], ["完整性" if zh else "Integrity", artifact["integrity_id"]]], [1.5, 5.2], header=False)
    footer = document.sections[0].footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    footer.add_run(f"{artifact['run_id']} | {artifact['created_at']}").font.size = Pt(8)
    apply_docx_fonts(document, language)
    document.save(output)


def build_generic_pdf(bundle: dict[str, Any], output: Path, language: str, figures: tuple[Path, Path]) -> None:
    artifact, analysis = bundle["artifact"], bundle["artifact"]["analysis"]
    spec, zh = artifact["study"]["spec"], language == "zh"
    selected_font = font_path()
    if selected_font and selected_font.lower().endswith(".ttf"): pdfmetrics.registerFont(TTFont("ClinicalGeneric", selected_font)); font = "ClinicalGeneric"
    else: pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light")); font = "STSong-Light"
    normal = ParagraphStyle("generic-body", fontName=font, fontSize=9.5, leading=14, textColor=colors.HexColor(f"#{DARK}"))
    h1 = ParagraphStyle("generic-h1", parent=normal, fontSize=16, leading=20, textColor=colors.HexColor(f"#{GREEN}"), spaceBefore=12, spaceAfter=7)
    profile = method_profile(analysis, language)
    story = [Paragraph("临床研究统计分析报告" if zh else "Clinical Research Statistical Analysis Report", ParagraphStyle("generic-title", parent=h1, fontSize=23, leading=28)), Paragraph(localize(spec.get("title", "Research analysis"), language), h1), Paragraph(evidence_notice(artifact, language), normal), Paragraph("方法选择与分析设定" if zh else "Method selection and analysis specification", h1), Paragraph(profile["rationale"], normal), Paragraph(profile["specification"], normal), Paragraph("适用前提与数据要求" if zh else "Assumptions and data requirements", h1)]
    story.extend(Paragraph(assumption, normal, bulletText="•") for assumption in profile["assumptions"])
    story.append(Paragraph("主要结果与诊断" if zh else "Primary results and diagnostics", h1))
    rows = [[Paragraph(str(a), normal), Paragraph(str(b), normal)] for a, b in generic_report_rows(analysis, language)]
    table = Table(rows, colWidths=[2.5*inch, 4*inch]); table.setStyle(TableStyle([("GRID",(0,0),(-1,-1),0.35,colors.HexColor("#C8D8D3")),("VALIGN",(0,0),(-1,-1),"MIDDLE"),("LEFTPADDING",(0,0),(-1,-1),7),("RIGHTPADDING",(0,0),(-1,-1),7),("TOPPADDING",(0,0),(-1,-1),6),("BOTTOMPADDING",(0,0),(-1,-1),6),("BACKGROUND",(0,0),(0,-1),colors.HexColor(f"#{PALE}"))])); story.extend([table, Spacer(1,7), Paragraph(profile["diagnostic"], normal), Spacer(1,10)])
    review = statistical_review_content(artifact, language)
    story.extend([Paragraph("统计审查结论" if zh else "Statistical review decision", h1), Paragraph(review["decision"], normal)])
    review_rows = [[Paragraph(str(a), normal), Paragraph(str(b), normal)] for a, b in statistical_review_rows(artifact, language)]
    review_table = Table(review_rows, colWidths=[1.8*inch, 4.7*inch]); review_table.setStyle(TableStyle([("GRID",(0,0),(-1,-1),0.35,colors.HexColor("#C8D8D3")),("VALIGN",(0,0),(-1,-1),"MIDDLE"),("LEFTPADDING",(0,0),(-1,-1),7),("RIGHTPADDING",(0,0),(-1,-1),7),("TOPPADDING",(0,0),(-1,-1),6),("BOTTOMPADDING",(0,0),(-1,-1),6),("BACKGROUND",(0,0),(0,-1),colors.HexColor(f"#{PALE}"))])); story.extend([review_table, Spacer(1,8)])
    story.extend(Paragraph(("阻断：" if zh else "Blocking: ") + reason, normal) for reason in review["blocking"])
    story.extend(Paragraph(("警告：" if zh else "Warning: ") + warning, normal) for warning in review["warnings"])
    for index, figure in enumerate(figures): story.extend([PdfImage(str(figure), width=5.4*inch, height=2.95*inch), Paragraph(("图" if zh else "Figure")+f" {index+1}", normal), Spacer(1,8)])
    story.extend([Paragraph("统计解释与边界" if zh else "Statistical interpretation and boundaries", h1), Paragraph(profile["boundary"], normal)])
    story.extend(Paragraph(f"- {localize(warning, language)}", normal) for warning in analysis["warnings"])
    story.extend([Paragraph("可复现性" if zh else "Reproducibility", h1), Paragraph(f"Run ID: {artifact['run_id']}<br/>Method: {analysis['method']['id']} v{analysis['method']['version']}<br/>Integrity: {artifact['integrity_id']}", normal)])
    SimpleDocTemplate(str(output), pagesize=letter, leftMargin=.82*inch, rightMargin=.82*inch, topMargin=.72*inch, bottomMargin=.7*inch).build(story)


def build_pdf(bundle: dict[str, Any], output: Path, language: str, figures: tuple[Path, Path]) -> None:
    artifact, analysis = bundle["artifact"], bundle["artifact"]["analysis"]
    if analysis.get("analysis_kind"):
        build_generic_pdf(bundle, output, language, figures)
        return
    spec, label = artifact["study"]["spec"], labels(language)
    selected_font = font_path()
    if selected_font and selected_font.lower().endswith(".ttf"):
        pdfmetrics.registerFont(TTFont("ClinicalSans", selected_font))
        font = "ClinicalSans"
    else:
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        font = "STSong-Light"
    styles = getSampleStyleSheet()
    normal = ParagraphStyle("clinical-body", parent=styles["BodyText"], fontName=font, fontSize=9.5, leading=14, textColor=colors.HexColor(f"#{DARK}"), spaceAfter=6)
    h1 = ParagraphStyle("clinical-h1", parent=normal, fontSize=15, leading=19, textColor=colors.HexColor(f"#{GREEN}"), spaceBefore=12, spaceAfter=7)
    title = ParagraphStyle("clinical-title", parent=normal, fontSize=24, leading=29, textColor=colors.HexColor(f"#{DARK}"), spaceAfter=8)
    caption = ParagraphStyle("clinical-caption", parent=normal, fontSize=8.5, alignment=TA_CENTER, textColor=colors.HexColor(f"#{GRAY}"))
    table_header = ParagraphStyle("clinical-table-header", parent=normal, textColor=colors.white)
    story: list[Any] = [Paragraph(label["title"], title), Paragraph(localize(spec.get("title", "Research analysis"), language), h1), Paragraph(evidence_notice(artifact, language), ParagraphStyle("notice", parent=normal, textColor=colors.HexColor("#9A6200"))), Spacer(1, 6)]

    def heading(value: str) -> None:
        story.append(Paragraph(value, h1))

    def table(rows: list[list[Any]], widths: list[float], header: bool = False) -> None:
        values = [[Paragraph(str(value), table_header if header and row_index == 0 else normal) for value in row] for row_index, row in enumerate(rows)]
        item = Table(values, colWidths=[width * inch for width in widths], repeatRows=1 if header else 0, hAlign="LEFT")
        commands = [("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#C8D8D3")), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]
        if header:
            commands += [("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(f"#{DARK}")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white)]
        for index in range(1 if header else 0, len(rows)):
            if index % 2 == 0:
                commands.append(("BACKGROUND", (0, index), (-1, index), colors.HexColor(f"#{PALE}")))
        item.setStyle(TableStyle(commands))
        story.extend([item, Spacer(1, 8)])

    heading(label["design"])
    table([[label["question"], spec.get("research_question", "NA")], [label["population"], localize(spec.get("population", {}).get("description", "NA"), language)], [label["index"], f"{localize(spec.get('index_time', {}).get('event', 'NA'), language)}; {localize(spec.get('index_time', {}).get('selection_rule', 'NA'), language)}"], [label["exposure"], ", ".join(localize(item.get("name", ""), language) for item in spec.get("exposure_or_predictors", []))], [label["outcome"], localize(spec.get("outcome", {}).get("name", "NA"), language)]], [1.35, 5.15])
    heading(label["methods"])
    story.append(Paragraph(("主要分析使用 R，报告风险、风险差、粗 OR（95% CI），并以年龄和性别调整 Logistic 回归作为次要分析。" if language == "zh" else "The primary analysis uses R to report risks, risk difference, and crude OR (95% CI), with age- and sex-adjusted logistic regression as a secondary analysis."), normal))
    review = statistical_review_content(artifact, language)
    heading("统计审查结论" if language == "zh" else "Statistical review decision")
    story.append(Paragraph(review["decision"], normal))
    table(statistical_review_rows(artifact, language), [1.8, 4.7])
    for reason in review["blocking"]:
        story.append(Paragraph(("阻断：" if language == "zh" else "Blocking: ") + reason, normal))
    for warning in review["warnings"]:
        story.append(Paragraph(("警告：" if language == "zh" else "Warning: ") + warning, normal))
    counts, estimates = analysis["counts"], analysis["estimates"]
    heading(label["results"])
    table([["总样本量（N）" if language == "zh" else "N", counts["total"], "OR（95% CI）" if language == "zh" else "OR (95% CI)", f"{fmt(estimates['odds_ratio'])} ({fmt(estimates['odds_ratio_ci_95'][0])}-{fmt(estimates['odds_ratio_ci_95'][1])})"], ["暴露组/事件数" if language == "zh" else "Exposed/events", f"{counts['exposed']}/{counts['exposed_events']}", "风险差" if language == "zh" else "Risk difference", fmt(estimates["risk_difference"])]], [1.25, 1.25, 1.45, 2.55])
    story.append(KeepTogether([PdfImage(str(figures[0]), width=5.3 * inch, height=2.9 * inch), Paragraph(label["figure1"], caption)]))
    table_one = next((item for item in analysis.get("publication_outputs", {}).get("tables", []) if item.get("id") == "table_1"), None)
    if table_one:
        heading(label["table1"])
        widths = [2.1] + [4.4 / max(1, len(table_one["columns"]) - 1)] * (len(table_one["columns"]) - 1)
        table(localized_table([table_one["columns"], *table_one["rows"]], language), widths, True)
    heading(label["adjusted"])
    adjusted = analysis.get("adjusted_estimates")
    if adjusted:
        adjusted_label = "年龄、性别调整后 OR" if language == "zh" else "Adjusted OR"
        story.append(Paragraph(f"{adjusted_label}: {fmt(adjusted['exposure_odds_ratio'])} (95% CI {fmt(adjusted['exposure_odds_ratio_ci_95'][0])}-{fmt(adjusted['exposure_odds_ratio_ci_95'][1])}); {format_p_value(adjusted['p_value'])}.", normal))
    threshold_rows = [["乳酸阈值" if language == "zh" else "Threshold", "暴露组" if language == "zh" else "Exposed", "非暴露组" if language == "zh" else "Unexposed", "OR", "95% CI"]]
    for row in analysis.get("sensitivity_analyses", {}).get("threshold_results", []):
        threshold_rows.append([fmt(row["threshold_mmol_l"], 1), row["exposed"], row["unexposed"], fmt(row["odds_ratio"]), f"{fmt(row['odds_ratio_ci_95'][0])}-{fmt(row['odds_ratio_ci_95'][1])}"])
    if len(threshold_rows) > 1:
        table(threshold_rows, [1.1, 1.1, 1.1, 1.1, 2.1], True)
        story.append(KeepTogether([PdfImage(str(figures[1]), width=5.3 * inch, height=3.18 * inch), Paragraph(label["figure2"], caption)]))
    story.append(PageBreak())
    heading(label["diagnostics"])
    diagnostic = analysis.get("diagnostics", {})
    table([["源队列合格记录" if language == "zh" else "Eligible source records", diagnostic.get("source_eligible_records", "NA")], ["缺失早期乳酸" if language == "zh" else "Missing early lactate", diagnostic.get("source_missing_exposure", "NA")], ["排除的异常乳酸测量" if language == "zh" else "Excluded implausible lactate measurements", diagnostic.get("excluded_source_measurements", "NA")], ["完整病例数" if language == "zh" else "Complete cases", diagnostic.get("complete_cases", "NA")], ["调整变量缺失记录" if language == "zh" else "Missing adjustment records", diagnostic.get("missing_records", "NA")], ["每参数事件数（EPP）" if language == "zh" else "Events/parameter", fmt(diagnostic.get("events_per_parameter"))], ["模型收敛" if language == "zh" else "Model converged", diagnostic.get("model_converged", "NA")], ["最大 VIF" if language == "zh" else "Maximum VIF", fmt(diagnostic.get("maximum_vif"))], ["稀疏数据警告" if language == "zh" else "Sparse-data warning", diagnostic.get("sparse_data_warning", "NA")]], [2.1, 4.4])
    heading(label["limitations"])
    for warning in analysis.get("warnings", []):
        story.append(Paragraph(f"- {localize(warning, language)}", normal))
    heading(label["repro"])
    table([[label["run"], artifact["run_id"]], [label["evidence"], artifact["evidence_level"]], ["研究设计完整性" if language == "zh" else "Study integrity", artifact["study"]["integrity_id"]], ["分析制品完整性" if language == "zh" else "Artifact integrity", artifact["integrity_id"]], ["数据来源" if language == "zh" else "Data source", f"{analysis['provenance']['data_source_id']} ({analysis['provenance']['data_source_version']})"]], [1.35, 5.15])

    def footer(canvas: Any, document: Any) -> None:
        canvas.saveState()
        canvas.setFont(font, 8)
        canvas.setFillColor(colors.HexColor(f"#{GRAY}"))
        canvas.drawString(0.82 * inch, 0.48 * inch, artifact["run_id"])
        canvas.drawRightString(7.68 * inch, 0.48 * inch, str(document.page))
        canvas.restoreState()

    SimpleDocTemplate(str(output), pagesize=letter, leftMargin=0.82 * inch, rightMargin=0.82 * inch, topMargin=0.72 * inch, bottomMargin=0.7 * inch, title=label["title"], author="MIMIC Research Workspace").build(story, onFirstPage=footer, onLaterPages=footer)


def dynamic_rows(artifact: dict[str, Any], language: str) -> list[tuple[str, str]]:
    """Project an aggregate-only dynamic run into stable report rows."""
    zh = language == "zh"
    analysis = artifact.get("analysis") or {}
    cohort = artifact.get("cohort") or {}
    provenance = artifact.get("data_provenance") or {}
    counts = analysis.get("counts", {})
    estimates = analysis.get("estimates", {})
    data_source = provenance.get("data_source_id") or provenance.get("profile_id") or provenance.get("data_mode", "NA")
    source_version = provenance.get("data_source_version") or provenance.get("archive_sha256", "NA")
    if zh:
        count_summary = (
            f"暴露组：事件 {counts.get('exposed_events', 'NA')}，非事件 {counts.get('exposed_non_events', 'NA')}；"
            f"未暴露组：事件 {counts.get('unexposed_events', 'NA')}，非事件 {counts.get('unexposed_non_events', 'NA')}"
        )
        estimate_summary = (
            f"暴露组风险 {fmt(estimates.get('exposed_risk'), 4)}；未暴露组风险 {fmt(estimates.get('unexposed_risk'), 4)}；"
            f"风险差 {fmt(estimates.get('risk_difference'), 4)}；风险比 {fmt(estimates.get('risk_ratio'), 3)}；"
            f"优势比 {fmt(estimates.get('odds_ratio'), 3)}"
        )
        diagnostic_summary = "全量复算一致，验证通过" if analysis.get("diagnostics", {}).get("repeated_baseline_equal") else "详见结构化诊断记录"
    else:
        count_summary = f"Exposed: {counts.get('exposed_events', 'NA')} events / {counts.get('exposed_non_events', 'NA')} non-events; unexposed: {counts.get('unexposed_events', 'NA')} events / {counts.get('unexposed_non_events', 'NA')} non-events"
        estimate_summary = "; ".join(f"{key}={fmt(value, 4)}" for key, value in estimates.items())
        diagnostic_summary = "Full-data repeat matched; validation passed" if analysis.get("diagnostics", {}).get("repeated_baseline_equal") else "See structured diagnostics"
    rows = [
        ("状态" if zh else "Status", artifact.get("status", "unknown")),
        ("研究目的" if zh else "Research purpose", artifact.get("study", {}).get("intent_family", "NA")),
        ("统计方法" if zh else "Statistical method", analysis.get("method", "not executed")),
        ("分析单位" if zh else "Analysis units", cohort.get("analysis_units", "NA")),
        ("完整记录" if zh else "Complete records", cohort.get("complete_rows", "NA")),
        ("排除记录" if zh else "Excluded records", cohort.get("excluded_rows", "NA")),
        ("数据来源" if zh else "Data source", f"{data_source} ({source_version})"),
        ("事件计数" if zh else "Event counts", count_summary),
        ("效应估计" if zh else "Effect estimates", estimate_summary),
        ("诊断" if zh else "Diagnostics", diagnostic_summary),
        ("复现标识" if zh else "Reproducibility", artifact.get("reproducibility_id", "NA")),
        ("产物完整性" if zh else "Artifact integrity", artifact.get("integrity_id", "NA")),
    ]
    return [(str(label), str(value)) for label, value in rows]


def build_dynamic_docx(bundle: dict[str, Any], output: Path, language: str) -> None:
    artifact = bundle["artifact"]
    study, zh = artifact.get("study", {}), language == "zh"
    document = Document()
    configure_docx(document, language)
    document.add_heading("MIMIC-IV 本地数据统计报告" if zh else "MIMIC-IV Local Data Statistical Report", 0)
    document.add_paragraph(study.get("title") or study.get("research_question") or "Research analysis")
    document.add_paragraph(evidence_notice(artifact, language))
    document.add_heading("研究设计" if zh else "Study design", 1)
    add_docx_table(document, [
        ["研究问题" if zh else "Research question", study.get("research_question", "NA")],
        ["研究人群" if zh else "Population", study.get("population", {}).get("description", "NA")],
        ["结局" if zh else "Outcome", study.get("outcome", {}).get("name", "NA")],
    ], [1.5, 5.2], header=False)
    document.add_heading("统计结果与复现信息" if zh else "Statistical results and reproducibility", 1)
    add_docx_table(document, [list(row) for row in dynamic_rows(artifact, language)], [1.6, 5.1], header=False)
    publication = (artifact.get("analysis") or {}).get("publication_outputs") or {}
    for table_data in publication.get("tables", []):
        document.add_heading(localize(table_data.get("title", "Table"), language), 1)
        add_docx_table(document, [table_data.get("columns", []), *table_data.get("rows", [])], [6.7 / max(1, len(table_data.get("columns", [])))] * max(1, len(table_data.get("columns", []))), header=True)
    for listing in publication.get("listings", []):
        document.add_heading(localize(listing.get("title", "Aggregate listing"), language), 1)
        document.add_paragraph("仅包含聚合结果，不含患者级记录。" if zh else "Aggregate only; no patient-level records.")
        add_docx_table(document, [listing.get("columns", []), *listing.get("rows", [])], [6.7 / max(1, len(listing.get("columns", [])))] * max(1, len(listing.get("columns", []))), header=True)
    figures = publication.get("figures", [])
    if figures:
        document.add_heading("图形" if zh else "Figures", 1)
        estimates = (artifact.get("analysis") or {}).get("estimates", {})
        image = Image.new("RGB", (1200, 360), "white")
        draw = ImageDraw.Draw(image)
        selected_font = font_path()
        chart_font = ImageFont.truetype(selected_font, 28) if selected_font else ImageFont.load_default()
        draw.text((60, 35), localize(figures[0].get("title", "Primary effect estimate"), language), fill="#173B33", font=chart_font)
        draw.line((120, 190, 1080, 190), fill="#C8D8D3", width=5)
        estimate = estimates.get("estimate", estimates.get("odds_ratio", estimates.get("risk_ratio")))
        if isinstance(estimate, (int, float)) and math.isfinite(estimate):
            draw.ellipse((585, 175, 615, 205), fill="#0B806A")
            draw.text((520, 235), f"Estimate: {estimate:.4f}", fill="#173B33", font=chart_font)
        stream = BytesIO(); image.save(stream, format="PNG"); stream.seek(0)
        document.add_picture(stream, width=Inches(6.5))
    blockers = artifact.get("blockers", [])
    warnings = artifact.get("warnings", [])
    if blockers:
        document.add_heading("阻断证据" if zh else "Blocking evidence", 1)
        for item in blockers:
            document.add_paragraph(f"{item.get('stage', 'unknown')}/{item.get('code', 'unknown')}: {item.get('message', '')}", style="List Bullet")
    if warnings:
        document.add_heading("警告" if zh else "Warnings", 1)
        for item in warnings:
            document.add_paragraph(localize(str(item), language), style="List Bullet")
    apply_docx_fonts(document, language)
    document.save(output)


def build_dynamic_pdf(bundle: dict[str, Any], output: Path, language: str) -> None:
    artifact = bundle["artifact"]
    study, zh = artifact.get("study", {}), language == "zh"
    selected_font = font_path()
    if selected_font and selected_font.lower().endswith(".ttf"):
        pdfmetrics.registerFont(TTFont("DynamicReport", selected_font)); font = "DynamicReport"
    else:
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light")); font = "STSong-Light"
    normal = ParagraphStyle("dynamic-body", fontName=font, fontSize=9, leading=13, textColor=colors.HexColor(f"#{DARK}"))
    heading = ParagraphStyle("dynamic-heading", parent=normal, fontSize=15, leading=20, textColor=colors.HexColor(f"#{GREEN}"), spaceBefore=10, spaceAfter=6)
    story: list[Any] = [
        Paragraph("MIMIC-IV 本地数据统计报告" if zh else "MIMIC-IV Local Data Statistical Report", heading),
        Paragraph(escape(str(study.get("title") or study.get("research_question") or "Research analysis")), normal),
        Paragraph(escape(evidence_notice(artifact, language)), normal),
    ]
    values = [[Paragraph(escape(label), normal), Paragraph(escape(value), normal)] for label, value in dynamic_rows(artifact, language)]
    table = Table(values, colWidths=[1.55 * inch, 5.0 * inch])
    table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#C8D8D3")), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("BACKGROUND", (0, 0), (0, -1), colors.HexColor(f"#{PALE}"))]))
    story.extend([Paragraph("统计结果与复现信息" if zh else "Statistical results and reproducibility", heading), table])
    publication = (artifact.get("analysis") or {}).get("publication_outputs") or {}
    for table_data in publication.get("tables", []):
        story.append(Paragraph(escape(localize(table_data.get("title", "Table"), language)), heading))
        cells = [[Paragraph(escape(str(value)), normal) for value in row] for row in [table_data.get("columns", []), *table_data.get("rows", [])]]
        if cells:
            rendered = Table(cells, repeatRows=1)
            rendered.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .35, colors.HexColor("#C8D8D3")), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(f"#{MINT}")), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
            story.append(rendered)
    for listing in publication.get("listings", []):
        story.append(Paragraph(escape(localize(listing.get("title", "Aggregate listing"), language)), heading))
        story.append(Paragraph("仅包含聚合结果，不含患者级记录。" if zh else "Aggregate only; no patient-level records.", normal))
        cells = [[Paragraph(escape(str(value)), normal) for value in row] for row in [listing.get("columns", []), *listing.get("rows", [])]]
        if cells:
            rendered = Table(cells, repeatRows=1)
            rendered.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .35, colors.HexColor("#C8D8D3")), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(f"#{MINT}"))]))
            story.append(rendered)
    if publication.get("figures"):
        story.append(Paragraph("图形" if zh else "Figures", heading))
        estimates = (artifact.get("analysis") or {}).get("estimates", {})
        estimate = estimates.get("estimate", estimates.get("odds_ratio", estimates.get("risk_ratio")))
        drawing = Drawing(470, 125); drawing.add(Line(45, 55, 425, 55, strokeColor=colors.HexColor("#C8D8D3"), strokeWidth=2))
        if isinstance(estimate, (int, float)) and math.isfinite(estimate):
            drawing.add(Circle(235, 55, 6, fillColor=colors.HexColor(f"#{GREEN}"), strokeColor=None)); drawing.add(String(190, 20, f"Estimate: {estimate:.4f}", fontName=font, fontSize=9, fillColor=colors.HexColor(f"#{DARK}")))
        story.append(drawing)
    for title, items in [(("阻断证据" if zh else "Blocking evidence"), artifact.get("blockers", [])), (("警告" if zh else "Warnings"), artifact.get("warnings", []))]:
        if items:
            story.append(Paragraph(title, heading))
            for item in items:
                text = f"{item.get('stage', 'unknown')}/{item.get('code', 'unknown')}: {item.get('message', '')}" if isinstance(item, dict) else str(item)
                story.append(Paragraph(escape(localize(text, language)), normal, bulletText="•"))
    SimpleDocTemplate(str(output), pagesize=letter, leftMargin=.82*inch, rightMargin=.82*inch, topMargin=.72*inch, bottomMargin=.7*inch).build(story)


def aggregate_validation_bundle(report: dict[str, Any]) -> dict[str, Any]:
    """Adapt a persisted full-archive aggregate validation report without recomputing it."""
    scenario = (report.get("validation", {}).get("scenarios") or [{}])[0]
    run = scenario.get("run", {})
    result = run.get("result", {})
    quality = run.get("quality", {})
    study = report.get("study", {})
    provenance = report.get("data_provenance", {})
    integrity = report.get("report_integrity_id", "unknown")
    counts = result.get("counts", {})
    estimates = result.get("estimates", {})
    publication_outputs = {
        "tables": [
            {"id": "table_1", "title": "表 1　暴露组与未暴露组结局分布", "columns": ["组别", "事件", "非事件", "合计"], "rows": [["暴露组", str(counts.get("exposed_events", "NA")), str(counts.get("exposed_non_events", "NA")), str((counts.get("exposed_events") or 0) + (counts.get("exposed_non_events") or 0))], ["未暴露组", str(counts.get("unexposed_events", "NA")), str(counts.get("unexposed_non_events", "NA")), str((counts.get("unexposed_events") or 0) + (counts.get("unexposed_non_events") or 0))]]},
            {"id": "primary_results", "title": "表 2　主要效应估计", "columns": ["指标", "估计值"], "rows": [[key, fmt(value, 4)] for key, value in estimates.items()]},
            {"id": "model_diagnostics", "title": "表 3　复现与诊断", "columns": ["诊断", "结果"], "rows": [["验证状态", str(scenario.get("status", "unknown"))], ["重复计算一致", str(report.get("validation", {}).get("stability", {}).get("repeated_baseline_equal", False))]]},
            {"id": "sensitivity_analysis", "title": "表 4　敏感性分析状态", "columns": ["分析", "结果"], "rows": [["协变量调整与替代表型", "当前汇总输入不支持，需新的完整执行图"]]},
        ],
        "listings": [{"id": "cohort_flow", "title": "Listing 1　聚合队列流程", "columns": ["阶段", "记录数"], "rows": [["完整住院记录", str(quality.get("complete_rows", "NA"))], ["排除记录", str(quality.get("excluded_rows", "NA"))]], "privacy": "aggregate_only"}],
        "figures": [{"id": "primary_effect", "title": "图 1　主要效应估计", "mime_type": "image/svg+xml", "content": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"800\" height=\"190\"></svg>"}],
    }
    return {
        "artifact": {
            "schema_version": "2.0.0",
            "run_id": f"validation:{str(integrity).removeprefix('sha256:')[:20]}",
            "created_at": provenance.get("generated_at", "not recorded"),
            "status": "completed" if scenario.get("status") == "passed" else "blocked",
            "evidence_level": "local_mimic_archive_execution",
            "study": {
                "schema_version": study.get("schema_version", "1.0.0"),
                "title": study.get("research_question", "MIMIC-IV aggregate analysis"),
                "research_question": study.get("research_question", "not recorded"),
                "intent_family": study.get("intent_family", "association"),
                "population": {"description": study.get("population", "not recorded")},
                "outcome": {"name": study.get("outcome", "not recorded")},
            },
            "manifest": report.get("manifest", {}),
            "data_provenance": provenance,
            "cohort": {
                "analysis_units": quality.get("rows_seen"),
                "complete_rows": quality.get("complete_rows"),
                "excluded_rows": quality.get("excluded_rows"),
            },
            "analysis": {
                "method": result.get("method_id", report.get("method", {}).get("method_id", "not recorded")),
                "counts": result.get("counts", {}),
                "estimates": result.get("estimates", {}),
                "diagnostics": {"validation_status": scenario.get("status"), "repeated_baseline_equal": report.get("validation", {}).get("stability", {}).get("repeated_baseline_equal")},
                "sensitivity": {},
                "publication_outputs": publication_outputs,
            },
            "diagnostic_decision": "reportable_with_warnings" if scenario.get("status") == "passed" else "blocked",
            "blockers": [] if scenario.get("status") == "passed" else [{"stage": "statistics", "code": "VALIDATION_NOT_PASSED", "message": "The aggregate validation scenario did not pass."}],
            "warnings": list(report.get("manifest", {}).get("limitations", [])) + list(result.get("model", {}).get("limitations", [])),
            "reproducibility_id": result.get("input_integrity_id", integrity),
            "integrity_id": integrity,
        },
        "report_markdown": "",
    }


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("usage: build_clinical_report.py INPUT OUTPUT docx|pdf en|zh")
    source, output, format_, language = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4]
    if format_ not in {"docx", "pdf"} or language not in {"en", "zh"}:
        raise SystemExit("unsupported report format or language")
    bundle = json.loads(source.read_text(encoding="utf-8"))
    if bundle.get("validation") and bundle.get("report_integrity_id"):
        bundle = aggregate_validation_bundle(bundle)
    if bundle.get("artifact", {}).get("schema_version") == "2.0.0":
        if format_ == "docx":
            build_dynamic_docx(bundle, output, language)
        else:
            build_dynamic_pdf(bundle, output, language)
        return
    figures = make_figures(bundle, output.parent, language)
    if format_ == "docx":
        build_docx(bundle, output, language, figures)
    else:
        build_pdf(bundle, output, language, figures)


if __name__ == "__main__":
    main()

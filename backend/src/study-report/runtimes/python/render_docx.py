"""Render a language-neutral report document (JSON blocks) to .docx.

Input is aggregate report content only (text, tables, figure paths); never patient-level rows.
Usage: python render_docx.py <document.json> <output.docx>
"""
import json
import os
import sys

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.shared import Inches, Pt


def set_fonts(document):
    style = document.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(10)
    # East Asian text needs an explicit East Asian font or Word falls back inconsistently.
    style.element.rPr.rFonts.set(qn("w:eastAsia"), "SimSun")


def add_table(document, block):
    if block.get("caption"):
        caption = document.add_paragraph()
        caption.add_run(block["caption"]).bold = True
    columns = block["columns"]
    table = document.add_table(rows=1, cols=len(columns))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for index, name in enumerate(columns):
        cell = table.rows[0].cells[index]
        cell.text = str(name)
        for run in cell.paragraphs[0].runs:
            run.bold = True
    for row in block["rows"]:
        cells = table.add_row().cells
        for index, value in enumerate(row[: len(columns)]):
            cells[index].text = str(value)
    document.add_paragraph()


def main():
    source, target = sys.argv[1], sys.argv[2]
    with open(source, encoding="utf-8") as handle:
        report = json.load(handle)
    document = Document()
    set_fonts(document)
    for block in report["blocks"]:
        kind = block["kind"]
        if kind == "heading":
            document.add_heading(block["text"], level=block["level"] - 1 if block["level"] > 1 else 0)
        elif kind == "paragraph":
            document.add_paragraph(block["text"])
        elif kind == "list":
            for item in block["items"]:
                document.add_paragraph(item, style="List Bullet")
        elif kind == "table":
            add_table(document, block)
        elif kind == "figure":
            if os.path.exists(block["path"]):
                document.add_picture(block["path"], width=Inches(6.0))
                document.add_paragraph(block["caption"]).italic = True
            else:
                document.add_paragraph(f"[missing figure: {block['caption']}]")
    document.save(target)


if __name__ == "__main__":
    main()

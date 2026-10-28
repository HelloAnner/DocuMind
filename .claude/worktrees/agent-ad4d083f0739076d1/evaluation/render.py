"""D03 文档渲染：把受控制度文本渲染成真实 docx/pdf/pptx/md/txt 文件。

渲染后立即回读文本，核验标准事实确实出现在源文件中；核验失败的文档
不进入语料（避免标准与文件不一致）。所有文件只写 R/corpus/files/。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .corpus_spec import DocSpec
from .facts import FACTS

NORMALIZE_RE = re.compile(r"\s+")


def normalize(text: str) -> str:
    return NORMALIZE_RE.sub("", text or "")


def block_lines(spec: DocSpec) -> list[str]:
    lines: list[str] = [spec.title]
    for block in spec.blocks:
        kind = block.get("type")
        if kind == "heading":
            lines.append(str(block.get("text", "")))
        elif kind == "paragraph":
            lines.append(str(block.get("text", "")))
        elif kind == "table":
            header = [str(c) for c in block.get("header", [])]
            lines.append(" ".join(header))
            for row in block.get("rows", []):
                lines.append(" ".join(str(c) for c in row))
    return lines


def render_txt(spec: DocSpec, path: Path) -> None:
    parts: list[str] = [spec.title, ""]
    for block in spec.blocks:
        kind = block.get("type")
        if kind == "heading":
            parts.append(str(block.get("text", "")))
        elif kind == "paragraph":
            parts.append(str(block.get("text", "")))
        elif kind == "table":
            parts.append("\t".join(str(c) for c in block.get("header", [])))
            for row in block.get("rows", []):
                parts.append("\t".join(str(c) for c in row))
        parts.append("")
    path.write_text("\n".join(parts), encoding="utf-8")


def render_md(spec: DocSpec, path: Path) -> None:
    parts: list[str] = [f"# {spec.title}", ""]
    for block in spec.blocks:
        kind = block.get("type")
        if kind == "heading":
            level = int(block.get("level", 1)) + 1
            parts.append("#" * min(level, 6) + " " + str(block.get("text", "")))
        elif kind == "paragraph":
            parts.append(str(block.get("text", "")))
        elif kind == "table":
            parts.append("| " + " | ".join(str(c) for c in block.get("header", [])) + " |")
            parts.append("|" + "---|" * len(block.get("header", [])))
            for row in block.get("rows", []):
                parts.append("| " + " | ".join(str(c) for c in row) + " |")
        parts.append("")
    path.write_text("\n".join(parts), encoding="utf-8")


def render_docx(spec: DocSpec, path: Path) -> None:
    from docx import Document

    document = Document()
    document.add_heading(spec.title, level=0)
    for block in spec.blocks:
        kind = block.get("type")
        if kind == "heading":
            document.add_heading(str(block.get("text", "")), level=int(block.get("level", 1)))
        elif kind == "paragraph":
            document.add_paragraph(str(block.get("text", "")))
        elif kind == "table":
            header = [str(c) for c in block.get("header", [])]
            rows = block.get("rows", [])
            table = document.add_table(rows=1, cols=len(header))
            table.style = "Table Grid"
            for index, cell in enumerate(header):
                table.rows[0].cells[index].text = cell
            for row in rows:
                cells = table.add_row().cells
                for index, value in enumerate(row):
                    cells[index].text = str(value)
    document.save(str(path))


def render_pptx(spec: DocSpec, path: Path) -> None:
    from pptx import Presentation
    from pptx.util import Inches

    presentation = Presentation()
    cover = presentation.slides.add_slide(presentation.slide_layouts[0])
    cover.shapes.title.text = spec.title
    if cover.placeholders and len(cover.placeholders) > 1:
        cover.placeholders[1].text = f"{spec.revision}｜{spec.authority}"

    buffer: list[dict[str, Any]] = []

    def flush() -> None:
        nonlocal buffer
        if not buffer:
            return
        slide = presentation.slides.add_slide(presentation.slide_layouts[5])
        slide.shapes.title.text = str(buffer[0].get("text", "内容"))
        top = Inches(1.5)
        for block in buffer[1:]:
            kind = block.get("type")
            if kind == "paragraph":
                box = slide.shapes.add_textbox(Inches(0.6), top, Inches(9), Inches(1))
                box.text_frame.text = str(block.get("text", ""))
                top += Inches(0.9)
            elif kind == "table":
                header = [str(c) for c in block.get("header", [])]
                rows = block.get("rows", [])
                shape = slide.shapes.add_table(
                    rows=len(rows) + 1, cols=len(header), left=Inches(0.6), top=top,
                    width=Inches(9), height=Inches(0.4 * (len(rows) + 1)),
                )
                table = shape.table
                for index, cell in enumerate(header):
                    table.cell(0, index).text = cell
                for rindex, row in enumerate(rows, start=1):
                    for cindex, value in enumerate(row):
                        table.cell(rindex, cindex).text = str(value)
                top += Inches(0.45 * (len(rows) + 1))
        buffer = []

    for block in spec.blocks:
        if block.get("type") == "heading":
            flush()
            buffer.append(block)
        else:
            if not buffer:
                buffer.append({"type": "heading", "text": spec.title})
            buffer.append(block)
    flush()
    presentation.save(str(path))


def render_pdf(spec: DocSpec, path: Path) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib import colors
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    cjk = _ensure_cjk_font(pdfmetrics, TTFont, UnicodeCIDFont)

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("DocTitle", parent=styles["Title"], fontName=cjk, fontSize=18, leading=24)
    h1 = ParagraphStyle("H1", parent=styles["Heading1"], fontName=cjk, fontSize=14, leading=20)
    body = ParagraphStyle("Body", parent=styles["BodyText"], fontName=cjk, fontSize=10.5, leading=16)

    flow: list[Any] = [Paragraph(spec.title, title_style), Spacer(1, 12)]
    for block in spec.blocks:
        kind = block.get("type")
        if kind == "heading":
            flow.append(Paragraph(str(block.get("text", "")), h1))
        elif kind == "paragraph":
            flow.append(Paragraph(str(block.get("text", "")), body))
            flow.append(Spacer(1, 6))
        elif kind == "table":
            data = [[str(c) for c in block.get("header", [])]]
            data += [[str(c) for c in row] for row in block.get("rows", [])]
            table = Table(data, repeatRows=1)
            table.setStyle(TableStyle([
                ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                ("BACKGROUND", (0, 0), (-1, 0), colors.whitesmoke),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("FONTNAME", (0, 0), (-1, -1), cjk),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]))
            flow.append(table)
            flow.append(Spacer(1, 8))
    SimpleDocTemplate(
        str(path), pagesize=A4, title=spec.title, author=spec.authority,
    ).build(flow)


CJK_FONT_CANDIDATES = (
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
)


def _ensure_cjk_font(pdfmetrics: Any, ttfont_cls: Any, cid_cls: Any) -> str:
    """优先嵌入真实 TTF（文本可被正确抽取），否则退回 CID 字体。"""
    name = "DocuMindCJK"
    if name in pdfmetrics.getRegisteredFontNames():
        return name
    for candidate in CJK_FONT_CANDIDATES:
        if Path(candidate).exists():
            try:
                pdfmetrics.registerFont(ttfont_cls(name, candidate))
                return name
            except Exception:  # noqa: BLE001 —— 字体不可用时换下一个候选
                continue
    fallback = "STSong-Light"
    if fallback not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(cid_cls(fallback))
    return fallback


RENDERERS = {
    "txt": render_txt,
    "md": render_md,
    "docx": render_docx,
    "pptx": render_pptx,
    "pdf": render_pdf,
}


def read_back(spec: DocSpec, path: Path) -> str:
    """从渲染文件回读纯文本，用于源文件核验（离线读取，不依赖被测解析器）。"""
    suffix = path.suffix.lower()
    if suffix in (".txt", ".md"):
        return path.read_text(encoding="utf-8")
    if suffix == ".docx":
        from docx import Document
        document = Document(str(path))
        parts = [p.text for p in document.paragraphs]
        for table in document.tables:
            for row in table.rows:
                parts.append(" ".join(cell.text for cell in row.cells))
        return "\n".join(parts)
    if suffix == ".pptx":
        from pptx import Presentation
        presentation = Presentation(str(path))
        parts: list[str] = []
        for slide in presentation.slides:
            for shape in slide.shapes:
                if shape.has_text_frame:
                    parts.append(shape.text_frame.text)
                if getattr(shape, "has_table", False) and shape.has_table:
                    for row in shape.table.rows:
                        parts.append(" ".join(cell.text for cell in row.cells))
        return "\n".join(parts)
    if suffix == ".pdf":
        import fitz
        document = fitz.open(str(path))
        try:
            return "\n".join(page.get_text() for page in document)
        finally:
            document.close()
    raise ValueError(f"不支持回读: {path}")


def render_corpus(specs: list[DocSpec], target_dir: Path) -> list[dict[str, Any]]:
    from .core import sha256_file, utc_iso

    target_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    for spec in specs:
        path = target_dir / spec.file_name
        RENDERERS[spec.file_type](spec, path)
        text = normalize(read_back(spec, path))
        fact_ids = [fact.fact_id for fact in FACTS if fact.document_ref == spec.document_ref]
        missing: list[str] = []
        for fact in FACTS:
            if fact.document_ref != spec.document_ref:
                continue
            for term in fact.required_terms:
                if normalize(term) not in text:
                    missing.append(f"{fact.fact_id}:{term}")
        records.append({
            "document_ref": spec.document_ref,
            "document_family": spec.document_family,
            "revision": spec.revision,
            "file_name": spec.file_name,
            "file_type": spec.file_type,
            "file_path": str(path),
            "file_sha256": sha256_file(path),
            "bytes": path.stat().st_size,
            "title": spec.title,
            "authority": spec.authority,
            "published_at": spec.published_at,
            "effective_from": spec.effective_from,
            "effective_to": spec.effective_to,
            "fact_ids": fact_ids,
            "source_verification": "pass" if not missing else "fail",
            "missing_terms": missing,
            "readback_chars": len(text),
            "rendered_at": utc_iso(),
        })
    return records

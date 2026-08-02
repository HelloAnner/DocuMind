#!/usr/bin/env python3
"""Build customer-facing Word documents and the dated delivery archive."""

from __future__ import annotations

import datetime as dt
import re
import shutil
import sys
import tempfile
import zipfile
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "docs" / "deliverables"
DIST_DIR = ROOT / "dist"
BUNDLE_NAME = "DocuMind项目交付文档书"
DOCUMENTS = [("independent-deployment.md", "DocuMind独立部署说明书.docx")]
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def x(text: str) -> str:
    return escape(text, quote=True)


def parse_source(path: Path) -> tuple[dict[str, str], list[tuple]]:
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    metadata: dict[str, str] = {}
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end < 0:
            raise ValueError(f"{path}: front matter 未闭合")
        for line in text[4:end].splitlines():
            key, sep, value = line.partition(":")
            if not sep:
                raise ValueError(f"{path}: 无效元数据：{line}")
            metadata[key.strip()] = value.strip().strip('"')
        text = text[end + 5 :]
    for required in ("title", "subtitle", "version"):
        if not metadata.get(required):
            raise ValueError(f"{path}: 缺少元数据 {required}")

    lines = text.splitlines()
    blocks: list[tuple] = []
    paragraph: list[str] = []

    def flush() -> None:
        if paragraph:
            blocks.append(("p", " ".join(part.strip() for part in paragraph)))
            paragraph.clear()

    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("```"):
            flush()
            kind = line[3:].strip() or "code"
            i += 1
            body: list[str] = []
            while i < len(lines) and not lines[i].startswith("```"):
                body.append(lines[i])
                i += 1
            if i == len(lines):
                raise ValueError(f"{path}: 代码块未闭合")
            blocks.append(("flow" if kind == "flow" else "code", kind, body))
        elif re.match(r"^#{1,3} ", line):
            flush()
            marks, title = line.split(" ", 1)
            blocks.append(("heading", len(marks), title.strip()))
        elif line.startswith("> "):
            flush()
            blocks.append(("quote", line[2:].strip()))
        elif re.match(r"^[-*] ", line):
            flush()
            blocks.append(("bullet", line[2:].strip()))
        elif re.match(r"^\d+\. ", line):
            flush()
            number, value = line.split(". ", 1)
            blocks.append(("number", number, value.strip()))
        elif "|" in line and i + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-+", lines[i + 1]):
            flush()
            rows = [[cell.strip() for cell in line.strip().strip("|").split("|")]]
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append([cell.strip() for cell in lines[i].strip().strip("|").split("|")])
                i += 1
            blocks.append(("table", rows))
            i -= 1
        elif line.strip() == "---":
            flush()
            blocks.append(("rule",))
        elif not line.strip():
            flush()
        else:
            paragraph.append(line)
        i += 1
    flush()
    return metadata, blocks


def run(text: str, *, bold: bool = False, code: bool = False, color: str | None = None, size: int | None = None) -> str:
    props = [
        '<w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei"/>',
        '<w:lang w:val="zh-CN" w:eastAsia="zh-CN"/>',
    ]
    if bold:
        props.append("<w:b/>")
    if code:
        props[0] = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/>'
    if color:
        props.append(f'<w:color w:val="{color}"/>')
    if size:
        props.append(f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>')
    space = ' xml:space="preserve"' if text[:1].isspace() or text[-1:].isspace() else ""
    return f"<w:r><w:rPr>{''.join(props)}</w:rPr><w:t{space}>{x(text)}</w:t></w:r>"


def inline(text: str) -> str:
    parts = re.split(r"(\*\*.+?\*\*|`[^`]+`)", text)
    output = []
    for part in parts:
        if part.startswith("**") and part.endswith("**"):
            output.append(run(part[2:-2], bold=True))
        elif part.startswith("`") and part.endswith("`"):
            output.append(run(part[1:-1], code=True, color="0F766E"))
        elif part:
            output.append(run(part))
    return "".join(output)


def paragraph(text: str = "", *, style: str | None = None, before: int = 0, after: int = 120,
              indent: int = 0, shade: str | None = None, border: str | None = None,
              align: str | None = None, raw_runs: str | None = None) -> str:
    props = []
    if style:
        props.append(f'<w:pStyle w:val="{style}"/>')
    props.append(f'<w:spacing w:before="{before}" w:after="{after}" w:line="360" w:lineRule="auto"/>')
    if indent:
        props.append(f'<w:ind w:left="{indent}"/>')
    if shade:
        props.append(f'<w:shd w:val="clear" w:color="auto" w:fill="{shade}"/>')
    if border:
        props.append(f'<w:pBdr><w:left w:val="single" w:sz="18" w:space="12" w:color="{border}"/></w:pBdr>')
    if align:
        props.append(f'<w:jc w:val="{align}"/>')
    return f"<w:p><w:pPr>{''.join(props)}</w:pPr>{raw_runs if raw_runs is not None else inline(text)}</w:p>"


def cell(text: str, *, header: bool = False, fill: str | None = None, align: str | None = None) -> str:
    fill = fill or ("0F766E" if header else "FFFFFF")
    color = "FFFFFF" if header else "243447"
    content = paragraph(
        align=align,
        after=40,
        raw_runs=run(text, bold=header, color=color),
    )
    return (
        f'<w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>'
        '<w:tcMar><w:top w:w="110" w:type="dxa"/><w:left w:w="130" w:type="dxa"/>'
        '<w:bottom w:w="110" w:type="dxa"/><w:right w:w="130" w:type="dxa"/></w:tcMar></w:tcPr>'
        f"{content}</w:tc>"
    )


def table(rows: list[list[str]]) -> str:
    width = max(len(row) for row in rows)
    normalized = [row + [""] * (width - len(row)) for row in rows]
    body = []
    for row_index, row in enumerate(normalized):
        cells = "".join(cell(value, header=row_index == 0, fill="F2F7F6" if row_index and row_index % 2 == 0 else None) for value in row)
        body.append(f"<w:tr>{cells}</w:tr>")
    return (
        '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="autofit"/>'
        '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="B8CCC8"/>'
        '<w:left w:val="single" w:sz="4" w:color="B8CCC8"/><w:bottom w:val="single" w:sz="4" w:color="B8CCC8"/>'
        '<w:right w:val="single" w:sz="4" w:color="B8CCC8"/><w:insideH w:val="single" w:sz="4" w:color="D9E5E2"/>'
        '<w:insideV w:val="single" w:sz="4" w:color="D9E5E2"/></w:tblBorders></w:tblPr>'
        f"{''.join(body)}</w:tbl>{paragraph(after=80)}"
    )


def flow(lines: list[str]) -> str:
    edges = []
    for line in lines:
        parts = [part.strip() for part in line.split("|")]
        if len(parts) != 3 or not all(parts):
            raise ValueError(f"flow 图每行必须是“起点|关系|终点”：{line}")
        edges.append(parts)
    body = []
    colors = ("DDF2EE", "EAF0F8")
    for index, (source, relation, target) in enumerate(edges):
        row = cell(source, fill=colors[index % 2], align="center")
        row += cell(f"── {relation} →", fill="FFFFFF", align="center")
        row += cell(target, fill=colors[index % 2], align="center")
        body.append(f"<w:tr>{row}</w:tr>")
    return (
        '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblLayout w:type="fixed"/>'
        '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/>'
        '<w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders></w:tblPr>'
        f"{''.join(body)}</w:tbl>{paragraph(after=100)}"
    )


def render_body(metadata: dict[str, str], blocks: list[tuple], generated: str) -> str:
    title = metadata["title"]
    cover = [
        paragraph("DOCUMIND", before=900, after=260, align="center", raw_runs=run("DOCUMIND", bold=True, color="0F766E", size=28)),
        paragraph(title, before=900, after=220, align="center", raw_runs=run(title, bold=True, color="17324D", size=52)),
        paragraph(metadata["subtitle"], after=700, align="center", raw_runs=run(metadata["subtitle"], color="4B6478", size=26)),
        table([["文档版本", "生成日期", "适用场景"], [metadata["version"], generated, "客户内网独立部署"]]),
        paragraph("客户交付文件 · 请妥善保管", before=900, align="center", raw_runs=run("客户交付文件 · 请妥善保管", color="64748B", size=18)),
        '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
        paragraph("目录", style="Heading1"),
        '<w:p><w:fldSimple w:instr="TOC \\o &quot;1-3&quot; \\h \\z \\u"><w:r><w:t>打开 Word 后右键更新目录</w:t></w:r></w:fldSimple></w:p>',
        '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
    ]
    output = cover
    skipped_title = False
    for block in blocks:
        kind = block[0]
        if kind == "heading":
            _, level, text = block
            if not skipped_title and level == 1 and text == title:
                skipped_title = True
                continue
            output.append(paragraph(text, style=f"Heading{level}"))
        elif kind == "p":
            output.append(paragraph(block[1]))
        elif kind == "quote":
            text = re.sub(r"^\[![^]]+\]\s*", "", block[1])
            output.append(paragraph(text, shade="EAF5F3", border="0F766E", indent=180))
        elif kind == "bullet":
            output.append(paragraph(f"•  {block[1]}", indent=360, after=60))
        elif kind == "number":
            output.append(paragraph(f"{block[1]}.  {block[2]}", indent=360, after=60))
        elif kind == "table":
            output.append(table(block[1]))
        elif kind == "flow":
            output.append(flow(block[2]))
        elif kind == "code":
            code_lines = block[2] or [""]
            for line in code_lines:
                output.append(paragraph(shade="F3F5F7", indent=220, after=0, raw_runs=run(line or " ", code=True, color="243447", size=18)))
            output.append(paragraph(after=80))
        elif kind == "rule":
            output.append('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="0F766E"/></w:pBdr></w:pPr></w:p>')
    output.append(
        '<w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:footerReference w:type="default" r:id="rId2"/>'
        '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1276" w:bottom="1134" w:left="1276" w:header="560" w:footer="560"/>'
        '<w:cols w:space="708"/><w:docGrid w:linePitch="312"/></w:sectPr>'
    )
    return "".join(output)


def styles_xml() -> str:
    headings = []
    for level, size, color, before in ((1, 34, "17324D", 360), (2, 28, "0F766E", 280), (3, 24, "36566F", 220)):
        headings.append(
            f'<w:style w:type="paragraph" w:styleId="Heading{level}"><w:name w:val="heading {level}"/>'
            f'<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/>'
            f'<w:keepLines/><w:spacing w:before="{before}" w:after="120"/><w:outlineLvl w:val="{level - 1}"/></w:pPr>'
            f'<w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display" w:eastAsia="Microsoft YaHei"/>'
            f'<w:b/><w:color w:val="{color}"/><w:sz w:val="{size}"/><w:szCs w:val="{size}"/></w:rPr></w:style>'
        )
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="{W}">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>
  <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  {''.join(headings)}
</w:styles>'''


def write_docx(source: Path, target: Path, generated: str) -> None:
    metadata, blocks = parse_source(source)
    body = render_body(metadata, blocks, generated)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    entries = {
        "[Content_Types].xml": f'''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>''',
        "_rels/.rels": '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>''',
        "word/document.xml": f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="{W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>{body}</w:body></w:document>''',
        "word/_rels/document.xml.rels": '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>''',
        "word/styles.xml": styles_xml(),
        "word/settings.xml": f'''<?xml version="1.0" encoding="UTF-8"?><w:settings xmlns:w="{W}"><w:updateFields w:val="true"/><w:defaultTabStop w:val="420"/></w:settings>''',
        "word/header1.xml": f'''<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="{W}">{paragraph("DOCUMIND  ·  客户交付文档", align="right", raw_runs=run("DOCUMIND  ·  客户交付文档", bold=True, color="0F766E", size=17))}</w:hdr>''',
        "word/footer1.xml": f'''<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="{W}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>{run("DocuMind 独立部署说明书  |  第 ", color="64748B", size=16)}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>{run(" 页", color="64748B", size=16)}</w:p></w:ftr>''',
        "docProps/core.xml": f'''<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>{x(metadata['title'])}</dc:title><dc:creator>DocuMind</dc:creator><dc:subject>客户独立部署</dc:subject><dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified></cp:coreProperties>''',
        "docProps/app.xml": '''<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>DocuMind Documentation Builder</Application><AppVersion>1.0</AppVersion></Properties>''',
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    validate_docx(target, metadata["title"])


def validate_docx(path: Path, title: str) -> None:
    with zipfile.ZipFile(path) as archive:
        bad = archive.testzip()
        if bad:
            raise ValueError(f"{path}: DOCX 损坏：{bad}")
        document = archive.read("word/document.xml").decode("utf-8")
        if title not in document or "TOC" not in document:
            raise ValueError(f"{path}: DOCX 缺少标题或目录")


def build() -> Path:
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    generated = dt.date.today().isoformat()
    archive_name = f"{dt.date.today():%Y%m%d}-{BUNDLE_NAME}.zip"
    final_dir = DIST_DIR / BUNDLE_NAME
    final_archive = DIST_DIR / archive_name
    with tempfile.TemporaryDirectory(prefix=".docs-build-", dir=DIST_DIR) as temp_name:
        temp = Path(temp_name)
        bundle = temp / BUNDLE_NAME
        for source_name, output_name in DOCUMENTS:
            source = SOURCE_DIR / source_name
            if not source.is_file():
                raise FileNotFoundError(f"缺少交付文档源文件：{source}")
            write_docx(source, bundle / output_name, generated)
        temp_archive = temp / archive_name
        with zipfile.ZipFile(temp_archive, "w", zipfile.ZIP_DEFLATED) as archive:
            for document in sorted(bundle.iterdir()):
                archive.write(document, f"{BUNDLE_NAME}/{document.name}")
        with zipfile.ZipFile(temp_archive) as archive:
            if archive.testzip() or len(archive.namelist()) != len(DOCUMENTS):
                raise ValueError("交付压缩包校验失败")
        if final_dir.exists():
            shutil.rmtree(final_dir)
        shutil.move(bundle, final_dir)
        for old in DIST_DIR.glob(f"*-{BUNDLE_NAME}.zip"):
            old.unlink()
        shutil.move(temp_archive, final_archive)
    print(f"已生成：{final_dir.relative_to(ROOT)}")
    print(f"已打包：{final_archive.relative_to(ROOT)}")
    return final_archive


if __name__ == "__main__":
    try:
        build()
    except Exception as exc:
        print(f"文档生成失败：{exc}", file=sys.stderr)
        raise SystemExit(1)

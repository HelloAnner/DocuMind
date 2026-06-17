use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};
use uuid::Uuid;
use zip::ZipArchive;

pub const PARSER_VERSION: &str = "documind-parser-rust-0.1.0";
pub const SCHEMA_VERSION: &str = "parsed-document-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileType {
    Pdf,
    Docx,
    Pptx,
}

impl FileType {
    pub fn as_str(self) -> &'static str {
        match self {
            FileType::Pdf => "pdf",
            FileType::Docx => "docx",
            FileType::Pptx => "pptx",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedDocument {
    pub doc_id: Uuid,
    pub parse_job_id: Uuid,
    pub file_type: String,
    pub title: String,
    pub pages: Option<i32>,
    pub blocks: Vec<ParsedBlock>,
    pub tables: Vec<ParsedTable>,
    pub warnings: Vec<String>,
    pub quality_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedBlock {
    pub block_id: Uuid,
    pub block_index: i32,
    pub block_type: String,
    pub text: String,
    pub heading_level: Option<i32>,
    pub heading_path: Vec<String>,
    pub page_start: Option<i32>,
    pub page_end: Option<i32>,
    pub slide_index: Option<i32>,
    pub table_id: Option<Uuid>,
    pub bbox: Option<Value>,
    pub source_ref: Value,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedTable {
    pub table_id: Uuid,
    pub block_id: Uuid,
    pub table_index: i32,
    pub title: Option<String>,
    pub heading_path: Vec<String>,
    pub page_start: Option<i32>,
    pub page_end: Option<i32>,
    pub slide_index: Option<i32>,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub cells: Vec<ParsedTableCell>,
    pub markdown: String,
    pub quality: Value,
    pub source_ref: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedTableCell {
    pub cell_id: Uuid,
    pub row_index: i32,
    pub col_index: i32,
    pub rowspan: i32,
    pub colspan: i32,
    pub text: String,
    pub normalized_text: String,
    pub is_header: bool,
    pub data_type: String,
    pub bbox: Option<Value>,
    pub style: Value,
    pub source_ref: Value,
}

#[derive(Debug, Clone)]
pub struct ChunkDraft {
    pub chunk_id: Uuid,
    pub chunk_index: i32,
    pub source_type: String,
    pub content: String,
    pub heading_path: Vec<String>,
    pub page_start: Option<i32>,
    pub page_end: Option<i32>,
    pub slide_start: Option<i32>,
    pub slide_end: Option<i32>,
    pub token_count: i32,
    pub block_ids: Vec<Uuid>,
    pub table_ids: Vec<Uuid>,
    pub metadata: Value,
}

#[derive(Debug, Clone)]
pub struct ParsedBundle {
    pub file_type: FileType,
    pub file_sha256: String,
    pub parsed: ParsedDocument,
    pub chunks: Vec<ChunkDraft>,
}

pub fn parse_document(
    doc_id: Uuid,
    parse_job_id: Uuid,
    file_name: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<ParsedBundle> {
    let file_sha256 = hex_sha256(bytes);
    let file_type = detect_file_type(file_name, mime_type, bytes)?;
    let title = title_from_file_name(file_name);
    let mut parsed = match file_type {
        FileType::Pdf => parse_pdf(doc_id, parse_job_id, &title, bytes)?,
        FileType::Docx => parse_docx(doc_id, parse_job_id, &title, bytes)?,
        FileType::Pptx => parse_pptx(doc_id, parse_job_id, &title, bytes)?,
    };
    let quality = score_quality(&parsed);
    parsed.quality_score = quality;
    let chunks = build_chunks(&parsed);
    Ok(ParsedBundle {
        file_type,
        file_sha256,
        parsed,
        chunks,
    })
}

pub fn detect_file_type(file_name: &str, mime_type: &str, bytes: &[u8]) -> Result<FileType> {
    let ext = file_name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let declared = if mime_type.contains("pdf") {
        Some(FileType::Pdf)
    } else if mime_type.contains("wordprocessingml") || mime_type.contains("msword") {
        Some(FileType::Docx)
    } else if mime_type.contains("presentationml") || mime_type.contains("powerpoint") {
        Some(FileType::Pptx)
    } else {
        None
    };
    let by_ext = match ext.as_str() {
        "pdf" => Some(FileType::Pdf),
        "docx" => Some(FileType::Docx),
        "pptx" => Some(FileType::Pptx),
        _ => None,
    };
    let by_header = if bytes.starts_with(b"%PDF-") {
        Some(FileType::Pdf)
    } else if looks_like_zip(bytes) {
        let entries = zip_entry_names(bytes)?;
        if entries.iter().any(|e| e == "word/document.xml") {
            Some(FileType::Docx)
        } else if entries.iter().any(|e| e == "ppt/presentation.xml")
            && entries.iter().any(|e| e.starts_with("ppt/slides/slide"))
        {
            Some(FileType::Pptx)
        } else {
            None
        }
    } else {
        None
    };

    let detected = by_header.ok_or_else(|| anyhow!("unsupported_or_corrupt_file"))?;
    if let Some(by_ext) = by_ext {
        if by_ext != detected {
            bail!("file_type_mismatch");
        }
    }
    if let Some(declared) = declared {
        if declared != detected {
            bail!("file_type_mismatch");
        }
    }
    Ok(detected)
}

fn parse_docx(
    doc_id: Uuid,
    parse_job_id: Uuid,
    title: &str,
    bytes: &[u8],
) -> Result<ParsedDocument> {
    let mut archive = open_zip(bytes)?;
    let xml = read_zip_text(&mut archive, "word/document.xml")?;
    let doc = roxmltree::Document::parse(&xml).context("invalid_docx_xml")?;
    let body = doc
        .descendants()
        .find(|n| n.tag_name().name() == "body")
        .ok_or_else(|| anyhow!("docx_body_missing"))?;

    let mut blocks = Vec::new();
    let mut tables = Vec::new();
    let mut heading_path: Vec<(i32, String)> = Vec::new();

    for child in body.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "p" => {
                let text = collect_text(child).trim().to_string();
                if text.is_empty() {
                    continue;
                }
                let style = paragraph_style(child);
                let has_numbering = child.descendants().any(|n| n.tag_name().name() == "numPr");
                let heading_level = heading_level_from_style(style.as_deref());
                let block_type = if heading_level.is_some() {
                    "heading"
                } else if has_numbering {
                    "list_item"
                } else {
                    "paragraph"
                };
                if let Some(level) = heading_level {
                    heading_path.retain(|(existing, _)| *existing < level);
                    heading_path.push((level, text.clone()));
                }
                let path = if block_type == "heading" {
                    heading_path
                        .iter()
                        .take(heading_path.len().saturating_sub(1))
                        .map(|(_, h)| h.clone())
                        .collect()
                } else {
                    heading_path.iter().map(|(_, h)| h.clone()).collect()
                };
                blocks.push(ParsedBlock {
                    block_id: Uuid::new_v4(),
                    block_index: blocks.len() as i32,
                    block_type: block_type.to_string(),
                    text,
                    heading_level,
                    heading_path: path,
                    page_start: None,
                    page_end: None,
                    slide_index: None,
                    table_id: None,
                    bbox: None,
                    source_ref: json!({"format": "docx", "node": "w:p", "index": blocks.len()}),
                    metadata: json!({"style": style}),
                });
            }
            "tbl" => {
                let block_id = Uuid::new_v4();
                let table = parse_xml_table(
                    child,
                    doc_id,
                    parse_job_id,
                    block_id,
                    tables.len() as i32,
                    heading_path.iter().map(|(_, h)| h.clone()).collect(),
                    None,
                    None,
                    None,
                    "docx",
                );
                blocks.push(ParsedBlock {
                    block_id,
                    block_index: blocks.len() as i32,
                    block_type: "table".to_string(),
                    text: table.markdown.clone(),
                    heading_level: None,
                    heading_path: table.heading_path.clone(),
                    page_start: None,
                    page_end: None,
                    slide_index: None,
                    table_id: Some(table.table_id),
                    bbox: None,
                    source_ref: json!({"format": "docx", "node": "w:tbl", "index": tables.len()}),
                    metadata: json!({}),
                });
                tables.push(table);
            }
            _ => {}
        }
    }

    Ok(finalize_parsed(
        doc_id,
        parse_job_id,
        "docx",
        title,
        None,
        blocks,
        tables,
    ))
}

fn parse_pptx(
    doc_id: Uuid,
    parse_job_id: Uuid,
    title: &str,
    bytes: &[u8],
) -> Result<ParsedDocument> {
    let mut archive = open_zip(bytes)?;
    let mut slide_names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|name| {
            name.starts_with("ppt/slides/slide")
                && name.ends_with(".xml")
                && name["ppt/slides/slide".len()..]
                    .trim_end_matches(".xml")
                    .chars()
                    .all(|c| c.is_ascii_digit())
        })
        .collect();
    slide_names.sort_by_key(|name| {
        name.trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<i32>()
            .unwrap_or(0)
    });

    let mut blocks = Vec::new();
    let mut tables = Vec::new();
    let mut warnings = Vec::new();

    for (slide_idx, name) in slide_names.iter().enumerate() {
        let xml = read_zip_text(&mut archive, name)?;
        let doc = roxmltree::Document::parse(&xml).context("invalid_pptx_slide_xml")?;
        let mut slide_heading: Vec<String> = Vec::new();
        let mut first_text = true;

        for tbl in doc
            .descendants()
            .filter(|n| n.is_element() && n.tag_name().name() == "tbl")
        {
            let block_id = Uuid::new_v4();
            let table = parse_xml_table(
                tbl,
                doc_id,
                parse_job_id,
                block_id,
                tables.len() as i32,
                slide_heading.clone(),
                None,
                None,
                Some((slide_idx + 1) as i32),
                "pptx",
            );
            blocks.push(ParsedBlock {
                block_id,
                block_index: blocks.len() as i32,
                block_type: "table".to_string(),
                text: table.markdown.clone(),
                heading_level: None,
                heading_path: table.heading_path.clone(),
                page_start: None,
                page_end: None,
                slide_index: Some((slide_idx + 1) as i32),
                table_id: Some(table.table_id),
                bbox: None,
                source_ref: json!({"format": "pptx", "slide": slide_idx + 1, "node": "a:tbl"}),
                metadata: json!({}),
            });
            tables.push(table);
        }

        for p in doc
            .descendants()
            .filter(|n| n.is_element() && n.tag_name().name() == "p")
        {
            if p.ancestors().any(|a| a.tag_name().name() == "tbl") {
                continue;
            }
            let text = collect_text(p).trim().to_string();
            if text.is_empty() {
                continue;
            }
            let is_bullet = p
                .descendants()
                .any(|n| matches!(n.tag_name().name(), "buChar" | "buAutoNum"));
            let block_type = if first_text {
                slide_heading = vec![text.clone()];
                first_text = false;
                "heading"
            } else if is_bullet {
                "list_item"
            } else {
                "paragraph"
            };
            blocks.push(ParsedBlock {
                block_id: Uuid::new_v4(),
                block_index: blocks.len() as i32,
                block_type: block_type.to_string(),
                text,
                heading_level: (block_type == "heading").then_some(1),
                heading_path: if block_type == "heading" {
                    vec![]
                } else {
                    slide_heading.clone()
                },
                page_start: None,
                page_end: None,
                slide_index: Some((slide_idx + 1) as i32),
                table_id: None,
                bbox: None,
                source_ref: json!({"format": "pptx", "slide": slide_idx + 1, "node": "a:p"}),
                metadata: json!({}),
            });
        }

        if first_text {
            warnings.push(format!("slide_{}_empty", slide_idx + 1));
        }
    }

    let mut parsed = finalize_parsed(
        doc_id,
        parse_job_id,
        "pptx",
        title,
        Some(slide_names.len() as i32),
        blocks,
        tables,
    );
    parsed.warnings.extend(warnings);
    Ok(parsed)
}

fn parse_pdf(
    doc_id: Uuid,
    parse_job_id: Uuid,
    title: &str,
    bytes: &[u8],
) -> Result<ParsedDocument> {
    let text = pdf_extract::extract_text_from_mem(bytes).context("pdf_text_extract_failed")?;
    let mut blocks = Vec::new();
    let mut warnings = Vec::new();
    for (page_idx, page_text) in text.split('\x0C').enumerate() {
        let page = (page_idx + 1) as i32;
        for paragraph in split_paragraphs(page_text) {
            let trimmed = paragraph.trim();
            if trimmed.is_empty() {
                continue;
            }
            let is_heading = trimmed.chars().count() <= 80
                && !trimmed.ends_with(['.', '。', '；', ';', '，', ',']);
            blocks.push(ParsedBlock {
                block_id: Uuid::new_v4(),
                block_index: blocks.len() as i32,
                block_type: if is_heading { "heading" } else { "paragraph" }.to_string(),
                text: trimmed.to_string(),
                heading_level: is_heading.then_some(1),
                heading_path: vec![],
                page_start: Some(page),
                page_end: Some(page),
                slide_index: None,
                table_id: None,
                bbox: None,
                source_ref: json!({"format": "pdf", "page": page}),
                metadata: json!({"layout": "text_layer"}),
            });
        }
    }
    if blocks.is_empty() {
        warnings.push("scanned_pdf_no_text_layer".to_string());
    }
    let mut parsed = finalize_parsed(doc_id, parse_job_id, "pdf", title, None, blocks, vec![]);
    parsed.warnings.extend(warnings);
    Ok(parsed)
}

fn finalize_parsed(
    doc_id: Uuid,
    parse_job_id: Uuid,
    file_type: &str,
    title: &str,
    pages: Option<i32>,
    blocks: Vec<ParsedBlock>,
    tables: Vec<ParsedTable>,
) -> ParsedDocument {
    ParsedDocument {
        doc_id,
        parse_job_id,
        file_type: file_type.to_string(),
        title: title.to_string(),
        pages,
        blocks,
        tables,
        warnings: vec![],
        quality_score: 0.0,
    }
}

fn parse_xml_table(
    tbl: roxmltree::Node,
    _doc_id: Uuid,
    _parse_job_id: Uuid,
    block_id: Uuid,
    table_index: i32,
    heading_path: Vec<String>,
    page_start: Option<i32>,
    page_end: Option<i32>,
    slide_index: Option<i32>,
    format: &str,
) -> ParsedTable {
    let table_id = Uuid::new_v4();
    let row_nodes: Vec<_> = tbl
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "tr")
        .collect();
    let mut rows = Vec::new();
    let mut cells = Vec::new();
    for (row_idx, row) in row_nodes.iter().enumerate() {
        let cell_nodes: Vec<_> = row
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "tc")
            .collect();
        let mut row_values = Vec::new();
        for (col_idx, cell) in cell_nodes.iter().enumerate() {
            let text = collect_text(*cell).trim().to_string();
            row_values.push(text.clone());
            cells.push(ParsedTableCell {
                cell_id: Uuid::new_v4(),
                row_index: row_idx as i32,
                col_index: col_idx as i32,
                rowspan: attr_i32(*cell, "rowSpan").unwrap_or(1),
                colspan: attr_i32(*cell, "gridSpan")
                    .or_else(|| {
                        cell.descendants()
                            .find(|n| n.tag_name().name() == "gridSpan")
                            .and_then(|n| attr_i32(n, "val"))
                    })
                    .unwrap_or(1),
                normalized_text: normalize_space(&text),
                text,
                is_header: row_idx == 0,
                data_type: "text".to_string(),
                bbox: None,
                style: json!({}),
                source_ref: json!({"format": format, "table_index": table_index, "row": row_idx, "col": col_idx}),
            });
        }
        if !row_values.iter().all(|v| v.is_empty()) {
            rows.push(row_values);
        }
    }
    let headers = rows.first().cloned().unwrap_or_default();
    let markdown = table_markdown(&headers, rows.get(1..).unwrap_or(&[]));
    ParsedTable {
        table_id,
        block_id,
        table_index,
        title: heading_path.last().cloned(),
        heading_path,
        page_start,
        page_end,
        slide_index,
        headers,
        rows: rows.get(1..).unwrap_or(&[]).to_vec(),
        cells,
        markdown,
        quality: json!({
            "header_confidence": if rows.is_empty() { 0.0 } else { 0.9 },
            "grid_confidence": 0.95,
            "empty_cell_ratio": 0.0,
            "warnings": []
        }),
        source_ref: json!({"format": format, "table_index": table_index}),
    }
}

fn build_chunks(parsed: &ParsedDocument) -> Vec<ChunkDraft> {
    parsed
        .blocks
        .iter()
        .filter(|block| {
            matches!(
                block.block_type.as_str(),
                "paragraph" | "list_item" | "table" | "slide_note" | "footnote"
            ) && !block.text.trim().is_empty()
        })
        .enumerate()
        .map(|(idx, block)| {
            let mut lines = Vec::new();
            if !block.heading_path.is_empty() {
                lines.push(format!("标题路径：{}", block.heading_path.join(" / ")));
            }
            if let Some(page) = block.page_start {
                lines.push(format!("页码：{page}"));
            }
            if let Some(slide) = block.slide_index {
                lines.push(format!("Slide：{slide}"));
            }
            lines.push(String::new());
            lines.push(block.text.clone());
            let content = lines.join("\n");
            ChunkDraft {
                chunk_id: Uuid::new_v4(),
                chunk_index: idx as i32,
                source_type: block.block_type.clone(),
                token_count: estimate_tokens(&content),
                content,
                heading_path: block.heading_path.clone(),
                page_start: block.page_start,
                page_end: block.page_end,
                slide_start: block.slide_index,
                slide_end: block.slide_index,
                block_ids: vec![block.block_id],
                table_ids: block.table_id.into_iter().collect(),
                metadata: json!({"parser_version": PARSER_VERSION}),
            }
        })
        .collect()
}

fn score_quality(parsed: &ParsedDocument) -> f64 {
    if parsed.blocks.is_empty() {
        return 0.2;
    }
    let char_count: usize = parsed.blocks.iter().map(|b| b.text.chars().count()).sum();
    let text_score = if char_count > 100 { 1.0 } else { 0.65 };
    let structure_score = if parsed.blocks.iter().any(|b| b.block_type == "heading") {
        0.95
    } else {
        0.75
    };
    let table_score = if parsed.tables.is_empty() { 0.85 } else { 0.95 };
    let warning_penalty = (parsed.warnings.len() as f64 * 0.05).min(0.25);
    ((0.3 * text_score + 0.2 * structure_score + 0.2 * table_score + 0.15 + 0.15) - warning_penalty)
        .clamp(0.0, 1.0)
}

fn zip_entry_names(bytes: &[u8]) -> Result<Vec<String>> {
    let mut archive = open_zip(bytes)?;
    Ok((0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect())
}

fn open_zip(bytes: &[u8]) -> Result<ZipArchive<Cursor<&[u8]>>> {
    ZipArchive::new(Cursor::new(bytes)).context("invalid_zip_container")
}

fn read_zip_text(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<String> {
    let mut file = archive
        .by_name(name)
        .with_context(|| format!("missing_zip_entry:{name}"))?;
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(text)
}

fn collect_text(node: roxmltree::Node) -> String {
    let mut text = String::new();
    for n in node.descendants() {
        if n.is_text() {
            text.push_str(n.text().unwrap_or_default());
        } else if n.is_element() && matches!(n.tag_name().name(), "tab") {
            text.push('\t');
        } else if n.is_element() && matches!(n.tag_name().name(), "br" | "cr") {
            text.push('\n');
        }
    }
    normalize_space(&text)
}

fn paragraph_style(p: roxmltree::Node) -> Option<String> {
    p.descendants()
        .find(|n| n.tag_name().name() == "pStyle")
        .and_then(|n| attr(n, "val"))
        .map(str::to_string)
}

fn heading_level_from_style(style: Option<&str>) -> Option<i32> {
    let normalized = style?.to_ascii_lowercase().replace(' ', "");
    for level in 1..=6 {
        if normalized == format!("heading{level}") || normalized == format!("标题{level}") {
            return Some(level);
        }
    }
    None
}

fn attr<'a>(node: roxmltree::Node<'a, 'a>, local_name: &str) -> Option<&'a str> {
    node.attributes()
        .find(|a| a.name() == local_name)
        .map(|a| a.value())
}

fn attr_i32(node: roxmltree::Node, local_name: &str) -> Option<i32> {
    attr(node, local_name).and_then(|v| v.parse().ok())
}

fn normalize_space(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn split_paragraphs(text: &str) -> Vec<String> {
    text.split("\n\n")
        .flat_map(|part| {
            let clean = part
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if clean.is_empty() {
                vec![]
            } else {
                vec![clean]
            }
        })
        .collect()
}

fn table_markdown(headers: &[String], rows: &[Vec<String>]) -> String {
    if headers.is_empty() {
        return rows
            .iter()
            .map(|row| row.join(" | "))
            .collect::<Vec<_>>()
            .join("\n");
    }
    let mut out = String::new();
    out.push('|');
    out.push_str(
        &headers
            .iter()
            .map(|h| escape_table_cell(h))
            .collect::<Vec<_>>()
            .join("|"),
    );
    out.push_str("|\n|");
    out.push_str(&headers.iter().map(|_| "---").collect::<Vec<_>>().join("|"));
    out.push_str("|\n");
    for row in rows {
        out.push('|');
        out.push_str(
            &row.iter()
                .map(|v| escape_table_cell(v))
                .collect::<Vec<_>>()
                .join("|"),
        );
        out.push_str("|\n");
    }
    out
}

fn escape_table_cell(value: &str) -> String {
    value.replace('|', "\\|").replace('\n', "<br>")
}

fn estimate_tokens(content: &str) -> i32 {
    ((content.chars().count() as f64) / 2.4).ceil() as i32
}

fn title_from_file_name(file_name: &str) -> String {
    file_name
        .rsplit_once('.')
        .map(|(name, _)| name)
        .unwrap_or(file_name)
        .trim()
        .to_string()
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn looks_like_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"PK\x05\x06")
        || bytes.starts_with(b"PK\x07\x08")
}

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};
use uuid::Uuid;
use zip::ZipArchive;

use crate::models::{CellRange, CharRange, NormalizedBBox, SourceAnchor};

pub mod chunking;
pub mod cleaning;

pub use chunking::{ChunkConfig, CHUNKER_VERSION};
pub use cleaning::{CleanStats, CleanedBlock, CLEANER_VERSION};

pub const PARSER_VERSION: &str = "documind-parser@0.3.0";
pub const SCHEMA_VERSION: &str = "parsed-document-v1";
pub const MAX_OFFICE_ZIP_ENTRIES: usize = 10_000;
pub const MAX_OFFICE_UNCOMPRESSED_BYTES: u64 = 500 * 1024 * 1024;
pub const MAX_OFFICE_ENTRY_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_OFFICE_XML_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_OFFICE_COMPRESSION_RATIO: u64 = 200;
pub const MAX_PDF_PAGES: usize = 1_000;
pub const MAX_PDF_PAGE_TEXT_CHARS: usize = 50_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileType {
    Pdf,
    Docx,
    Pptx,
    Markdown,
    Text,
}

impl FileType {
    pub fn as_str(self) -> &'static str {
        match self {
            FileType::Pdf => "pdf",
            FileType::Docx => "docx",
            FileType::Pptx => "pptx",
            FileType::Markdown => "md",
            FileType::Text => "txt",
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
    pub anchors: Vec<SourceAnchor>,
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
    pub anchor_ids: Vec<Uuid>,
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
    pub anchor_ids: Vec<Uuid>,
    pub primary_anchor_id: Option<Uuid>,
    pub anchor_quality: String,
    pub metadata: Value,
}

#[derive(Debug, Clone)]
pub struct ParsedBundle {
    pub file_type: FileType,
    pub file_sha256: String,
    pub parsed: ParsedDocument,
    pub cleaned_blocks: Vec<CleanedBlock>,
    pub clean_stats: CleanStats,
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
        FileType::Markdown => parse_markdown(doc_id, parse_job_id, &title, bytes)?,
        FileType::Text => parse_plain_text(doc_id, parse_job_id, &title, bytes)?,
    };
    let quality = score_quality(&parsed);
    parsed.quality_score = quality;
    let (cleaned_blocks, clean_stats) = cleaning::clean_blocks(file_type, &parsed.blocks);
    let chunk_cfg = ChunkConfig::default();
    let chunks = chunking::chunk_blocks(
        file_type,
        Uuid::nil(),
        parse_job_id,
        &cleaned_blocks,
        &chunk_cfg,
    );
    Ok(ParsedBundle {
        file_type,
        file_sha256,
        parsed,
        cleaned_blocks,
        clean_stats,
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
    } else if mime_type.contains("markdown") {
        Some(FileType::Markdown)
    } else if mime_type.starts_with("text/plain") {
        Some(FileType::Text)
    } else {
        None
    };
    let by_ext = match ext.as_str() {
        "pdf" => Some(FileType::Pdf),
        "docx" => Some(FileType::Docx),
        "pptx" => Some(FileType::Pptx),
        "md" | "markdown" => Some(FileType::Markdown),
        "txt" => Some(FileType::Text),
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
    } else if matches!(by_ext, Some(FileType::Markdown | FileType::Text))
        && std::str::from_utf8(bytes).is_ok()
    {
        by_ext
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
    let mut anchors = Vec::new();
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
                    anchor_ids: vec![],
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
                    anchor_ids: vec![],
                    source_ref: json!({"format": "docx", "node": "w:tbl", "index": tables.len()}),
                    metadata: json!({}),
                });
                tables.push(table);
            }
            _ => {}
        }
    }
    attach_table_cell_anchors(
        doc_id,
        parse_job_id,
        "docx",
        &mut blocks,
        &tables,
        &mut anchors,
    );

    Ok(finalize_parsed(
        doc_id,
        parse_job_id,
        "docx",
        title,
        None,
        blocks,
        tables,
        anchors,
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
    let mut anchors = Vec::new();
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
                anchor_ids: vec![],
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
                anchor_ids: vec![],
                source_ref: json!({"format": "pptx", "slide": slide_idx + 1, "node": "a:p"}),
                metadata: json!({}),
            });
        }

        if first_text {
            warnings.push(format!("slide_{}_empty", slide_idx + 1));
        }
    }
    attach_table_cell_anchors(
        doc_id,
        parse_job_id,
        "pptx",
        &mut blocks,
        &tables,
        &mut anchors,
    );

    let mut parsed = finalize_parsed(
        doc_id,
        parse_job_id,
        "pptx",
        title,
        Some(slide_names.len() as i32),
        blocks,
        tables,
        anchors,
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
    let page_sizes = pdf_page_sizes(bytes).unwrap_or_default();
    if page_sizes.len() > MAX_PDF_PAGES {
        bail!(
            "pdf_page_count_exceeded:{}>{}",
            page_sizes.len(),
            MAX_PDF_PAGES
        );
    }

    let pages = pdf_extract::extract_text_from_mem_by_pages(bytes)
        .or_else(|_| {
            pdf_extract::extract_text_from_mem(bytes).map(|text| {
                if text.contains('\x0C') {
                    text.split('\x0C').map(str::to_string).collect()
                } else {
                    vec![text]
                }
            })
        })
        .context("pdf_text_extract_failed")?;

    if pages.len() > MAX_PDF_PAGES {
        bail!("pdf_page_count_exceeded:{}>{}", pages.len(), MAX_PDF_PAGES);
    }

    let mut blocks = Vec::new();
    let mut anchors = Vec::new();
    let mut warnings = Vec::new();

    for (page_idx, page_text) in pages.iter().enumerate() {
        let page = (page_idx + 1) as i32;
        let page_chars = page_text.chars().count();
        if page_chars > MAX_PDF_PAGE_TEXT_CHARS {
            bail!("pdf_page_text_chars_exceeded:{page}:{page_chars}>{MAX_PDF_PAGE_TEXT_CHARS}");
        }
        let paragraphs = split_paragraphs(page_text);
        let _page_height = page_sizes.get(page_idx).map(|(_, h)| *h).unwrap_or(842.0);
        let band_height = if paragraphs.is_empty() {
            0.0
        } else {
            0.8 / paragraphs.len().max(1) as f64
        };

        for (para_idx, paragraph) in paragraphs.iter().enumerate() {
            let trimmed = paragraph.trim();
            if trimmed.is_empty() {
                continue;
            }
            let is_heading = trimmed.chars().count() <= 80
                && !trimmed.ends_with(['.', '。', '；', ';', '，', ',']);
            let block_id = Uuid::new_v4();

            // 为每个 PDF 段落生成一个归一化 bbox（按页面垂直分带，留出页边距）
            let y1 = 0.9 - para_idx as f64 * band_height;
            let y0 = (y1 - band_height).max(0.1);
            let bbox = NormalizedBBox::normalized(0.05, y0, 0.95, y1);
            let anchor = SourceAnchor::for_pdf_paragraph(
                doc_id,
                parse_job_id,
                Uuid::nil(), // tenant_id 将在上层填充
                block_id,
                page,
                trimmed,
                bbox,
            );
            let anchor_id = anchor.anchor_id;
            anchors.push(anchor);

            blocks.push(ParsedBlock {
                block_id,
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
                anchor_ids: vec![anchor_id],
                source_ref: json!({"format": "pdf", "page": page}),
                metadata: json!({"layout": "text_layer"}),
            });
        }
    }
    if blocks.is_empty() {
        warnings.push("scanned_pdf_no_text_layer".to_string());
    }
    let mut parsed = finalize_parsed(
        doc_id,
        parse_job_id,
        "pdf",
        title,
        Some(pages.len() as i32),
        blocks,
        vec![],
        anchors,
    );
    parsed.warnings.extend(warnings);
    Ok(parsed)
}

/// 使用 lopdf 提取每页的 CropBox/MediaBox 尺寸（点）。
fn pdf_page_sizes(bytes: &[u8]) -> Result<Vec<(f64, f64)>> {
    let doc = lopdf::Document::load_mem(bytes).context("lopdf_load_failed")?;
    let pages = doc.get_pages();
    let mut sizes = Vec::new();
    for page_num in 1..=pages.len() as u32 {
        let page_id = pages
            .get(&page_num)
            .copied()
            .ok_or_else(|| anyhow!("lopdf_missing_page_{}", page_num))?;
        let bounds = page_bounds(&doc, page_id);
        if let lopdf::Object::Array(arr) = bounds {
            if arr.len() >= 4 {
                let x0 = as_f64(&arr[0]).unwrap_or(0.0);
                let y0 = as_f64(&arr[1]).unwrap_or(0.0);
                let x1 = as_f64(&arr[2]).unwrap_or(595.0);
                let y1 = as_f64(&arr[3]).unwrap_or(842.0);
                sizes.push(((x1 - x0).abs(), (y1 - y0).abs()));
            }
        }
    }
    Ok(sizes)
}

fn page_bounds(doc: &lopdf::Document, page_id: lopdf::ObjectId) -> lopdf::Object {
    let default = lopdf::Object::Array(vec![
        lopdf::Object::Integer(0),
        lopdf::Object::Integer(0),
        lopdf::Object::Integer(595),
        lopdf::Object::Integer(842),
    ]);
    let Ok(page) = doc.get_dictionary(page_id) else {
        return default;
    };
    let resolve = |obj: &lopdf::Object| doc.get_object(obj.as_reference().unwrap_or((0, 0))).ok();
    page.get(b"CropBox")
        .ok()
        .and_then(resolve)
        .or_else(|| page.get(b"MediaBox").ok().and_then(resolve))
        .cloned()
        .unwrap_or(default)
}

fn as_f64(obj: &lopdf::Object) -> Option<f64> {
    match obj {
        lopdf::Object::Integer(i) => Some(*i as f64),
        lopdf::Object::Real(f) => Some((*f).into()),
        _ => None,
    }
}

fn parse_plain_text(
    doc_id: Uuid,
    parse_job_id: Uuid,
    title: &str,
    bytes: &[u8],
) -> Result<ParsedDocument> {
    let text = String::from_utf8(bytes.to_vec()).context("invalid_utf8_text")?;
    let mut blocks = Vec::new();
    let mut anchors = Vec::new();
    for (paragraph, start, end) in split_paragraphs_with_ranges(&text) {
        let block_id = Uuid::new_v4();
        let mut anchor = SourceAnchor::structural(
            doc_id,
            parse_job_id,
            Uuid::nil(),
            "txt",
            "paragraph",
            block_id,
            None,
            None,
            json!({"format": "txt", "index": blocks.len()}),
            &paragraph,
        );
        anchor.char_range = Some(CharRange { start, end });
        let anchor_id = anchor.anchor_id;
        anchors.push(anchor);
        blocks.push(ParsedBlock {
            block_id,
            block_index: blocks.len() as i32,
            block_type: "paragraph".to_string(),
            text: paragraph,
            heading_level: None,
            heading_path: vec![],
            page_start: None,
            page_end: None,
            slide_index: None,
            table_id: None,
            bbox: None,
            anchor_ids: vec![anchor_id],
            source_ref: json!({"format": "txt", "index": blocks.len()}),
            metadata: json!({"format": "txt"}),
        });
    }
    Ok(finalize_parsed(
        doc_id,
        parse_job_id,
        "txt",
        title,
        None,
        blocks,
        vec![],
        anchors,
    ))
}

fn parse_markdown(
    doc_id: Uuid,
    parse_job_id: Uuid,
    title: &str,
    bytes: &[u8],
) -> Result<ParsedDocument> {
    let text = String::from_utf8(bytes.to_vec()).context("invalid_utf8_markdown")?;
    let mut blocks = Vec::new();
    let mut tables = Vec::new();
    let mut heading_path: Vec<(i32, String)> = Vec::new();
    let mut in_frontmatter = false;
    let mut frontmatter = Vec::new();
    let mut in_code = false;
    let mut code_fence = Vec::new();
    let mut paragraph = Vec::new();
    let mut table_lines = Vec::new();

    for (line_idx, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if line_idx == 0 && trimmed == "---" {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if trimmed == "---" {
                in_frontmatter = false;
                if !frontmatter.is_empty() {
                    push_markdown_block(
                        &mut blocks,
                        "metadata",
                        frontmatter.join("\n"),
                        None,
                        &heading_path,
                        json!({"format": "md", "source": "frontmatter"}),
                    );
                    frontmatter.clear();
                }
            } else {
                frontmatter.push(line.to_string());
            }
            continue;
        }

        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            if in_code {
                code_fence.push(line.to_string());
                push_markdown_block(
                    &mut blocks,
                    "code",
                    code_fence.join("\n"),
                    None,
                    &heading_path,
                    json!({"format": "md", "source": "code_fence"}),
                );
                code_fence.clear();
                in_code = false;
            } else {
                flush_markdown_paragraph(&mut blocks, &mut paragraph, &heading_path);
                flush_markdown_table(
                    doc_id,
                    parse_job_id,
                    &mut blocks,
                    &mut tables,
                    &mut table_lines,
                    &heading_path,
                );
                in_code = true;
                code_fence.push(line.to_string());
            }
            continue;
        }
        if in_code {
            code_fence.push(line.to_string());
            continue;
        }

        if let Some((level, heading)) = markdown_heading(trimmed) {
            flush_markdown_paragraph(&mut blocks, &mut paragraph, &heading_path);
            flush_markdown_table(
                doc_id,
                parse_job_id,
                &mut blocks,
                &mut tables,
                &mut table_lines,
                &heading_path,
            );
            heading_path.retain(|(existing, _)| *existing < level);
            heading_path.push((level, heading.clone()));
            push_markdown_block(
                &mut blocks,
                "heading",
                heading,
                Some(level),
                &heading_path[..heading_path.len().saturating_sub(1)],
                json!({"format": "md", "line": line_idx + 1}),
            );
            continue;
        }

        if trimmed.starts_with("<!--") {
            flush_markdown_paragraph(&mut blocks, &mut paragraph, &heading_path);
            push_markdown_block(
                &mut blocks,
                "comment",
                trimmed.to_string(),
                None,
                &heading_path,
                json!({"format": "md", "line": line_idx + 1}),
            );
            continue;
        }

        if markdown_table_line(trimmed) {
            flush_markdown_paragraph(&mut blocks, &mut paragraph, &heading_path);
            table_lines.push(trimmed.to_string());
            continue;
        } else {
            flush_markdown_table(
                doc_id,
                parse_job_id,
                &mut blocks,
                &mut tables,
                &mut table_lines,
                &heading_path,
            );
        }

        if trimmed.is_empty() {
            flush_markdown_paragraph(&mut blocks, &mut paragraph, &heading_path);
        } else if markdown_list_item(trimmed) {
            flush_markdown_paragraph(&mut blocks, &mut paragraph, &heading_path);
            push_markdown_block(
                &mut blocks,
                "list_item",
                trimmed.to_string(),
                None,
                &heading_path,
                json!({"format": "md", "line": line_idx + 1}),
            );
        } else if trimmed.starts_with('>') {
            flush_markdown_paragraph(&mut blocks, &mut paragraph, &heading_path);
            push_markdown_block(
                &mut blocks,
                "blockquote",
                trimmed.trim_start_matches('>').trim().to_string(),
                None,
                &heading_path,
                json!({"format": "md", "line": line_idx + 1}),
            );
        } else if trimmed.starts_with("![") {
            flush_markdown_paragraph(&mut blocks, &mut paragraph, &heading_path);
            push_markdown_block(
                &mut blocks,
                "image",
                trimmed.to_string(),
                None,
                &heading_path,
                json!({"format": "md", "line": line_idx + 1}),
            );
        } else {
            paragraph.push(trimmed.to_string());
        }
    }

    flush_markdown_paragraph(&mut blocks, &mut paragraph, &heading_path);
    flush_markdown_table(
        doc_id,
        parse_job_id,
        &mut blocks,
        &mut tables,
        &mut table_lines,
        &heading_path,
    );

    let mut anchors = Vec::new();
    attach_table_cell_anchors(
        doc_id,
        parse_job_id,
        "md",
        &mut blocks,
        &tables,
        &mut anchors,
    );
    let mut char_cursor = 0usize;
    for block in &mut blocks {
        if block.anchor_ids.is_empty() {
            let mut anchor = SourceAnchor::structural(
                doc_id,
                parse_job_id,
                Uuid::nil(),
                "md",
                &block.block_type,
                block.block_id,
                block.page_start,
                block.slide_index,
                block.source_ref.clone(),
                &block.text,
            );
            if let Some((start, end)) = find_text_char_range(&text, &block.text, &mut char_cursor) {
                anchor.char_range = Some(CharRange { start, end });
            }
            block.anchor_ids.push(anchor.anchor_id);
            anchors.push(anchor);
        }
    }

    Ok(finalize_parsed(
        doc_id,
        parse_job_id,
        "md",
        title,
        None,
        blocks,
        tables,
        anchors,
    ))
}

fn attach_table_cell_anchors(
    doc_id: Uuid,
    parse_job_id: Uuid,
    format: &str,
    blocks: &mut [ParsedBlock],
    tables: &[ParsedTable],
    anchors: &mut Vec<SourceAnchor>,
) {
    for block in blocks.iter_mut().filter(|block| block.table_id.is_some()) {
        if block
            .anchor_ids
            .iter()
            .any(|anchor_id| anchors.iter().any(|anchor| anchor.anchor_id == *anchor_id))
        {
            continue;
        }
        let Some(table_id) = block.table_id else {
            continue;
        };
        let Some(table) = tables.iter().find(|table| table.table_id == table_id) else {
            continue;
        };
        let cell_range = table_cell_range(table);
        let source_ref = json!({
            "format": format,
            "table_index": table.table_index,
            "table_id": table.table_id,
            "kind": "table_cell_range",
            "cell_range": {
                "row_start": cell_range.row_start,
                "row_end": cell_range.row_end,
                "col_start": cell_range.col_start,
                "col_end": cell_range.col_end,
            }
        });
        let anchor = SourceAnchor::table_cell_range(
            doc_id,
            parse_job_id,
            Uuid::nil(),
            format,
            block.block_id,
            table.table_id,
            table.page_start.or(block.page_start),
            table.slide_index.or(block.slide_index),
            cell_range,
            source_ref,
            &table.markdown,
        );
        block.anchor_ids.push(anchor.anchor_id);
        anchors.push(anchor);
    }
}

fn table_cell_range(table: &ParsedTable) -> CellRange {
    let row_end = table
        .cells
        .iter()
        .map(|cell| cell.row_index + cell.rowspan.max(1) - 1)
        .max()
        .unwrap_or(0);
    let col_end = table
        .cells
        .iter()
        .map(|cell| cell.col_index + cell.colspan.max(1) - 1)
        .max()
        .unwrap_or(0);
    CellRange {
        row_start: 0,
        row_end,
        col_start: 0,
        col_end,
    }
}

fn finalize_parsed(
    doc_id: Uuid,
    parse_job_id: Uuid,
    file_type: &str,
    title: &str,
    pages: Option<i32>,
    blocks: Vec<ParsedBlock>,
    tables: Vec<ParsedTable>,
    anchors: Vec<SourceAnchor>,
) -> ParsedDocument {
    ParsedDocument {
        doc_id,
        parse_job_id,
        file_type: file_type.to_string(),
        title: title.to_string(),
        pages,
        blocks,
        tables,
        anchors,
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

fn score_quality(parsed: &ParsedDocument) -> f64 {
    if parsed.blocks.is_empty() {
        return 0.2;
    }
    let char_count: usize = parsed.blocks.iter().map(|b| b.text.chars().count()).sum();
    let text_score = if char_count > 100 {
        1.0
    } else if char_count >= 20 {
        0.65
    } else {
        0.2
    };
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
    let mut archive = ZipArchive::new(Cursor::new(bytes)).context("invalid_zip_container")?;
    validate_office_zip(&mut archive)?;
    Ok(archive)
}

fn read_zip_text(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<String> {
    let mut file = archive
        .by_name(name)
        .with_context(|| format!("missing_zip_entry:{name}"))?;
    if file.size() > MAX_OFFICE_XML_BYTES {
        bail!(
            "zip_xml_entry_too_large:{name}:{}>{}",
            file.size(),
            MAX_OFFICE_XML_BYTES
        );
    }
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(text)
}

fn validate_office_zip(archive: &mut ZipArchive<Cursor<&[u8]>>) -> Result<()> {
    if archive.len() > MAX_OFFICE_ZIP_ENTRIES {
        bail!(
            "zip_entry_count_exceeded:{}>{}",
            archive.len(),
            MAX_OFFICE_ZIP_ENTRIES
        );
    }

    let mut total_uncompressed = 0_u64;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .with_context(|| format!("invalid_zip_entry:{index}"))?;
        let name = file.name().to_string();
        if !is_safe_zip_entry_name(&name) {
            bail!("zip_entry_name_unsafe:{name}");
        }

        let uncompressed = file.size();
        let compressed = file.compressed_size();
        if uncompressed > MAX_OFFICE_ENTRY_BYTES {
            bail!("zip_entry_too_large:{name}:{uncompressed}>{MAX_OFFICE_ENTRY_BYTES}");
        }
        total_uncompressed = total_uncompressed
            .checked_add(uncompressed)
            .ok_or_else(|| anyhow!("zip_uncompressed_size_overflow"))?;
        if total_uncompressed > MAX_OFFICE_UNCOMPRESSED_BYTES {
            bail!(
                "zip_uncompressed_size_exceeded:{total_uncompressed}>{MAX_OFFICE_UNCOMPRESSED_BYTES}"
            );
        }
        if uncompressed > 0 && compressed == 0 {
            bail!("zip_entry_invalid_compressed_size:{name}");
        }
        if compressed > 0 && uncompressed > compressed.saturating_mul(MAX_OFFICE_COMPRESSION_RATIO)
        {
            bail!(
                "zip_compression_ratio_exceeded:{name}:{uncompressed}/{compressed}>{MAX_OFFICE_COMPRESSION_RATIO}"
            );
        }
    }

    Ok(())
}

fn is_safe_zip_entry_name(name: &str) -> bool {
    if name.trim().is_empty()
        || name.starts_with('/')
        || name.starts_with('\\')
        || name.contains('\0')
        || name.contains(':')
    {
        return false;
    }
    let normalized = name.replace('\\', "/");
    normalized
        .trim_end_matches('/')
        .split('/')
        .all(|part| !part.is_empty() && part != "." && part != "..")
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

fn split_paragraphs_with_ranges(text: &str) -> Vec<(String, i32, i32)> {
    let mut out = Vec::new();
    let mut byte_start = 0usize;
    for part in text.split_inclusive("\n\n") {
        let part_without_separator = part.strip_suffix("\n\n").unwrap_or(part);
        push_paragraph_with_range(text, part_without_separator, byte_start, &mut out);
        byte_start += part.len();
    }
    if !text.ends_with("\n\n") && byte_start < text.len() {
        push_paragraph_with_range(text, &text[byte_start..], byte_start, &mut out);
    }
    out
}

fn push_paragraph_with_range(
    full_text: &str,
    part: &str,
    part_byte_start: usize,
    out: &mut Vec<(String, i32, i32)>,
) {
    let mut clean_lines = Vec::new();
    let mut first_line_start: Option<usize> = None;
    let mut last_line_end: Option<usize> = None;
    let mut line_byte_start = part_byte_start;
    for line in part.split_inclusive('\n') {
        let raw_line = line.strip_suffix('\n').unwrap_or(line);
        let leading = raw_line.len() - raw_line.trim_start().len();
        let trimmed = raw_line.trim();
        if !trimmed.is_empty() {
            let start = line_byte_start + leading;
            let end = start + trimmed.len();
            first_line_start.get_or_insert(start);
            last_line_end = Some(end);
            clean_lines.push(trimmed);
        }
        line_byte_start += line.len();
    }

    if clean_lines.is_empty() {
        return;
    }
    let start = first_line_start.unwrap_or(part_byte_start);
    let end = last_line_end.unwrap_or(start);
    out.push((
        clean_lines.join(" "),
        char_index_at_byte(full_text, start),
        char_index_at_byte(full_text, end),
    ));
}

fn find_text_char_range(full_text: &str, needle: &str, cursor: &mut usize) -> Option<(i32, i32)> {
    let needle = needle.trim();
    if needle.is_empty() {
        return None;
    }
    let haystack = &full_text[*cursor..];
    let found = haystack
        .find(needle)
        .or_else(|| haystack.find(&needle.replace('\n', " ")))?;
    let start = *cursor + found;
    let end = start + needle.len();
    *cursor = end;
    Some((
        char_index_at_byte(full_text, start),
        char_index_at_byte(full_text, end),
    ))
}

fn char_index_at_byte(text: &str, byte_index: usize) -> i32 {
    text[..byte_index.min(text.len())].chars().count() as i32
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

fn markdown_heading(line: &str) -> Option<(i32, String)> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = line.get(hashes..)?.trim();
    if rest.is_empty() {
        None
    } else {
        Some((hashes as i32, rest.trim_matches('#').trim().to_string()))
    }
}

fn markdown_list_item(line: &str) -> bool {
    line.starts_with("- ")
        || line.starts_with("* ")
        || line.starts_with("+ ")
        || line
            .split_once(". ")
            .map(|(prefix, _)| !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false)
}

fn markdown_table_line(line: &str) -> bool {
    line.starts_with('|') && line.ends_with('|') && line.matches('|').count() >= 2
}

fn push_markdown_block(
    blocks: &mut Vec<ParsedBlock>,
    block_type: &str,
    text: String,
    heading_level: Option<i32>,
    heading_path: &[(i32, String)],
    metadata: Value,
) {
    if text.trim().is_empty() {
        return;
    }
    blocks.push(ParsedBlock {
        block_id: Uuid::new_v4(),
        block_index: blocks.len() as i32,
        block_type: block_type.to_string(),
        text,
        heading_level,
        heading_path: heading_path.iter().map(|(_, h)| h.clone()).collect(),
        page_start: None,
        page_end: None,
        slide_index: None,
        table_id: None,
        bbox: None,
        anchor_ids: vec![],
        source_ref: json!({"format": "md", "index": blocks.len()}),
        metadata,
    });
}

fn flush_markdown_paragraph(
    blocks: &mut Vec<ParsedBlock>,
    paragraph: &mut Vec<String>,
    heading_path: &[(i32, String)],
) {
    if paragraph.is_empty() {
        return;
    }
    let text = paragraph.join("\n");
    paragraph.clear();
    push_markdown_block(
        blocks,
        "paragraph",
        text,
        None,
        heading_path,
        json!({"format": "md", "source": "paragraph"}),
    );
}

fn flush_markdown_table(
    _doc_id: Uuid,
    _parse_job_id: Uuid,
    blocks: &mut Vec<ParsedBlock>,
    tables: &mut Vec<ParsedTable>,
    table_lines: &mut Vec<String>,
    heading_path: &[(i32, String)],
) {
    if table_lines.len() < 2 {
        table_lines.clear();
        return;
    }

    let rows = table_lines
        .iter()
        .filter(|line| !line.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')))
        .map(|line| {
            line.trim_matches('|')
                .split('|')
                .map(|cell| cell.trim().to_string())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    table_lines.clear();
    if rows.is_empty() {
        return;
    }

    let block_id = Uuid::new_v4();
    let table_id = Uuid::new_v4();
    let headers = rows.first().cloned().unwrap_or_default();
    let body = rows.get(1..).unwrap_or(&[]).to_vec();
    let markdown = table_markdown(&headers, &body);
    let mut cells = Vec::new();
    for (row_idx, row) in rows.iter().enumerate() {
        for (col_idx, text) in row.iter().enumerate() {
            cells.push(ParsedTableCell {
                cell_id: Uuid::new_v4(),
                row_index: row_idx as i32,
                col_index: col_idx as i32,
                rowspan: 1,
                colspan: 1,
                text: text.clone(),
                normalized_text: normalize_space(text),
                is_header: row_idx == 0,
                data_type: "text".to_string(),
                bbox: None,
                style: json!({}),
                source_ref: json!({"format": "md", "table_index": tables.len(), "row": row_idx, "col": col_idx}),
            });
        }
    }
    let path = heading_path
        .iter()
        .map(|(_, h)| h.clone())
        .collect::<Vec<_>>();
    tables.push(ParsedTable {
        table_id,
        block_id,
        table_index: tables.len() as i32,
        title: path.last().cloned(),
        heading_path: path.clone(),
        page_start: None,
        page_end: None,
        slide_index: None,
        headers: headers.clone(),
        rows: body,
        cells,
        markdown: markdown.clone(),
        quality: json!({"header_confidence": 0.9, "grid_confidence": 0.9, "warnings": []}),
        source_ref: json!({"format": "md", "table_index": tables.len()}),
    });
    blocks.push(ParsedBlock {
        block_id,
        block_index: blocks.len() as i32,
        block_type: "table".to_string(),
        text: markdown,
        heading_level: None,
        heading_path: path,
        page_start: None,
        page_end: None,
        slide_index: None,
        table_id: Some(table_id),
        bbox: None,
        anchor_ids: vec![],
        source_ref: json!({"format": "md", "node": "table", "index": tables.len()}),
        metadata: json!({"format": "md", "source": "table"}),
    });
}

pub(crate) fn estimate_tokens(content: &str) -> i32 {
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

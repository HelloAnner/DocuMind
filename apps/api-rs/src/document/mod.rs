use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};
use uuid::Uuid;
use zip::ZipArchive;

use crate::models::{CellRange, CharRange, SourceAnchor};

pub mod chunking;
pub mod cleaning;
mod docx;
mod markdown;
pub mod ocr;
mod pdf;
mod plain_text;
mod pptx;
mod quality;
mod shared;
mod text_utils;

pub use chunking::{ChunkConfig, CHUNKER_VERSION};
pub use cleaning::{CleanStats, CleanedBlock, CLEANER_VERSION};
pub(crate) use text_utils::estimate_tokens;

pub const PARSER_VERSION: &str = "documind-parser@0.4.0";
pub const SCHEMA_VERSION: &str = "parsed-document-v1";
pub const MAX_OFFICE_ZIP_ENTRIES: usize = 10_000;
pub const MAX_OFFICE_UNCOMPRESSED_BYTES: u64 = 500 * 1024 * 1024;
pub const MAX_OFFICE_ENTRY_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_OFFICE_XML_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_OFFICE_COMPRESSION_RATIO: u64 = 200;
pub const MAX_OFFICE_XML_DEPTH: usize = 256;
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
    let file_sha256 = text_utils::hex_sha256(bytes);
    let file_type = detect_file_type(file_name, mime_type, bytes)?;
    let title = text_utils::title_from_file_name(file_name);
    let mut parsed = match file_type {
        FileType::Pdf => pdf::parse_pdf(doc_id, parse_job_id, &title, bytes)?,
        FileType::Docx => docx::parse_docx(doc_id, parse_job_id, &title, bytes)?,
        FileType::Pptx => pptx::parse_pptx(doc_id, parse_job_id, &title, bytes)?,
        FileType::Markdown => markdown::parse_markdown(doc_id, parse_job_id, &title, bytes)?,
        FileType::Text => plain_text::parse_plain_text(doc_id, parse_job_id, &title, bytes)?,
    };
    attach_missing_structural_anchors(doc_id, parse_job_id, file_type, &mut parsed);
    let quality = quality::score_quality(&parsed);
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

fn attach_missing_structural_anchors(
    doc_id: Uuid,
    parse_job_id: Uuid,
    file_type: FileType,
    parsed: &mut ParsedDocument,
) {
    for block in &mut parsed.blocks {
        if !block.anchor_ids.is_empty() {
            continue;
        }
        let anchor = SourceAnchor::structural(
            doc_id,
            parse_job_id,
            Uuid::nil(),
            file_type.as_str(),
            &block.block_type,
            block.block_id,
            block.page_start,
            block.slide_index,
            block.source_ref.clone(),
            &block.text,
        );
        block.anchor_ids.push(anchor.anchor_id);
        parsed.anchors.push(anchor);
    }
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
    } else if text_utils::looks_like_zip(bytes) {
        let entries = shared::zip_entry_names(bytes)?;
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
        && text_utils::decode_text(bytes).is_ok()
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

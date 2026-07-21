use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use unicode_normalization::UnicodeNormalization;

use super::{FileType, ParsedBlock};

pub const CLEANER_VERSION: &str = "documind-cleaner@0.2.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanedBlock {
    pub block: ParsedBlock,
    pub cleaned_text: String,
    pub is_removed: bool,
    pub remove_reason: Option<String>,
    pub cleaning_ops: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanStats {
    pub input_blocks: usize,
    pub output_blocks: usize,
    pub removed_blocks: usize,
    pub ops_top: Vec<String>,
}

pub fn clean_blocks(
    file_type: FileType,
    blocks: &[ParsedBlock],
) -> (Vec<CleanedBlock>, CleanStats) {
    let mut cleaned = Vec::with_capacity(blocks.len());
    let mut op_counts = BTreeMap::<String, usize>::new();
    let repeated_pdf_noise = repeated_pdf_noise(file_type, blocks);

    for block in blocks {
        let (mut text, mut ops) = common_clean(&block.text);
        format_specific_clean(file_type, block, &mut text, &mut ops);

        let (is_removed, remove_reason) =
            removal_reason(file_type, block, &text, &repeated_pdf_noise);
        for op in &ops {
            *op_counts.entry(op.clone()).or_insert(0) += 1;
        }

        cleaned.push(CleanedBlock {
            block: block.clone(),
            cleaned_text: text,
            is_removed,
            remove_reason,
            cleaning_ops: ops,
        });
    }

    let removed_blocks = cleaned.iter().filter(|b| b.is_removed).count();
    let output_blocks = cleaned.len().saturating_sub(removed_blocks);
    let mut ops_top = op_counts.into_iter().collect::<Vec<_>>();
    ops_top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    (
        cleaned,
        CleanStats {
            input_blocks: blocks.len(),
            output_blocks,
            removed_blocks,
            ops_top: ops_top.into_iter().take(8).map(|(op, _)| op).collect(),
        },
    )
}

pub fn cleaned_block_metadata(block: &CleanedBlock) -> Value {
    json!({
        "cleaner_version": CLEANER_VERSION,
        "cleaning_ops": block.cleaning_ops,
        "is_removed": block.is_removed,
        "remove_reason": block.remove_reason,
        "source_ref": block.block.source_ref,
        "source_metadata": block.block.metadata,
    })
}

fn common_clean(input: &str) -> (String, Vec<String>) {
    let mut ops = Vec::new();
    let mut text = input.to_string();

    if text.starts_with('\u{feff}') {
        text = text.trim_start_matches('\u{feff}').to_string();
        ops.push("remove_bom".to_string());
    }

    if text.contains("\r\n") || text.contains('\r') {
        text = text.replace("\r\n", "\n").replace('\r', "\n");
        ops.push("normalize_line_endings".to_string());
    }

    let before = text.clone();
    text = text
        .chars()
        .filter_map(|c| match c {
            '\u{00a0}' | '\u{3000}' => Some(' '),
            '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}' | '\u{fffc}' => None,
            '\t' => Some(' '),
            '\n' => Some('\n'),
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect::<String>();
    if text != before {
        ops.push("normalize_space".to_string());
        ops.push("remove_control_chars".to_string());
    }

    let before = text.clone();
    text = text.nfc().collect::<String>();
    if text != before {
        ops.push("unicode_nfc".to_string());
    }

    let before = text.clone();
    text = normalize_horizontal_space(&text);
    text = collapse_empty_lines(&text);
    if text != before && !ops.iter().any(|op| op == "normalize_space") {
        ops.push("normalize_space".to_string());
    }

    let trimmed = text.trim().to_string();
    if trimmed != text {
        ops.push("trim".to_string());
        text = trimmed;
    }

    (text, dedupe_ops(ops))
}

fn format_specific_clean(
    file_type: FileType,
    block: &ParsedBlock,
    text: &mut String,
    ops: &mut Vec<String>,
) {
    match file_type {
        FileType::Pdf => clean_pdf_text(block, text, ops),
        FileType::Docx => clean_word_text(block, text, ops),
        FileType::Pptx => clean_ppt_text(block, text, ops),
        FileType::Markdown => clean_markdown_text(block, text, ops),
        FileType::Text => {}
    }
}

fn clean_pdf_text(block: &ParsedBlock, text: &mut String, ops: &mut Vec<String>) {
    if block.block_type == "paragraph" {
        let before = text.clone();
        *text = merge_pdf_line_breaks(text);
        if *text != before {
            ops.push("merge_pdf_line_break".to_string());
        }
    }
    if looks_like_page_number(text) {
        ops.push("remove_pdf_noise".to_string());
    }
}

fn clean_word_text(block: &ParsedBlock, text: &mut String, ops: &mut Vec<String>) {
    if block.block_type == "paragraph" && looks_like_toc_entry(text) {
        ops.push("remove_toc_entry".to_string());
    }
    if block.block_type == "header_footer" {
        ops.push("remove_header_footer".to_string());
    }
}

fn clean_ppt_text(block: &ParsedBlock, text: &mut String, ops: &mut Vec<String>) {
    let lowered = text.to_ascii_lowercase();
    if lowered.contains("click to add") || lowered.contains("单击此处") {
        ops.push("remove_placeholder".to_string());
    }
    if block.block_type == "slide_note" {
        ops.push("preserve_slide_note".to_string());
    }
}

fn clean_markdown_text(block: &ParsedBlock, text: &mut String, ops: &mut Vec<String>) {
    if block.block_type == "html" && is_script_or_style(text) {
        ops.push("remove_script_style".to_string());
    }
    if block.block_type == "comment" || text.trim_start().starts_with("<!--") {
        ops.push("remove_comment".to_string());
    }
    if block.block_type == "image" {
        let alt = markdown_image_alt(text);
        if let Some(alt) = alt {
            *text = alt;
            ops.push("extract_alt_text".to_string());
        }
    }
}

fn removal_reason(
    file_type: FileType,
    block: &ParsedBlock,
    text: &str,
    repeated_pdf_noise: &HashSet<String>,
) -> (bool, Option<String>) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return (true, Some("empty_block".to_string()));
    }
    if block.block_type == "header_footer" {
        return (true, Some("header_footer".to_string()));
    }
    if block.block_type == "comment" {
        return (true, Some("comment".to_string()));
    }
    if block.block_type == "html" && is_script_or_style(trimmed) {
        return (true, Some("script_style".to_string()));
    }
    if file_type == FileType::Pdf
        && (looks_like_page_number(trimmed) || repeated_pdf_noise.contains(&noise_key(trimmed)))
    {
        return (true, Some("page_noise".to_string()));
    }
    if file_type == FileType::Docx
        && block.block_type == "paragraph"
        && looks_like_toc_entry(trimmed)
    {
        return (true, Some("toc_entry".to_string()));
    }
    (false, None)
}

fn normalize_horizontal_space(text: &str) -> String {
    text.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
}

fn collapse_empty_lines(text: &str) -> String {
    let mut out = String::new();
    let mut empty_count = 0usize;
    for line in text.lines() {
        if line.trim().is_empty() {
            empty_count += 1;
            if empty_count <= 2 {
                out.push('\n');
            }
        } else {
            empty_count = 0;
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(line);
        }
    }
    out
}

fn merge_pdf_line_breaks(text: &str) -> String {
    let mut out = String::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if out.ends_with('-') {
            out.pop();
            out.push_str(line);
        } else {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(line);
        }
    }
    out
}

fn looks_like_page_number(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.chars().count() > 24 || trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    let english_page = lower
        .strip_prefix("page ")
        .is_some_and(|tail| tail.trim().chars().all(|c| c.is_ascii_digit()));
    let chinese_page = trimmed
        .strip_prefix('第')
        .and_then(|tail| tail.strip_suffix('页'))
        .is_some_and(|number| {
            !number.is_empty()
                && number.chars().all(|c| {
                    c.is_ascii_digit()
                        || matches!(
                            c,
                            '一' | '二'
                                | '三'
                                | '四'
                                | '五'
                                | '六'
                                | '七'
                                | '八'
                                | '九'
                                | '十'
                                | '百'
                                | '千'
                        )
                })
        });
    english_page || chinese_page
}

fn looks_like_toc_entry(text: &str) -> bool {
    let trimmed = text.trim();
    (trimmed.contains(".....") || trimmed.contains("……")) && trimmed.chars().count() < 200
}

fn repeated_pdf_noise(file_type: FileType, blocks: &[ParsedBlock]) -> HashSet<String> {
    if file_type != FileType::Pdf {
        return HashSet::new();
    }
    let mut pages_by_text = BTreeMap::<String, BTreeSet<i32>>::new();
    for block in blocks {
        let Some(page) = block.page_start else {
            continue;
        };
        let text = block.text.trim();
        if text.is_empty() || text.chars().count() > 120 {
            continue;
        }
        pages_by_text
            .entry(noise_key(text))
            .or_default()
            .insert(page);
    }
    pages_by_text
        .into_iter()
        .filter_map(|(text, pages)| (pages.len() >= 3).then_some(text))
        .collect()
}

fn noise_key(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn is_script_or_style(text: &str) -> bool {
    let lower = text.trim_start().to_ascii_lowercase();
    lower.starts_with("<script") || lower.starts_with("<style")
}

fn markdown_image_alt(text: &str) -> Option<String> {
    let start = text.find("![")? + 2;
    let end = text[start..].find(']')? + start;
    let alt = text[start..end].trim();
    (!alt.is_empty()).then(|| alt.to_string())
}

fn dedupe_ops(ops: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for op in ops {
        if !out.contains(&op) {
            out.push(op);
        }
    }
    out
}

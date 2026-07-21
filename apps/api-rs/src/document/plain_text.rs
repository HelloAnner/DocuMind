use super::shared::finalize_parsed;
use super::text_utils::decode_text;
use super::*;
pub(super) fn parse_plain_text(
    doc_id: Uuid,
    parse_job_id: Uuid,
    title: &str,
    bytes: &[u8],
) -> Result<ParsedDocument> {
    let text = decode_text(bytes).context("invalid_text_encoding")?;
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

pub(super) fn split_paragraphs(text: &str) -> Vec<String> {
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
    let mut paragraph_start = None;
    let mut line_start = 0usize;
    for line in text.split_inclusive('\n') {
        let raw = line
            .strip_suffix('\n')
            .unwrap_or(line)
            .trim_end_matches('\r');
        if raw.trim().is_empty() {
            if let Some(start) = paragraph_start.take() {
                push_paragraph_with_range(text, &text[start..line_start], start, &mut out);
            }
        } else if paragraph_start.is_none() {
            paragraph_start = Some(line_start);
        }
        line_start += line.len();
    }
    if let Some(start) = paragraph_start {
        push_paragraph_with_range(text, &text[start..], start, &mut out);
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

pub(super) fn find_text_char_range(
    full_text: &str,
    needle: &str,
    cursor: &mut usize,
) -> Option<(i32, i32)> {
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

use super::plain_text::find_text_char_range;
use super::shared::{attach_table_cell_anchors, finalize_parsed, normalize_space, table_markdown};
use super::text_utils::decode_text;
use super::*;
pub(super) fn parse_markdown(
    doc_id: Uuid,
    parse_job_id: Uuid,
    title: &str,
    bytes: &[u8],
) -> Result<ParsedDocument> {
    let text = decode_text(bytes).context("invalid_markdown_encoding")?;
    let mut blocks = Vec::new();
    let mut tables = Vec::new();
    let mut heading_path: Vec<(i32, String)> = Vec::new();
    let mut in_frontmatter = false;
    let mut frontmatter = Vec::new();
    let mut in_code = false;
    let mut code_fence = Vec::new();
    let mut paragraph = Vec::new();
    let mut table_lines = Vec::new();
    let mut warnings = Vec::new();

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

    if in_frontmatter {
        push_markdown_block(
            &mut blocks,
            "metadata",
            frontmatter.join("\n"),
            None,
            &heading_path,
            json!({"format": "md", "source": "frontmatter"}),
        );
        warnings.push("markdown_unclosed_frontmatter".to_string());
    }
    if in_code {
        push_markdown_block(
            &mut blocks,
            "code",
            code_fence.join("\n"),
            None,
            &heading_path,
            json!({"format": "md", "source": "code_fence"}),
        );
        warnings.push("markdown_unclosed_code_fence".to_string());
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

    let mut parsed = finalize_parsed(
        doc_id,
        parse_job_id,
        "md",
        title,
        None,
        blocks,
        tables,
        anchors,
    );
    parsed.warnings.extend(warnings);
    Ok(parsed)
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
    if table_lines.len() < 2 || !markdown_table_separator(&table_lines[1]) {
        if !table_lines.is_empty() {
            let text = table_lines.join("\n");
            push_markdown_block(
                blocks,
                "paragraph",
                text,
                None,
                heading_path,
                json!({"format": "md", "source": "paragraph"}),
            );
        }
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

fn markdown_table_separator(line: &str) -> bool {
    let cells = line.trim().trim_matches('|').split('|');
    let mut count = 0usize;
    for cell in cells {
        let cell = cell.trim().trim_matches(':');
        if cell.len() < 3 || !cell.chars().all(|ch| ch == '-') {
            return false;
        }
        count += 1;
    }
    count > 0
}

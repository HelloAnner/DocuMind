use serde_json::json;

use crate::document::{estimate_tokens, ChunkDraft};

use super::ChunkConfig;

pub(super) fn split_table_text(text: &str, cfg: &ChunkConfig) -> Vec<String> {
    let lines = text.lines().map(str::to_string).collect::<Vec<_>>();
    let max_rows = cfg.max_table_rows_per_chunk.max(1);
    let max_tokens = cfg
        .max_table_token_per_chunk
        .min(cfg.max_chunk_tokens)
        .max(1);
    if lines.len() <= max_rows + 2 && estimate_tokens(text) <= max_tokens {
        return vec![text.to_string()];
    }

    let header_len = if lines.get(1).is_some_and(|line| {
        line.contains("---")
            && line
                .chars()
                .all(|character| matches!(character, '|' | '-' | ':' | ' '))
    }) {
        2
    } else {
        1.min(lines.len())
    };
    let header = lines[..header_len].join("\n");
    let mut parts = Vec::new();
    let mut rows = Vec::new();
    for line in &lines[header_len..] {
        let mut candidate_rows = rows.clone();
        candidate_rows.push(line.clone());
        let candidate = format!("{}\n{}", header, candidate_rows.join("\n"));
        if !rows.is_empty()
            && (candidate_rows.len() > max_rows || estimate_tokens(&candidate) > max_tokens)
        {
            parts.push(format!("{}\n{}", header, rows.join("\n")));
            rows.clear();
        }
        let single_row_candidate = format!("{header}\n{line}");
        if rows.is_empty() && estimate_tokens(&single_row_candidate) > max_tokens {
            let row_budget = (max_tokens - estimate_tokens(&header) - 1).max(1);
            parts.extend(
                split_by_token_limit(line, row_budget)
                    .into_iter()
                    .map(|fragment| format!("{header}\n{fragment}")),
            );
            continue;
        }
        rows.push(line.clone());
    }
    if !rows.is_empty() {
        parts.push(format!("{}\n{}", header, rows.join("\n")));
    }
    if parts.is_empty() {
        split_by_token_limit(text, max_tokens)
    } else {
        parts
    }
}

pub(super) fn merge_small_adjacent_chunks(chunks: &mut Vec<ChunkDraft>, cfg: &ChunkConfig) {
    if chunks.len() < 2 || cfg.min_chunk_tokens <= 0 {
        return;
    }
    let mut merged: Vec<ChunkDraft> = Vec::with_capacity(chunks.len());
    for chunk in chunks.drain(..) {
        let can_merge = merged.last().is_some_and(|previous| {
            chunk.token_count < cfg.min_chunk_tokens
                && previous.token_count + chunk.token_count <= cfg.max_chunk_tokens
                && compatible(previous, &chunk)
        });
        if can_merge {
            if let Some(previous) = merged.last_mut() {
                merge_chunk(previous, chunk);
            } else {
                merged.push(chunk);
            }
        } else {
            merged.push(chunk);
        }
    }
    *chunks = merged;
}

fn compatible(left: &ChunkDraft, right: &ChunkDraft) -> bool {
    if left.source_type == "table" || right.source_type == "table" {
        return false;
    }
    if left.slide_end.is_some()
        && right.slide_start.is_some()
        && left.slide_end != right.slide_start
    {
        return false;
    }
    let left_h1 = left.heading_path.first();
    let right_h1 = right.heading_path.first();
    left_h1.is_none() || right_h1.is_none() || left_h1 == right_h1
}

fn merge_chunk(left: &mut ChunkDraft, right: ChunkDraft) {
    left.content = format!("{}\n\n{}", left.content.trim(), right.content.trim());
    left.token_count = estimate_tokens(&left.content);
    left.page_start = min_option(left.page_start, right.page_start);
    left.page_end = max_option(left.page_end, right.page_end);
    left.slide_start = min_option(left.slide_start, right.slide_start);
    left.slide_end = max_option(left.slide_end, right.slide_end);
    extend_unique(&mut left.block_ids, right.block_ids);
    extend_unique(&mut left.table_ids, right.table_ids);
    extend_unique(&mut left.anchor_ids, right.anchor_ids);
    if let Some(metadata) = left.metadata.as_object_mut() {
        metadata.insert("split_reason".to_string(), json!("min_chunk_merge"));
    }
}

pub(super) fn split_by_token_limit(text: &str, max_tokens: i32) -> Vec<String> {
    let max_tokens = max_tokens.max(1);
    let mut parts = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        let mut candidate = current.clone();
        candidate.push(character);
        if !current.is_empty() && estimate_tokens(&candidate) > max_tokens {
            parts.push(std::mem::take(&mut current));
        }
        current.push(character);
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

fn min_option(left: Option<i32>, right: Option<i32>) -> Option<i32> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (left, right) => left.or(right),
    }
}

fn max_option(left: Option<i32>, right: Option<i32>) -> Option<i32> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, right) => left.or(right),
    }
}

fn extend_unique<T: Eq>(target: &mut Vec<T>, values: Vec<T>) {
    for value in values {
        if !target.contains(&value) {
            target.push(value);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use crate::document::cleaning::CleanedBlock;
    use crate::document::{estimate_tokens, FileType, ParsedBlock};

    use super::super::{chunk_blocks, ChunkConfig};
    use super::split_table_text;

    #[test]
    fn table_parts_repeat_headers_and_respect_limits() {
        let cfg = config(40, 0);
        let table = "| 区域 | 金额 |\n|---|---|\n| 华东 | 100 |\n| 华南 | 200 |\n| 华北 | 300 |\n| 西南 | 400 |";

        let parts = split_table_text(table, &cfg);

        assert!(parts.len() > 1);
        assert!(parts
            .iter()
            .all(|part| part.starts_with("| 区域 | 金额 |\n|---|---|")));
        assert!(parts
            .iter()
            .all(|part| estimate_tokens(part) <= cfg.max_table_token_per_chunk));
    }

    #[test]
    fn oversized_table_row_is_split_within_the_token_limit() {
        let cfg = config(40, 0);
        let table = format!(
            "| 字段 | 内容 |\n|---|---|\n| 说明 | {} |",
            "超长内容".repeat(80)
        );

        let parts = split_table_text(&table, &cfg);

        assert!(parts.len() > 1);
        assert!(parts
            .iter()
            .all(|part| estimate_tokens(part) <= cfg.max_table_token_per_chunk));
    }

    #[test]
    fn pdf_heuristic_headings_do_not_create_tiny_chunks() {
        let cfg = config(200, 0);
        let blocks = (0..8)
            .map(|index| cleaned_block("heading", Some(1), &format!("第 {index} 节简短标题")))
            .collect::<Vec<_>>();

        let chunks = chunk_blocks(FileType::Pdf, Uuid::nil(), Uuid::new_v4(), &blocks, &cfg);

        assert_eq!(chunks.len(), 1);
    }

    #[test]
    fn overlap_keeps_final_chunks_below_the_configured_maximum() {
        let cfg = config(200, 40);
        let blocks = vec![cleaned_block("paragraph", None, &"正文内容".repeat(180))];

        let chunks = chunk_blocks(FileType::Text, Uuid::nil(), Uuid::new_v4(), &blocks, &cfg);

        assert!(chunks.len() > 1);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.token_count <= cfg.max_chunk_tokens));
    }

    fn config(max_tokens: i32, overlap_tokens: i32) -> ChunkConfig {
        ChunkConfig {
            target_chunk_tokens: max_tokens / 2,
            max_chunk_tokens: max_tokens,
            hard_split_tokens: max_tokens,
            min_chunk_tokens: 0,
            overlap_tokens,
            max_table_rows_per_chunk: 2,
            max_table_token_per_chunk: max_tokens,
        }
    }

    fn cleaned_block(block_type: &str, heading_level: Option<i32>, text: &str) -> CleanedBlock {
        CleanedBlock {
            block: ParsedBlock {
                block_id: Uuid::new_v4(),
                block_index: 0,
                block_type: block_type.to_string(),
                text: text.to_string(),
                heading_level,
                heading_path: vec![],
                page_start: Some(1),
                page_end: Some(1),
                slide_index: None,
                table_id: None,
                bbox: None,
                anchor_ids: vec![],
                source_ref: json!({}),
                metadata: json!({}),
            },
            cleaned_text: text.to_string(),
            is_removed: false,
            remove_reason: None,
            cleaning_ops: vec![],
        }
    }
}

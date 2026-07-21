use super::*;
pub(super) fn add_overlap(chunks: &mut [ChunkDraft], cfg: &ChunkConfig) {
    if chunks.len() < 2 || cfg.overlap_tokens <= 0 {
        return;
    }
    let half = (cfg.overlap_tokens / 2).max(1);
    let originals = chunks.iter().map(|c| c.content.clone()).collect::<Vec<_>>();
    let ids = chunks
        .iter()
        .map(|c| c.block_ids.clone())
        .collect::<Vec<_>>();

    for idx in 0..chunks.len() {
        let mut prev_ids = Vec::new();
        let mut next_ids = Vec::new();
        let mut content = chunks[idx].content.clone();
        let available = (cfg.max_chunk_tokens - estimate_tokens(&content)).max(0);
        let side_budget = half.min(available / 2);
        if idx > 0 && can_overlap(&chunks[idx - 1], &chunks[idx]) {
            let prev = tail_text(&originals[idx - 1], side_budget);
            if !prev.trim().is_empty() {
                content = format!("【上文】{}\n\n{}", prev.trim(), content);
                prev_ids = ids[idx - 1].clone();
            }
        }
        if idx + 1 < chunks.len() && can_overlap(&chunks[idx], &chunks[idx + 1]) {
            let next = head_text(&originals[idx + 1], side_budget);
            if !next.trim().is_empty() {
                content = format!("{}\n\n【下文】{}", content, next.trim());
                next_ids = ids[idx + 1].clone();
            }
        }

        chunks[idx].content = content;
        chunks[idx].token_count = estimate_tokens(&chunks[idx].content);
        if let Some(meta) = chunks[idx].metadata.as_object_mut() {
            meta.insert("overlap_tokens".to_string(), json!(cfg.overlap_tokens));
            meta.insert("overlap_prev_block_ids".to_string(), json!(prev_ids));
            meta.insert("overlap_next_block_ids".to_string(), json!(next_ids));
        }
    }
}

fn can_overlap(left: &ChunkDraft, right: &ChunkDraft) -> bool {
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

fn tail_text(text: &str, tokens: i32) -> String {
    if tokens <= 0 {
        return String::new();
    }
    let max_chars = (tokens * 2).max(1) as usize;
    let chars = text.chars().collect::<Vec<_>>();
    let start = chars.len().saturating_sub(max_chars);
    chars[start..].iter().collect()
}

fn head_text(text: &str, tokens: i32) -> String {
    if tokens <= 0 {
        return String::new();
    }
    let max_chars = (tokens * 2).max(1) as usize;
    text.chars().take(max_chars).collect()
}

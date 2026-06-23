use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use super::cleaning::CleanedBlock;
use super::{estimate_tokens, ChunkDraft, FileType};

pub const CHUNKER_VERSION: &str = "documind-chunker@0.1.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkConfig {
    pub target_chunk_tokens: i32,
    pub max_chunk_tokens: i32,
    pub hard_split_tokens: i32,
    pub min_chunk_tokens: i32,
    pub overlap_tokens: i32,
    pub max_table_rows_per_chunk: usize,
    pub max_table_token_per_chunk: i32,
}

impl Default for ChunkConfig {
    fn default() -> Self {
        Self {
            target_chunk_tokens: env_i32("RAG_TARGET_CHUNK_TOKENS", 800),
            max_chunk_tokens: env_i32("RAG_MAX_CHUNK_TOKENS", 1500),
            hard_split_tokens: env_i32("RAG_HARD_SPLIT_TOKENS", 2000),
            min_chunk_tokens: env_i32("RAG_MIN_CHUNK_TOKENS", 200),
            overlap_tokens: env_i32("RAG_CHUNK_OVERLAP_TOKENS", 200),
            max_table_rows_per_chunk: env_usize("RAG_MAX_TABLE_ROWS_PER_CHUNK", 50),
            max_table_token_per_chunk: env_i32("RAG_MAX_TABLE_TOKEN_PER_CHUNK", 1200),
        }
    }
}

#[derive(Debug, Clone)]
struct BlockGroup {
    blocks: Vec<CleanedBlock>,
    tokens: i32,
    source_type: String,
}

impl BlockGroup {
    fn new() -> Self {
        Self {
            blocks: Vec::new(),
            tokens: 0,
            source_type: "paragraph".to_string(),
        }
    }

    fn is_empty(&self) -> bool {
        self.blocks.is_empty()
    }

    fn push(&mut self, block: CleanedBlock, tokens: i32) {
        if self.blocks.is_empty() {
            self.source_type = source_type_for(&block);
        }
        self.tokens += tokens;
        self.blocks.push(block);
    }
}

pub fn chunk_blocks(
    file_type: FileType,
    kb_id: Uuid,
    parse_job_id: Uuid,
    cleaned_blocks: &[CleanedBlock],
    cfg: &ChunkConfig,
) -> Vec<ChunkDraft> {
    let usable = cleaned_blocks
        .iter()
        .filter(|b| !b.is_removed && !b.cleaned_text.trim().is_empty())
        .cloned()
        .collect::<Vec<_>>();

    let mut groups = Vec::new();
    let mut current = BlockGroup::new();

    for block in usable {
        if is_hard_boundary(&block, &current) {
            if !current.is_empty() {
                groups.push(current);
                current = BlockGroup::new();
            }
            if block.block.block_type == "table" {
                groups.push(single_block_group(block));
                continue;
            }
        }

        let tokens = estimate_tokens(&block.cleaned_text);
        if !current.is_empty() && current.tokens + tokens > cfg.target_chunk_tokens {
            groups.push(current);
            current = BlockGroup::new();
        }
        current.push(block, tokens);
    }
    if !current.is_empty() {
        groups.push(current);
    }

    let mut chunks = Vec::new();
    for group in groups {
        split_group(file_type, kb_id, parse_job_id, group, cfg, &mut chunks);
    }

    add_overlap(&mut chunks, cfg);
    for (idx, chunk) in chunks.iter_mut().enumerate() {
        chunk.chunk_index = idx as i32;
    }
    chunks
}

fn single_block_group(block: CleanedBlock) -> BlockGroup {
    let tokens = estimate_tokens(&block.cleaned_text);
    let mut group = BlockGroup::new();
    group.push(block, tokens);
    group
}

fn is_hard_boundary(block: &CleanedBlock, current: &BlockGroup) -> bool {
    if current.is_empty() {
        return false;
    }
    if block.block.block_type == "table" || block.block.block_type == "code" {
        return true;
    }
    if block.block.heading_level == Some(1) {
        return true;
    }
    let current_slide = current.blocks.last().and_then(|b| b.block.slide_index);
    current_slide.is_some()
        && block.block.slide_index.is_some()
        && current_slide != block.block.slide_index
}

fn split_group(
    file_type: FileType,
    kb_id: Uuid,
    parse_job_id: Uuid,
    group: BlockGroup,
    cfg: &ChunkConfig,
    chunks: &mut Vec<ChunkDraft>,
) {
    if group.tokens <= cfg.max_chunk_tokens {
        chunks.push(chunk_from_group(
            file_type,
            kb_id,
            parse_job_id,
            group,
            "group",
        ));
        return;
    }

    if group.blocks.len() > 1 {
        let mut current = BlockGroup::new();
        for block in group.blocks {
            let tokens = estimate_tokens(&block.cleaned_text);
            if !current.is_empty() && current.tokens + tokens > cfg.max_chunk_tokens {
                let finished = std::mem::replace(&mut current, BlockGroup::new());
                chunks.push(chunk_from_group(
                    file_type,
                    kb_id,
                    parse_job_id,
                    finished,
                    "block_boundary",
                ));
            }
            current.push(block, tokens);
        }
        if !current.is_empty() {
            chunks.push(chunk_from_group(
                file_type,
                kb_id,
                parse_job_id,
                current,
                "block_boundary",
            ));
        }
        return;
    }

    let Some(block) = group.blocks.into_iter().next() else {
        return;
    };

    for part in split_long_text(&block.cleaned_text, cfg) {
        let mut part_block = block.clone();
        part_block.cleaned_text = part;
        chunks.push(chunk_from_group(
            file_type,
            kb_id,
            parse_job_id,
            single_block_group(part_block),
            "text_split",
        ));
    }
}

fn chunk_from_group(
    file_type: FileType,
    _kb_id: Uuid,
    _parse_job_id: Uuid,
    group: BlockGroup,
    split_reason: &str,
) -> ChunkDraft {
    let heading_path = group
        .blocks
        .iter()
        .find(|b| !b.block.heading_path.is_empty())
        .map(|b| b.block.heading_path.clone())
        .unwrap_or_default();
    let page_start = group.blocks.iter().filter_map(|b| b.block.page_start).min();
    let page_end = group.blocks.iter().filter_map(|b| b.block.page_end).max();
    let slide_start = group
        .blocks
        .iter()
        .filter_map(|b| b.block.slide_index)
        .min();
    let slide_end = group
        .blocks
        .iter()
        .filter_map(|b| b.block.slide_index)
        .max();
    let block_ids = group
        .blocks
        .iter()
        .map(|b| b.block.block_id)
        .collect::<Vec<_>>();
    let table_ids = group
        .blocks
        .iter()
        .filter_map(|b| b.block.table_id)
        .collect::<Vec<_>>();

    let mut content_parts = Vec::new();
    if !heading_path.is_empty() {
        content_parts.push(format!("标题路径：{}", heading_path.join(" / ")));
    }
    if let Some(page) = page_start {
        content_parts.push(format!("页码：{page}"));
    }
    if let Some(slide) = slide_start {
        content_parts.push(format!("Slide：{slide}"));
    }
    content_parts.push(String::new());
    content_parts.push(
        group
            .blocks
            .iter()
            .map(|b| b.cleaned_text.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let content = content_parts.join("\n").trim().to_string();

    ChunkDraft {
        chunk_id: Uuid::new_v4(),
        chunk_index: 0,
        source_type: group.source_type,
        token_count: estimate_tokens(&content),
        content,
        heading_path,
        page_start,
        page_end,
        slide_start,
        slide_end,
        block_ids,
        table_ids,
        metadata: json!({
            "format": file_type.as_str(),
            "chunker_version": CHUNKER_VERSION,
            "split_reason": split_reason,
            "overlap_tokens": 0,
            "overlap_prev_block_ids": [],
            "overlap_next_block_ids": [],
        }),
    }
}

fn source_type_for(block: &CleanedBlock) -> String {
    match block.block.block_type.as_str() {
        "table" => "table",
        "slide_note" => "slide_note",
        "footnote" => "footnote",
        "code" => "code",
        "heading" => "paragraph",
        other => other,
    }
    .to_string()
}

fn split_long_text(text: &str, cfg: &ChunkConfig) -> Vec<String> {
    if estimate_tokens(text) <= cfg.max_chunk_tokens {
        return vec![text.to_string()];
    }

    let sentence_parts = split_by_sentence(text);
    let mut out = Vec::new();
    let mut current = String::new();
    for part in sentence_parts {
        let next = if current.is_empty() {
            part.clone()
        } else {
            format!("{current}{part}")
        };
        if estimate_tokens(&next) > cfg.max_chunk_tokens && !current.is_empty() {
            out.extend(force_split(&current, cfg.hard_split_tokens));
            current = part;
        } else {
            current = next;
        }
    }
    if !current.is_empty() {
        out.extend(force_split(&current, cfg.hard_split_tokens));
    }
    out
}

fn split_by_sentence(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        current.push(c);
        if matches!(c, '。' | '！' | '？' | ';' | '；' | '!' | '?') {
            out.push(current.clone());
            current.clear();
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn force_split(text: &str, hard_split_tokens: i32) -> Vec<String> {
    if estimate_tokens(text) <= hard_split_tokens {
        return vec![text.to_string()];
    }
    let max_chars = (hard_split_tokens.max(100) * 2) as usize;
    let chars = text.chars().collect::<Vec<_>>();
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + max_chars).min(chars.len());
        out.push(chars[start..end].iter().collect());
        start = end;
    }
    out
}

fn add_overlap(chunks: &mut [ChunkDraft], cfg: &ChunkConfig) {
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
        if idx > 0 && can_overlap(&chunks[idx - 1], &chunks[idx]) {
            let prev = tail_text(&originals[idx - 1], half);
            if !prev.trim().is_empty() {
                content = format!("【上文】{}\n\n{}", prev.trim(), content);
                prev_ids = ids[idx - 1].clone();
            }
        }
        if idx + 1 < chunks.len() && can_overlap(&chunks[idx], &chunks[idx + 1]) {
            let next = head_text(&originals[idx + 1], half);
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
    let max_chars = (tokens * 2).max(1) as usize;
    let chars = text.chars().collect::<Vec<_>>();
    let start = chars.len().saturating_sub(max_chars);
    chars[start..].iter().collect()
}

fn head_text(text: &str, tokens: i32) -> String {
    let max_chars = (tokens * 2).max(1) as usize;
    text.chars().take(max_chars).collect()
}

fn env_i32(name: &str, default: i32) -> i32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

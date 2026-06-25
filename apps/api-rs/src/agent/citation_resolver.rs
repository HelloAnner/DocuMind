use std::collections::{BTreeSet, HashMap, HashSet};

use uuid::Uuid;

use crate::models::agent::CitationOutput;
use crate::models::citation::CitationAnchor;
use crate::models::rag::{EvidencePack, RerankedChunk};

const MAX_QUOTE_CHARS: usize = 180;
const MAX_CITATIONS: usize = 6;

pub fn resolve_citations(answer: &str, evidence: &EvidencePack) -> Vec<CitationOutput> {
    let cited_indexes = cited_evidence_indexes(answer);
    let mut selected = Vec::new();

    for (evidence_index, chunk) in evidence.chunks.iter().enumerate() {
        let one_based = evidence_index as i32 + 1;
        if !cited_indexes.is_empty() && !cited_indexes.contains(&one_based) {
            continue;
        }
        selected.push((one_based, chunk));
    }

    if selected.is_empty() && cited_indexes.is_empty() {
        selected.extend(
            evidence
                .chunks
                .iter()
                .take(3)
                .enumerate()
                .map(|(index, chunk)| (index as i32 + 1, chunk)),
        );
    }

    let mut by_key: HashMap<String, CitationOutput> = HashMap::new();
    let mut order = Vec::new();

    for (original_index, chunk) in selected {
        let anchor = anchor_for_chunk(chunk);
        let key = canonical_key(chunk, &anchor);
        let quote = compact_quote(&chunk.chunk.content);

        if let Some(existing) = by_key.get_mut(&key) {
            existing.score = existing.score.max(chunk.score);
            if quote.chars().count() > existing.quote.chars().count() {
                existing.quote = quote;
            }
            continue;
        }

        order.push(key.clone());
        by_key.insert(
            key,
            CitationOutput {
                index: original_index,
                chunk_id: chunk.chunk.chunk_id,
                doc_id: chunk.chunk.doc_id,
                doc_title: chunk.chunk.doc_title.clone(),
                page_range: chunk.chunk.page_range.clone(),
                quote,
                score: chunk.score,
                source_status: "available".to_string(),
                anchor: Some(anchor),
            },
        );
    }

    order.into_iter()
        .filter_map(|key| by_key.remove(&key))
        .take(MAX_CITATIONS)
        .collect()
}

fn cited_evidence_indexes(answer: &str) -> BTreeSet<i32> {
    let mut indexes = BTreeSet::new();
    let mut chars = answer.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '[' {
            continue;
        }
        let mut digits = String::new();
        while let Some(next) = chars.peek().copied() {
            if next.is_ascii_digit() {
                digits.push(next);
                chars.next();
            } else {
                break;
            }
        }
        if digits.is_empty() {
            continue;
        }
        if chars.next() != Some(']') {
            continue;
        }
        if let Ok(index) = digits.parse::<i32>() {
            indexes.insert(index);
        }
    }

    indexes
}

fn anchor_for_chunk(chunk: &RerankedChunk) -> CitationAnchor {
    let page = chunk.chunk.page_range.first().copied();
    let slide = metadata_i32(&chunk.chunk.metadata, "slide_start")
        .or_else(|| metadata_i32(&chunk.chunk.metadata, "slide"))
        .or_else(|| metadata_i32(&chunk.chunk.metadata, "slide_end"));
    let kind = if !chunk.chunk.table_ids.is_empty() || chunk.chunk.source_type() == "table" {
        "table_region"
    } else if slide.is_some() {
        "slide_shape"
    } else {
        "paragraph"
    };
    let location_status = if !chunk.chunk.block_ids.is_empty() || !chunk.chunk.table_ids.is_empty()
    {
        "structural_only"
    } else if slide.is_some() {
        "slide_only"
    } else if page.is_some() {
        "page_only"
    } else {
        "unavailable"
    };

    CitationAnchor {
        format: chunk.chunk.file_type.clone(),
        kind: kind.to_string(),
        page,
        slide,
        block_ids: chunk.chunk.block_ids.clone(),
        table_ids: chunk.chunk.table_ids.clone(),
        location_status: location_status.to_string(),
    }
}

fn metadata_i32(metadata: &serde_json::Value, key: &str) -> Option<i32> {
    metadata.get(key).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|s| s.parse::<i64>().ok()))
            .map(|value| value as i32)
    })
}

fn canonical_key(chunk: &RerankedChunk, anchor: &CitationAnchor) -> String {
    let block_key = anchor
        .block_ids
        .first()
        .map(Uuid::to_string)
        .or_else(|| anchor.table_ids.first().map(Uuid::to_string))
        .unwrap_or_else(|| compact_key_text(&chunk.chunk.content));
    let page = anchor
        .page
        .map(|page| page.to_string())
        .or_else(|| anchor.slide.map(|slide| format!("slide-{slide}")))
        .unwrap_or_else(|| "unknown".to_string());

    format!(
        "{}::{}::{}::{}::{}",
        chunk.chunk.doc_id, anchor.format, anchor.kind, page, block_key
    )
}

fn compact_key_text(content: &str) -> String {
    content
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .take(80)
        .collect()
}

fn compact_quote(content: &str) -> String {
    let text = strip_context_prefixes(content)
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut quote = String::new();
    for ch in text.chars().take(MAX_QUOTE_CHARS) {
        quote.push(ch);
    }
    if text.chars().count() > MAX_QUOTE_CHARS {
        quote.push_str("...");
    }
    quote
}

fn strip_context_prefixes(content: &str) -> String {
    let mut lines = Vec::new();
    let mut skipped = HashSet::new();
    skipped.insert("标题路径");
    skipped.insert("页码");
    skipped.insert("Slide");

    for line in content.lines() {
        let trimmed = line.trim();
        if skipped.iter().any(|prefix| trimmed.starts_with(prefix)) {
            continue;
        }
        if trimmed.is_empty() && lines.is_empty() {
            continue;
        }
        lines.push(trimmed);
    }

    lines.join("\n").trim().to_string()
}

trait RetrievedChunkExt {
    fn source_type(&self) -> &str;
}

impl RetrievedChunkExt for crate::models::rag::RetrievedChunk {
    fn source_type(&self) -> &str {
        self.metadata
            .get("source_type")
            .and_then(|value| value.as_str())
            .unwrap_or("paragraph")
    }
}

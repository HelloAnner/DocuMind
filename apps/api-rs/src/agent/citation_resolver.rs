use std::collections::{BTreeSet, HashMap, HashSet};

use uuid::Uuid;

use crate::models::agent::CitationOutput;
use crate::models::citation::CitationAnchor;
use crate::models::rag::{EvidencePack, RerankedChunk};

const MAX_QUOTE_CHARS: usize = 180;
const MAX_CITATIONS: usize = 6;

pub fn resolve_citations(answer: &str, evidence: &EvidencePack) -> Vec<CitationOutput> {
    let cited_indexes = cited_evidence_indexes(answer);
    if cited_indexes.is_empty() {
        return vec![];
    }
    let mut selected = Vec::new();

    for (evidence_index, chunk) in evidence.chunks.iter().enumerate() {
        let one_based = evidence_index as i32 + 1;
        if !cited_indexes.contains(&one_based) {
            continue;
        }
        selected.push((one_based, chunk));
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

    order
        .into_iter()
        .filter_map(|key| by_key.remove(&key))
        .take(MAX_CITATIONS)
        .collect()
}

pub fn cited_evidence_indexes(answer: &str) -> BTreeSet<i32> {
    let mut indexes = BTreeSet::new();
    let mut chars = answer.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '[' {
            continue;
        }
        let mut marker = String::new();
        while let Some(next) = chars.peek().copied() {
            chars.next();
            if next == ']' {
                break;
            }
            marker.push(next);
        }
        for part in marker.split(',') {
            if let Ok(index) = part.trim().parse::<i32>() {
                if index > 0 {
                    indexes.insert(index);
                }
            }
        }
    }

    indexes
}

fn anchor_for_chunk(chunk: &RerankedChunk) -> CitationAnchor {
    let primary = chunk.chunk.primary_anchor.as_ref();
    let page = primary
        .and_then(|a| a.page)
        .or_else(|| chunk.chunk.page_range.first().copied());
    let slide = primary
        .and_then(|a| a.slide)
        .or_else(|| metadata_i32(&chunk.chunk.metadata, "slide_start"))
        .or_else(|| metadata_i32(&chunk.chunk.metadata, "slide"))
        .or_else(|| metadata_i32(&chunk.chunk.metadata, "slide_end"));
    let kind = primary.map(|a| a.kind.clone()).unwrap_or_else(|| {
        if !chunk.chunk.table_ids.is_empty() || chunk.chunk.source_type() == "table" {
            "table_region".to_string()
        } else if slide.is_some() {
            "slide_shape".to_string()
        } else {
            "paragraph".to_string()
        }
    });
    let bbox = primary.and_then(|a| a.bbox.clone());
    let char_range = primary.and_then(|a| a.char_range.clone());
    let anchor_id = primary.map(|a| a.anchor_id);
    let parse_job_id = primary.map(|a| a.parse_job_id);

    let location_status = if bbox.is_some() || char_range.is_some() {
        "exact"
    } else if !chunk.chunk.block_ids.is_empty() || !chunk.chunk.table_ids.is_empty() {
        "structural_only"
    } else if slide.is_some() {
        "slide_only"
    } else if page.is_some() {
        "page_only"
    } else {
        "unavailable"
    };

    CitationAnchor {
        anchor_id,
        parse_job_id,
        format: primary
            .map(|a| a.format.clone())
            .unwrap_or_else(|| chunk.chunk.file_type.clone()),
        kind,
        page,
        slide,
        block_ids: chunk.chunk.block_ids.clone(),
        table_ids: chunk.chunk.table_ids.clone(),
        char_range,
        bbox,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::rag::RetrievedChunk;
    use crate::models::trace::RetrievalSource;

    #[test]
    fn parses_adjacent_and_grouped_citation_markers() {
        assert_eq!(
            cited_evidence_indexes("结论 [1, 2][3]"),
            BTreeSet::from([1, 2, 3])
        );
    }

    #[test]
    fn answer_without_markers_does_not_receive_automatic_citations() {
        let evidence = EvidencePack {
            chunks: vec![evidence_chunk()],
            context_text: "evidence".to_string(),
        };
        assert!(resolve_citations("没有引用标记的答案", &evidence).is_empty());
    }

    #[test]
    fn out_of_range_markers_do_not_map_to_another_chunk() {
        let evidence = EvidencePack {
            chunks: vec![evidence_chunk()],
            context_text: "evidence".to_string(),
        };
        assert!(resolve_citations("错误引用 [2]", &evidence).is_empty());
    }

    fn evidence_chunk() -> RerankedChunk {
        RerankedChunk {
            chunk: RetrievedChunk {
                chunk_id: Uuid::new_v4(),
                doc_id: Uuid::new_v4(),
                doc_title: "测试文档".to_string(),
                file_type: "docx".to_string(),
                content: "可核验的文档事实".to_string(),
                heading_path: vec![],
                page_range: vec![1],
                block_ids: vec![],
                table_ids: vec![],
                anchor_ids: vec![],
                primary_anchor_id: None,
                anchor_quality: "page_only".to_string(),
                primary_anchor: None,
                metadata: serde_json::json!({}),
                score: 0.9,
                source: RetrievalSource::Rrf,
            },
            score: 0.9,
            rank: 1,
        }
    }
}

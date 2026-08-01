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

    let mut seen_docs = HashSet::new();

    selected
        .into_iter()
        .filter(|(_, chunk)| seen_docs.insert(chunk.chunk.doc_id))
        .map(|(index, chunk)| CitationOutput {
            index,
            chunk_id: chunk.chunk.chunk_id,
            doc_id: chunk.chunk.doc_id,
            doc_title: chunk.chunk.doc_title.clone(),
            page_range: chunk.chunk.page_range.clone(),
            quote: compact_quote(&chunk.chunk.content),
            score: chunk.score,
            source_status: "available".to_string(),
            anchor: Some(anchor_for_chunk(chunk)),
        })
        .take(MAX_CITATIONS)
        .collect()
}

pub fn canonicalize_citation_markers(answer: &str, evidence: &EvidencePack) -> String {
    let cited = cited_evidence_indexes(answer);
    let mut first_by_doc = HashMap::new();
    let replacements: HashMap<i32, i32> = cited
        .into_iter()
        .filter_map(|index| {
            let doc_id = evidence.chunks.get(index as usize - 1)?.chunk.doc_id;
            let canonical = *first_by_doc.entry(doc_id).or_insert(index);
            Some((index, canonical))
        })
        .collect();

    let mut result = String::with_capacity(answer.len());
    let mut rest = answer;
    while let Some(start) = rest.find('[') {
        result.push_str(&rest[..start]);
        let marker = &rest[start..];
        let Some(end) = marker.find(']') else {
            result.push_str(marker);
            return result;
        };
        let values = marker[1..end]
            .split(',')
            .map(str::trim)
            .map(str::parse::<i32>)
            .collect::<Result<Vec<_>, _>>();
        if let Ok(values) = values {
            let mut canonical = Vec::new();
            for value in values {
                let value = replacements.get(&value).copied().unwrap_or(value);
                if !canonical.contains(&value) {
                    canonical.push(value);
                }
            }
            result.push('[');
            result.push_str(
                &canonical
                    .iter()
                    .map(i32::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
            );
            result.push(']');
        } else {
            result.push_str(&marker[..=end]);
        }
        rest = &marker[end + 1..];
    }
    result.push_str(rest);
    result
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

    #[test]
    fn one_document_produces_one_source_and_one_marker_number() {
        let first = evidence_chunk();
        let mut second = evidence_chunk();
        second.chunk.doc_id = first.chunk.doc_id;
        second.chunk.page_range = vec![2];
        let evidence = EvidencePack {
            chunks: vec![first, second],
            context_text: "evidence".to_string(),
        };

        assert_eq!(
            resolve_citations("结论甲 [1]，结论乙 [2]", &evidence).len(),
            1
        );
        assert_eq!(
            canonicalize_citation_markers("结论甲 [1]，结论乙 [2]", &evidence),
            "结论甲 [1]，结论乙 [1]"
        );
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

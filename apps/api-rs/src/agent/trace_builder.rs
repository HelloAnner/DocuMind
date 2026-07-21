use crate::models::rag::{RerankedChunk, RetrievedChunk};
use crate::models::trace::{RetrievalSource, RetrievalTrace};

pub fn retrieved_traces(message_id: uuid::Uuid, chunks: &[RetrievedChunk]) -> Vec<RetrievalTrace> {
    chunks
        .iter()
        .enumerate()
        .map(|(index, item)| RetrievalTrace {
            id: uuid::Uuid::new_v4(),
            message_id,
            chunk_id: item.chunk_id,
            doc_id: item.doc_id,
            source: item.source,
            rank: index as i32 + 1,
            score: item.score,
            heading_path: item.heading_path.clone(),
            page_range: item.page_range.clone(),
            content_preview: content_preview(&item.content),
        })
        .collect()
}

pub fn reranked_traces(message_id: uuid::Uuid, chunks: &[RerankedChunk]) -> Vec<RetrievalTrace> {
    chunks
        .iter()
        .enumerate()
        .map(|(index, item)| RetrievalTrace {
            id: uuid::Uuid::new_v4(),
            message_id,
            chunk_id: item.chunk.chunk_id,
            doc_id: item.chunk.doc_id,
            source: RetrievalSource::Rerank,
            rank: index as i32 + 1,
            score: item.score,
            heading_path: item.chunk.heading_path.clone(),
            page_range: item.chunk.page_range.clone(),
            content_preview: content_preview(&item.chunk.content),
        })
        .collect()
}

fn content_preview(content: &str) -> String {
    const MAX_CHARS: usize = 500;
    let mut preview = content.chars().take(MAX_CHARS).collect::<String>();
    if content.chars().count() > MAX_CHARS {
        preview.push_str("...");
    }
    preview
}

use anyhow::Result;

use crate::models::rag::{ContextInput, EvidencePack};

#[async_trait::async_trait]
pub trait ContextAssembler: Send + Sync {
    async fn assemble(&self, input: ContextInput) -> Result<EvidencePack>;
}

pub struct SimpleContextAssembler;

impl SimpleContextAssembler {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SimpleContextAssembler {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ContextAssembler for SimpleContextAssembler {
    async fn assemble(&self, input: ContextInput) -> Result<EvidencePack> {
        let mut lines = vec![];
        let mut selected = Vec::new();
        let mut used_chars = 0usize;
        for chunk in input.chunks {
            let chunk_chars = chunk.chunk.content.chars().count();
            if !selected.is_empty()
                && used_chars.saturating_add(chunk_chars) > input.max_context_chars.max(1)
            {
                continue;
            }
            used_chars = used_chars.saturating_add(chunk_chars);
            selected.push(chunk);
        }
        for (i, chunk) in selected.iter().enumerate() {
            let index = i + 1;
            let heading = if chunk.chunk.heading_path.is_empty() {
                String::new()
            } else {
                format!(" > {}", chunk.chunk.heading_path.join(" > "))
            };
            let page = if chunk.chunk.page_range.is_empty() {
                String::new()
            } else {
                format!(
                    "第{}",
                    chunk
                        .chunk
                        .page_range
                        .iter()
                        .map(|p| p.to_string())
                        .collect::<Vec<_>>()
                        .join("-")
                )
            };
            lines.push(format!(
                "[{index}] 文档: {title} {page}{heading}\n{content}",
                title = chunk.chunk.doc_title,
                content = chunk.chunk.content,
            ));
        }
        Ok(EvidencePack {
            chunks: selected,
            context_text: lines.join("\n\n"),
        })
    }
}

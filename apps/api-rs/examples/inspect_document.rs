use std::path::Path;

use anyhow::{Context, Result};
use documind::document;
use serde::Serialize;
use uuid::Uuid;

#[derive(Serialize)]
struct DocumentInspection {
    file_name: String,
    file_type: String,
    pages: Option<i32>,
    blocks: usize,
    tables: usize,
    chunks: usize,
    anchors: usize,
    unanchored_blocks: usize,
    bbox_anchors: usize,
    quality_score: f64,
    warnings: Vec<String>,
    content: String,
}

fn main() -> Result<()> {
    let paths = std::env::args().skip(1).collect::<Vec<_>>();
    if paths.is_empty() {
        anyhow::bail!("usage: cargo run -p documind --example inspect_document -- <files...>");
    }

    for path in paths {
        let path = Path::new(&path);
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .context("fixture file name is not UTF-8")?;
        let bytes = std::fs::read(path)
            .with_context(|| format!("failed to read fixture {}", path.display()))?;
        let bundle = document::parse_document(
            Uuid::new_v4(),
            Uuid::new_v4(),
            file_name,
            mime_type(path),
            &bytes,
        )
        .with_context(|| format!("failed to parse fixture {}", path.display()))?;
        let inspection = DocumentInspection {
            file_name: file_name.to_string(),
            file_type: bundle.file_type.as_str().to_string(),
            pages: bundle.parsed.pages,
            blocks: bundle.parsed.blocks.len(),
            tables: bundle.parsed.tables.len(),
            chunks: bundle.chunks.len(),
            anchors: bundle.parsed.anchors.len(),
            unanchored_blocks: bundle
                .parsed
                .blocks
                .iter()
                .filter(|block| block.anchor_ids.is_empty())
                .count(),
            bbox_anchors: bundle
                .parsed
                .anchors
                .iter()
                .filter(|anchor| anchor.bbox.is_some())
                .count(),
            quality_score: bundle.parsed.quality_score,
            warnings: bundle.parsed.warnings,
            content: bundle
                .cleaned_blocks
                .iter()
                .filter(|block| !block.is_removed)
                .map(|block| block.cleaned_text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        };
        println!("{}", serde_json::to_string(&inspection)?);
    }
    Ok(())
}

fn mime_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("pdf") => "application/pdf",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("md" | "markdown") => "text/markdown",
        Some("txt") => "text/plain",
        _ => "application/octet-stream",
    }
}

use super::plain_text::split_paragraphs;
use super::shared::finalize_parsed;
use super::*;
pub(super) fn parse_pdf(
    doc_id: Uuid,
    parse_job_id: Uuid,
    title: &str,
    bytes: &[u8],
) -> Result<ParsedDocument> {
    let page_count = pdf_page_sizes(bytes)
        .map(|sizes| sizes.len())
        .unwrap_or_default();
    if page_count > MAX_PDF_PAGES {
        bail!("pdf_page_count_exceeded:{}>{}", page_count, MAX_PDF_PAGES);
    }

    let pages = pdf_extract::extract_text_from_mem_by_pages(bytes)
        .or_else(|_| {
            pdf_extract::extract_text_from_mem(bytes).map(|text| {
                if text.contains('\x0C') {
                    text.split('\x0C').map(str::to_string).collect()
                } else {
                    vec![text]
                }
            })
        })
        .context("pdf_text_extract_failed")?;

    if pages.len() > MAX_PDF_PAGES {
        bail!("pdf_page_count_exceeded:{}>{}", pages.len(), MAX_PDF_PAGES);
    }

    let mut blocks = Vec::new();
    let mut anchors = Vec::new();
    let mut warnings = Vec::new();
    let mut current_heading: Option<String> = None;
    let mut pages_without_text = 0usize;

    for (page_idx, page_text) in pages.iter().enumerate() {
        let page = (page_idx + 1) as i32;
        let page_chars = page_text.chars().count();
        if page_chars > MAX_PDF_PAGE_TEXT_CHARS {
            bail!("pdf_page_text_chars_exceeded:{page}:{page_chars}>{MAX_PDF_PAGE_TEXT_CHARS}");
        }
        let paragraphs = split_paragraphs(page_text);
        if paragraphs.is_empty() {
            pages_without_text += 1;
            warnings.push(format!("pdf_page_{}_no_text_layer", page));
        }

        for paragraph in &paragraphs {
            let trimmed = paragraph.trim();
            if trimmed.is_empty() {
                continue;
            }
            let is_heading = looks_like_heading(trimmed);
            let block_id = Uuid::new_v4();
            let anchor = SourceAnchor::for_pdf_paragraph(
                doc_id,
                parse_job_id,
                Uuid::nil(), // tenant_id 将在上层填充
                block_id,
                page,
                trimmed,
                None,
            );
            let anchor_id = anchor.anchor_id;
            anchors.push(anchor);

            let heading_path = current_heading.iter().cloned().collect::<Vec<_>>();
            blocks.push(ParsedBlock {
                block_id,
                block_index: blocks.len() as i32,
                block_type: if is_heading { "heading" } else { "paragraph" }.to_string(),
                text: trimmed.to_string(),
                heading_level: is_heading.then_some(1),
                heading_path: if is_heading { vec![] } else { heading_path },
                page_start: Some(page),
                page_end: Some(page),
                slide_index: None,
                table_id: None,
                bbox: None,
                anchor_ids: vec![anchor_id],
                source_ref: json!({"format": "pdf", "page": page}),
                metadata: json!({"layout": "text_layer"}),
            });
            if is_heading {
                current_heading = Some(trimmed.to_string());
            }
        }
    }
    if blocks.is_empty() {
        warnings.push("scanned_pdf_no_text_layer".to_string());
    } else if pages_without_text > 0 {
        warnings.push(format!(
            "pdf_partial_text_layer:{}/{}",
            pages_without_text,
            pages.len()
        ));
    }
    let mut parsed = finalize_parsed(
        doc_id,
        parse_job_id,
        "pdf",
        title,
        Some(pages.len() as i32),
        blocks,
        vec![],
        anchors,
    );
    parsed.warnings.extend(warnings);
    Ok(parsed)
}

fn looks_like_heading(text: &str) -> bool {
    let char_count = text.chars().count();
    if !(2..=80).contains(&char_count)
        || text.ends_with(['.', '。', '！', '!', '？', '?', '；', ';', '，', ','])
    {
        return false;
    }
    let meaningful = text.chars().filter(|c| c.is_alphanumeric()).count();
    let digits = text.chars().filter(|c| c.is_ascii_digit()).count();
    meaningful > 0 && digits.saturating_mul(2) < meaningful
}

/// 使用 lopdf 提取每页的 CropBox/MediaBox 尺寸（点）。
fn pdf_page_sizes(bytes: &[u8]) -> Result<Vec<(f64, f64)>> {
    let doc = lopdf::Document::load_mem(bytes).context("lopdf_load_failed")?;
    let pages = doc.get_pages();
    let mut sizes = Vec::new();
    for page_num in 1..=pages.len() as u32 {
        let page_id = pages
            .get(&page_num)
            .copied()
            .ok_or_else(|| anyhow!("lopdf_missing_page_{}", page_num))?;
        let bounds = page_bounds(&doc, page_id);
        if let lopdf::Object::Array(arr) = bounds {
            if arr.len() >= 4 {
                let x0 = as_f64(&arr[0]).unwrap_or(0.0);
                let y0 = as_f64(&arr[1]).unwrap_or(0.0);
                let x1 = as_f64(&arr[2]).unwrap_or(595.0);
                let y1 = as_f64(&arr[3]).unwrap_or(842.0);
                sizes.push(((x1 - x0).abs(), (y1 - y0).abs()));
            }
        }
    }
    Ok(sizes)
}

fn page_bounds(doc: &lopdf::Document, page_id: lopdf::ObjectId) -> lopdf::Object {
    let default = lopdf::Object::Array(vec![
        lopdf::Object::Integer(0),
        lopdf::Object::Integer(0),
        lopdf::Object::Integer(595),
        lopdf::Object::Integer(842),
    ]);
    let Ok(page) = doc.get_dictionary(page_id) else {
        return default;
    };
    let resolve = |obj: &lopdf::Object| doc.get_object(obj.as_reference().unwrap_or((0, 0))).ok();
    page.get(b"CropBox")
        .ok()
        .and_then(resolve)
        .or_else(|| page.get(b"MediaBox").ok().and_then(resolve))
        .cloned()
        .unwrap_or(default)
}

fn as_f64(obj: &lopdf::Object) -> Option<f64> {
    match obj {
        lopdf::Object::Integer(i) => Some(*i as f64),
        lopdf::Object::Real(f) => Some((*f).into()),
        _ => None,
    }
}

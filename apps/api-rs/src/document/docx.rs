use super::shared::*;
use super::*;
pub(super) fn parse_docx(
    doc_id: Uuid,
    parse_job_id: Uuid,
    title: &str,
    bytes: &[u8],
) -> Result<ParsedDocument> {
    let mut archive = open_zip(bytes)?;
    let xml = read_zip_text(&mut archive, "word/document.xml")?;
    let style_levels = read_zip_text(&mut archive, "word/styles.xml")
        .ok()
        .map(|styles| {
            validate_xml_nesting(&styles)?;
            docx_style_heading_levels(&styles)
        })
        .transpose()?
        .unwrap_or_default();
    validate_xml_nesting(&xml)?;
    let doc = roxmltree::Document::parse(&xml).context("invalid_docx_xml")?;
    let body = doc
        .descendants()
        .find(|n| n.tag_name().name() == "body")
        .ok_or_else(|| anyhow!("docx_body_missing"))?;

    let mut blocks = Vec::new();
    let mut tables = Vec::new();
    let mut anchors = Vec::new();
    let mut heading_path: Vec<(i32, String)> = Vec::new();

    let content_nodes = body
        .descendants()
        .filter(|node| {
            if !node.is_element() || !matches!(node.tag_name().name(), "p" | "tbl") {
                return false;
            }
            !node
                .ancestors()
                .skip(1)
                .take_while(|ancestor| *ancestor != body)
                .any(|ancestor| {
                    ancestor.is_element() && matches!(ancestor.tag_name().name(), "p" | "tbl")
                })
        })
        .collect::<Vec<_>>();

    for child in content_nodes {
        match child.tag_name().name() {
            "p" => {
                let text = collect_text(child).trim().to_string();
                if text.is_empty() {
                    continue;
                }
                let style = paragraph_style(child);
                let has_numbering = child.descendants().any(|n| n.tag_name().name() == "numPr");
                let heading_level = paragraph_outline_level(child)
                    .or_else(|| {
                        style
                            .as_ref()
                            .and_then(|style| style_levels.get(style).copied())
                    })
                    .or_else(|| heading_level_from_style(style.as_deref()));
                let block_type = if heading_level.is_some() {
                    "heading"
                } else if has_numbering {
                    "list_item"
                } else {
                    "paragraph"
                };
                if let Some(level) = heading_level {
                    heading_path.retain(|(existing, _)| *existing < level);
                    heading_path.push((level, text.clone()));
                }
                let path = if block_type == "heading" {
                    heading_path
                        .iter()
                        .take(heading_path.len().saturating_sub(1))
                        .map(|(_, h)| h.clone())
                        .collect()
                } else {
                    heading_path.iter().map(|(_, h)| h.clone()).collect()
                };
                blocks.push(ParsedBlock {
                    block_id: Uuid::new_v4(),
                    block_index: blocks.len() as i32,
                    block_type: block_type.to_string(),
                    text,
                    heading_level,
                    heading_path: path,
                    page_start: None,
                    page_end: None,
                    slide_index: None,
                    table_id: None,
                    bbox: None,
                    anchor_ids: vec![],
                    source_ref: json!({"format": "docx", "node": "w:p", "index": blocks.len()}),
                    metadata: json!({"style": style}),
                });
            }
            "tbl" => {
                let block_id = Uuid::new_v4();
                let table = parse_xml_table(
                    child,
                    doc_id,
                    parse_job_id,
                    block_id,
                    tables.len() as i32,
                    heading_path.iter().map(|(_, h)| h.clone()).collect(),
                    None,
                    None,
                    None,
                    "docx",
                );
                blocks.push(ParsedBlock {
                    block_id,
                    block_index: blocks.len() as i32,
                    block_type: "table".to_string(),
                    text: table.markdown.clone(),
                    heading_level: None,
                    heading_path: table.heading_path.clone(),
                    page_start: None,
                    page_end: None,
                    slide_index: None,
                    table_id: Some(table.table_id),
                    bbox: None,
                    anchor_ids: vec![],
                    source_ref: json!({"format": "docx", "node": "w:tbl", "index": tables.len()}),
                    metadata: json!({}),
                });
                tables.push(table);
            }
            _ => {}
        }
    }
    attach_table_cell_anchors(
        doc_id,
        parse_job_id,
        "docx",
        &mut blocks,
        &tables,
        &mut anchors,
    );

    Ok(finalize_parsed(
        doc_id,
        parse_job_id,
        "docx",
        title,
        None,
        blocks,
        tables,
        anchors,
    ))
}

fn paragraph_style(p: roxmltree::Node) -> Option<String> {
    p.descendants()
        .find(|n| n.tag_name().name() == "pStyle")
        .and_then(|n| attr(n, "val"))
        .map(str::to_string)
}

fn paragraph_outline_level(p: roxmltree::Node) -> Option<i32> {
    p.descendants()
        .find(|node| node.tag_name().name() == "outlineLvl")
        .and_then(|node| attr_i32(node, "val"))
        .map(|level| (level + 1).clamp(1, 9))
}

fn docx_style_heading_levels(xml: &str) -> Result<std::collections::BTreeMap<String, i32>> {
    let doc = roxmltree::Document::parse(xml).context("invalid_docx_styles_xml")?;
    let mut levels = std::collections::BTreeMap::new();
    for style in doc
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "style")
    {
        let Some(style_id) = attr(style, "styleId") else {
            continue;
        };
        let level = style
            .descendants()
            .find(|node| node.tag_name().name() == "outlineLvl")
            .and_then(|node| attr_i32(node, "val"))
            .map(|level| (level + 1).clamp(1, 9))
            .or_else(|| {
                style
                    .descendants()
                    .find(|node| node.tag_name().name() == "name")
                    .and_then(|node| attr(node, "val"))
                    .and_then(|name| heading_level_from_style(Some(name)))
            });
        if let Some(level) = level {
            levels.insert(style_id.to_string(), level);
        }
    }
    Ok(levels)
}

fn heading_level_from_style(style: Option<&str>) -> Option<i32> {
    let normalized = style?.to_ascii_lowercase().replace(' ', "");
    for level in 1..=6 {
        if normalized == format!("heading{level}") || normalized == format!("标题{level}") {
            return Some(level);
        }
    }
    None
}

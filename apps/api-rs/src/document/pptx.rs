use super::shared::*;
use super::*;
pub(super) fn parse_pptx(
    doc_id: Uuid,
    parse_job_id: Uuid,
    title: &str,
    bytes: &[u8],
) -> Result<ParsedDocument> {
    let mut archive = open_zip(bytes)?;
    let (slide_names, used_relationship_order) = pptx_slide_names(&mut archive)?;

    let mut blocks = Vec::new();
    let mut tables = Vec::new();
    let mut anchors = Vec::new();
    let mut warnings = Vec::new();
    if !used_relationship_order {
        warnings.push("pptx_slide_order_fallback".to_string());
    }

    for (slide_idx, name) in slide_names.iter().enumerate() {
        let xml = read_zip_text(&mut archive, name)?;
        validate_xml_nesting(&xml)?;
        let doc = roxmltree::Document::parse(&xml).context("invalid_pptx_slide_xml")?;
        let mut slide_heading: Vec<String> = Vec::new();
        let mut has_text = false;
        let sp_tree = doc
            .descendants()
            .find(|node| node.is_element() && node.tag_name().name() == "spTree");
        let shape_nodes: Vec<_> = sp_tree
            .map(|tree| tree.children().filter(|node| node.is_element()).collect())
            .unwrap_or_default();

        for (shape_idx, shape) in shape_nodes.into_iter().enumerate() {
            if let Some(tbl) = shape
                .descendants()
                .find(|node| node.is_element() && node.tag_name().name() == "tbl")
            {
                let block_id = Uuid::new_v4();
                let table = parse_xml_table(
                    tbl,
                    doc_id,
                    parse_job_id,
                    block_id,
                    tables.len() as i32,
                    slide_heading.clone(),
                    None,
                    None,
                    Some((slide_idx + 1) as i32),
                    "pptx",
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
                    slide_index: Some((slide_idx + 1) as i32),
                    table_id: Some(table.table_id),
                    bbox: None,
                    anchor_ids: vec![],
                    source_ref: json!({"format": "pptx", "slide": slide_idx + 1, "shape": shape_idx + 1, "node": "a:tbl"}),
                    metadata: json!({}),
                });
                tables.push(table);
                continue;
            }

            let is_title_shape = shape.descendants().any(|node| {
                node.is_element()
                    && node.tag_name().name() == "ph"
                    && attr(node, "type").is_some_and(|kind| matches!(kind, "title" | "ctrTitle"))
            });
            for p in shape
                .descendants()
                .filter(|node| node.is_element() && node.tag_name().name() == "p")
            {
                let text = collect_text(p).trim().to_string();
                if text.is_empty() {
                    continue;
                }
                let is_bullet = p
                    .descendants()
                    .any(|node| matches!(node.tag_name().name(), "buChar" | "buAutoNum"));
                let is_heading = is_title_shape || !has_text;
                let block_type = if is_heading {
                    "heading"
                } else if is_bullet {
                    "list_item"
                } else {
                    "paragraph"
                };
                if is_heading {
                    slide_heading = vec![text.clone()];
                }
                has_text = true;
                blocks.push(ParsedBlock {
                    block_id: Uuid::new_v4(),
                    block_index: blocks.len() as i32,
                    block_type: block_type.to_string(),
                    text,
                    heading_level: is_heading.then_some(1),
                    heading_path: if is_heading { vec![] } else { slide_heading.clone() },
                    page_start: None,
                    page_end: None,
                    slide_index: Some((slide_idx + 1) as i32),
                    table_id: None,
                    bbox: None,
                    anchor_ids: vec![],
                    source_ref: json!({"format": "pptx", "slide": slide_idx + 1, "shape": shape_idx + 1, "node": "a:p"}),
                    metadata: json!({"placeholder_title": is_title_shape}),
                });
            }
        }

        if !has_text
            && !blocks
                .iter()
                .any(|block| block.slide_index == Some((slide_idx + 1) as i32))
        {
            warnings.push(format!("slide_{}_empty", slide_idx + 1));
        }
    }
    attach_table_cell_anchors(
        doc_id,
        parse_job_id,
        "pptx",
        &mut blocks,
        &tables,
        &mut anchors,
    );

    let mut parsed = finalize_parsed(
        doc_id,
        parse_job_id,
        "pptx",
        title,
        Some(slide_names.len() as i32),
        blocks,
        tables,
        anchors,
    );
    parsed.warnings.extend(warnings);
    Ok(parsed)
}

fn pptx_slide_names(archive: &mut ZipArchive<Cursor<&[u8]>>) -> Result<(Vec<String>, bool)> {
    if let (Ok(presentation_xml), Ok(rels_xml)) = (
        read_zip_text(archive, "ppt/presentation.xml"),
        read_zip_text(archive, "ppt/_rels/presentation.xml.rels"),
    ) {
        validate_xml_nesting(&presentation_xml)?;
        validate_xml_nesting(&rels_xml)?;
        let presentation = roxmltree::Document::parse(&presentation_xml)
            .context("invalid_pptx_presentation_xml")?;
        let relationships =
            roxmltree::Document::parse(&rels_xml).context("invalid_pptx_relationships_xml")?;
        let targets = relationships
            .descendants()
            .filter(|node| node.is_element() && node.tag_name().name() == "Relationship")
            .filter_map(|node| Some((attr(node, "Id")?, attr(node, "Target")?)))
            .collect::<std::collections::BTreeMap<_, _>>();
        let ordered = presentation
            .descendants()
            .filter(|node| node.is_element() && node.tag_name().name() == "sldId")
            .filter_map(|node| {
                node.attributes()
                    .find(|attribute| {
                        attribute.name() == "id" && attribute.value().starts_with("rId")
                    })
                    .map(|attribute| attribute.value())
            })
            .filter_map(|relationship_id| targets.get(relationship_id))
            .map(|target| normalize_ppt_target(target))
            .collect::<Vec<_>>();
        if !ordered.is_empty() {
            return Ok((ordered, true));
        }
    }

    let mut slide_names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|name| {
            name.starts_with("ppt/slides/slide")
                && name.ends_with(".xml")
                && name["ppt/slides/slide".len()..]
                    .trim_end_matches(".xml")
                    .chars()
                    .all(|c| c.is_ascii_digit())
        })
        .collect();
    slide_names.sort_by_key(|name| {
        name.trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<i32>()
            .unwrap_or(0)
    });

    Ok((slide_names, false))
}

fn normalize_ppt_target(target: &str) -> String {
    let target = target.trim_start_matches('/');
    if target.starts_with("ppt/") {
        target.to_string()
    } else {
        format!("ppt/{}", target.trim_start_matches("../"))
    }
}

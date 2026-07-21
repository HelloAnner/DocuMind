use super::*;
pub(super) fn attach_table_cell_anchors(
    doc_id: Uuid,
    parse_job_id: Uuid,
    format: &str,
    blocks: &mut [ParsedBlock],
    tables: &[ParsedTable],
    anchors: &mut Vec<SourceAnchor>,
) {
    for block in blocks.iter_mut().filter(|block| block.table_id.is_some()) {
        if block
            .anchor_ids
            .iter()
            .any(|anchor_id| anchors.iter().any(|anchor| anchor.anchor_id == *anchor_id))
        {
            continue;
        }
        let Some(table_id) = block.table_id else {
            continue;
        };
        let Some(table) = tables.iter().find(|table| table.table_id == table_id) else {
            continue;
        };
        let cell_range = table_cell_range(table);
        let source_ref = json!({
            "format": format,
            "table_index": table.table_index,
            "table_id": table.table_id,
            "kind": "table_cell_range",
            "cell_range": {
                "row_start": cell_range.row_start,
                "row_end": cell_range.row_end,
                "col_start": cell_range.col_start,
                "col_end": cell_range.col_end,
            }
        });
        let anchor = SourceAnchor::table_cell_range(
            doc_id,
            parse_job_id,
            Uuid::nil(),
            format,
            block.block_id,
            table.table_id,
            table.page_start.or(block.page_start),
            table.slide_index.or(block.slide_index),
            cell_range,
            source_ref,
            &table.markdown,
        );
        block.anchor_ids.push(anchor.anchor_id);
        anchors.push(anchor);
    }
}

fn table_cell_range(table: &ParsedTable) -> CellRange {
    let row_end = table
        .cells
        .iter()
        .map(|cell| cell.row_index + cell.rowspan.max(1) - 1)
        .max()
        .unwrap_or(0);
    let col_end = table
        .cells
        .iter()
        .map(|cell| cell.col_index + cell.colspan.max(1) - 1)
        .max()
        .unwrap_or(0);
    CellRange {
        row_start: 0,
        row_end,
        col_start: 0,
        col_end,
    }
}

pub(super) fn finalize_parsed(
    doc_id: Uuid,
    parse_job_id: Uuid,
    file_type: &str,
    title: &str,
    pages: Option<i32>,
    blocks: Vec<ParsedBlock>,
    tables: Vec<ParsedTable>,
    anchors: Vec<SourceAnchor>,
) -> ParsedDocument {
    ParsedDocument {
        doc_id,
        parse_job_id,
        file_type: file_type.to_string(),
        title: title.to_string(),
        pages,
        blocks,
        tables,
        anchors,
        warnings: vec![],
        quality_score: 0.0,
    }
}

pub(super) fn parse_xml_table(
    tbl: roxmltree::Node,
    _doc_id: Uuid,
    _parse_job_id: Uuid,
    block_id: Uuid,
    table_index: i32,
    heading_path: Vec<String>,
    page_start: Option<i32>,
    page_end: Option<i32>,
    slide_index: Option<i32>,
    format: &str,
) -> ParsedTable {
    let table_id = Uuid::new_v4();
    let row_nodes: Vec<_> = tbl
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "tr")
        .collect();
    let mut rows = Vec::new();
    let mut cells: Vec<ParsedTableCell> = Vec::new();
    let mut vertical_merges = std::collections::BTreeMap::<i32, usize>::new();
    for (row_idx, row) in row_nodes.iter().enumerate() {
        let cell_nodes: Vec<_> = row
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "tc")
            .collect();
        let mut row_values = Vec::new();
        let mut col_idx = 0_i32;
        for cell in &cell_nodes {
            let text = collect_text(*cell).trim().to_string();
            let colspan = attr_i32(*cell, "gridSpan")
                .or_else(|| {
                    cell.descendants()
                        .find(|n| n.tag_name().name() == "gridSpan")
                        .and_then(|n| attr_i32(n, "val"))
                })
                .unwrap_or(1)
                .max(1);
            let vertical_merge = cell
                .descendants()
                .find(|node| node.tag_name().name() == "vMerge");
            let continues_vertical_merge = vertical_merge
                .and_then(|node| attr(node, "val"))
                .map(|value| value != "restart")
                .unwrap_or(vertical_merge.is_some());
            if continues_vertical_merge {
                if let Some(origin_index) = vertical_merges.get(&col_idx).copied() {
                    cells[origin_index].rowspan += 1;
                }
                row_values.extend(std::iter::repeat_n(String::new(), colspan as usize));
                col_idx += colspan;
                continue;
            }

            row_values.push(text.clone());
            row_values.extend(std::iter::repeat_n(
                String::new(),
                colspan.saturating_sub(1) as usize,
            ));
            let cell_index = cells.len();
            cells.push(ParsedTableCell {
                cell_id: Uuid::new_v4(),
                row_index: row_idx as i32,
                col_index: col_idx,
                rowspan: attr_i32(*cell, "rowSpan").unwrap_or(1).max(1),
                colspan,
                normalized_text: normalize_space(&text),
                text,
                is_header: row_idx == 0,
                data_type: "text".to_string(),
                bbox: None,
                style: json!({}),
                source_ref: json!({"format": format, "table_index": table_index, "row": row_idx, "col": col_idx}),
            });
            for column in col_idx..col_idx + colspan {
                if vertical_merge
                    .and_then(|node| attr(node, "val"))
                    .is_some_and(|value| value == "restart")
                {
                    vertical_merges.insert(column, cell_index);
                } else {
                    vertical_merges.remove(&column);
                }
            }
            col_idx += colspan;
        }
        if !row_values.iter().all(|v| v.is_empty()) {
            rows.push(row_values);
        }
    }
    let headers = rows.first().cloned().unwrap_or_default();
    let markdown = table_markdown(&headers, rows.get(1..).unwrap_or(&[]));
    let total_slots = rows.iter().map(Vec::len).sum::<usize>();
    let empty_slots = rows
        .iter()
        .flat_map(|row| row.iter())
        .filter(|value| value.trim().is_empty())
        .count();
    let empty_cell_ratio = if total_slots == 0 {
        1.0
    } else {
        empty_slots as f64 / total_slots as f64
    };
    ParsedTable {
        table_id,
        block_id,
        table_index,
        title: heading_path.last().cloned(),
        heading_path,
        page_start,
        page_end,
        slide_index,
        headers,
        rows: rows.get(1..).unwrap_or(&[]).to_vec(),
        cells,
        markdown,
        quality: json!({
            "header_confidence": if rows.is_empty() { 0.0 } else { 0.9 },
            "grid_confidence": 0.95,
            "empty_cell_ratio": empty_cell_ratio,
            "warnings": []
        }),
        source_ref: json!({"format": format, "table_index": table_index}),
    }
}

pub(super) fn zip_entry_names(bytes: &[u8]) -> Result<Vec<String>> {
    let mut archive = open_zip(bytes)?;
    Ok((0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect())
}

pub(super) fn open_zip(bytes: &[u8]) -> Result<ZipArchive<Cursor<&[u8]>>> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).context("invalid_zip_container")?;
    validate_office_zip(&mut archive)?;
    Ok(archive)
}

pub(super) fn read_zip_text(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<String> {
    let mut file = archive
        .by_name(name)
        .with_context(|| format!("missing_zip_entry:{name}"))?;
    if file.size() > MAX_OFFICE_XML_BYTES {
        bail!(
            "zip_xml_entry_too_large:{name}:{}>{}",
            file.size(),
            MAX_OFFICE_XML_BYTES
        );
    }
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(text)
}

pub(super) fn validate_xml_nesting(xml: &str) -> Result<()> {
    use quick_xml::events::Event;

    let mut reader = quick_xml::Reader::from_str(xml);
    let mut depth = 0usize;
    loop {
        match reader.read_event() {
            Ok(Event::Start(_)) => {
                depth += 1;
                if depth > MAX_OFFICE_XML_DEPTH {
                    bail!("office_xml_nesting_exceeded:{depth}>{MAX_OFFICE_XML_DEPTH}");
                }
            }
            Ok(Event::End(_)) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| anyhow!("invalid_office_xml_nesting"))?;
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(anyhow!("invalid_office_xml:{error}")),
        }
    }
    if depth != 0 {
        bail!("invalid_office_xml_nesting");
    }
    Ok(())
}

fn validate_office_zip(archive: &mut ZipArchive<Cursor<&[u8]>>) -> Result<()> {
    if archive.len() > MAX_OFFICE_ZIP_ENTRIES {
        bail!(
            "zip_entry_count_exceeded:{}>{}",
            archive.len(),
            MAX_OFFICE_ZIP_ENTRIES
        );
    }

    let mut total_uncompressed = 0_u64;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .with_context(|| format!("invalid_zip_entry:{index}"))?;
        let name = file.name().to_string();
        if !is_safe_zip_entry_name(&name) {
            bail!("zip_entry_name_unsafe:{name}");
        }

        let uncompressed = file.size();
        let compressed = file.compressed_size();
        if uncompressed > MAX_OFFICE_ENTRY_BYTES {
            bail!("zip_entry_too_large:{name}:{uncompressed}>{MAX_OFFICE_ENTRY_BYTES}");
        }
        total_uncompressed = total_uncompressed
            .checked_add(uncompressed)
            .ok_or_else(|| anyhow!("zip_uncompressed_size_overflow"))?;
        if total_uncompressed > MAX_OFFICE_UNCOMPRESSED_BYTES {
            bail!(
                "zip_uncompressed_size_exceeded:{total_uncompressed}>{MAX_OFFICE_UNCOMPRESSED_BYTES}"
            );
        }
        if uncompressed > 0 && compressed == 0 {
            bail!("zip_entry_invalid_compressed_size:{name}");
        }
        if compressed > 0 && uncompressed > compressed.saturating_mul(MAX_OFFICE_COMPRESSION_RATIO)
        {
            bail!(
                "zip_compression_ratio_exceeded:{name}:{uncompressed}/{compressed}>{MAX_OFFICE_COMPRESSION_RATIO}"
            );
        }
    }

    Ok(())
}

fn is_safe_zip_entry_name(name: &str) -> bool {
    if name.trim().is_empty()
        || name.starts_with('/')
        || name.starts_with('\\')
        || name.contains('\0')
        || name.contains(':')
    {
        return false;
    }
    let normalized = name.replace('\\', "/");
    normalized
        .trim_end_matches('/')
        .split('/')
        .all(|part| !part.is_empty() && part != "." && part != "..")
}

pub(super) fn collect_text(node: roxmltree::Node) -> String {
    let mut text = String::new();
    for n in node.descendants() {
        if n.is_text() {
            text.push_str(n.text().unwrap_or_default());
        } else if n.is_element() && matches!(n.tag_name().name(), "tab") {
            text.push('\t');
        } else if n.is_element() && matches!(n.tag_name().name(), "br" | "cr") {
            text.push('\n');
        }
    }
    normalize_space(&text)
}

pub(super) fn attr<'a>(node: roxmltree::Node<'a, 'a>, local_name: &str) -> Option<&'a str> {
    node.attributes()
        .find(|a| a.name() == local_name)
        .map(|a| a.value())
}

pub(super) fn attr_i32(node: roxmltree::Node, local_name: &str) -> Option<i32> {
    attr(node, local_name).and_then(|v| v.parse().ok())
}

pub(super) fn normalize_space(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn table_markdown(headers: &[String], rows: &[Vec<String>]) -> String {
    if headers.is_empty() {
        return rows
            .iter()
            .map(|row| row.join(" | "))
            .collect::<Vec<_>>()
            .join("\n");
    }
    let mut out = String::new();
    out.push('|');
    out.push_str(
        &headers
            .iter()
            .map(|h| escape_table_cell(h))
            .collect::<Vec<_>>()
            .join("|"),
    );
    out.push_str("|\n|");
    out.push_str(&headers.iter().map(|_| "---").collect::<Vec<_>>().join("|"));
    out.push_str("|\n");
    for row in rows {
        out.push('|');
        out.push_str(
            &row.iter()
                .map(|v| escape_table_cell(v))
                .collect::<Vec<_>>()
                .join("|"),
        );
        out.push_str("|\n");
    }
    out
}

fn escape_table_cell(value: &str) -> String {
    value.replace('|', "\\|").replace('\n', "<br>")
}

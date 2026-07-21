use super::*;
pub(super) fn score_quality(parsed: &ParsedDocument) -> f64 {
    if parsed.blocks.is_empty() {
        return 0.2;
    }
    let char_count: usize = parsed.blocks.iter().map(|b| b.text.chars().count()).sum();
    let text_score = if char_count >= 500 {
        0.95
    } else if char_count >= 100 {
        0.8
    } else if char_count >= 20 {
        0.55
    } else {
        0.25
    };
    let invalid_chars = parsed
        .blocks
        .iter()
        .flat_map(|block| block.text.chars())
        .filter(|c| {
            *c == '\u{fffd}'
                || (c.is_control() && !matches!(*c, '\n' | '\r' | '\t'))
                || matches!(*c as u32, 0xe000..=0xf8ff | 0xf0000..=0xffffd | 0x100000..=0x10fffd)
        })
        .count();
    let legibility_score = if char_count == 0 {
        0.0
    } else {
        let invalid_ratio = invalid_chars as f64 / char_count as f64;
        if invalid_ratio >= 0.1 {
            0.15
        } else if invalid_ratio >= 0.02 {
            0.55
        } else {
            1.0
        }
    };
    let structure_score =
        if parsed.tables.is_empty() && !parsed.blocks.iter().any(|b| b.block_type == "heading") {
            0.7
        } else {
            0.95
        };
    let anchored_blocks = parsed
        .blocks
        .iter()
        .filter(|block| !block.anchor_ids.is_empty())
        .count();
    let anchor_score = anchored_blocks as f64 / parsed.blocks.len() as f64;
    let page_score = parsed.pages.map_or(1.0, |pages| {
        if pages <= 0 {
            return 0.0;
        }
        let covered = parsed
            .blocks
            .iter()
            .filter_map(|block| block.page_start.or(block.slide_index))
            .collect::<std::collections::BTreeSet<_>>()
            .len();
        (covered as f64 / pages as f64).clamp(0.0, 1.0)
    });
    let warning_penalty = quality_warning_penalty(&parsed.warnings);
    (0.3 * text_score
        + 0.2 * legibility_score
        + 0.15 * structure_score
        + 0.2 * anchor_score
        + 0.15 * page_score
        - warning_penalty)
        .clamp(0.0, 1.0)
}

fn quality_warning_penalty(warnings: &[String]) -> f64 {
    let mut penalty = warnings.len() as f64 * 0.02;
    for warning in warnings {
        if warning == "scanned_pdf_no_text_layer" {
            penalty += 0.4;
        } else if let Some(ratio) = warning.strip_prefix("pdf_partial_text_layer:") {
            let missing_ratio = ratio
                .split_once('/')
                .and_then(|(missing, total)| {
                    Some(missing.parse::<f64>().ok()? / total.parse::<f64>().ok()?)
                })
                .unwrap_or(0.0);
            penalty += if missing_ratio >= 0.15 { 0.15 } else { 0.05 };
        }
    }
    penalty.min(0.5)
}

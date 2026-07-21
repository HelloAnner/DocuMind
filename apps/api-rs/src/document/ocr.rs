use std::collections::BTreeMap;

use anyhow::{anyhow, Result};

use crate::models::NormalizedBBox;

#[derive(Debug, Clone)]
pub struct OcrTextBlock {
    pub text: String,
    pub bbox: NormalizedBBox,
    pub confidence: f64,
}

#[derive(Debug, Clone)]
pub struct OcrPage {
    pub blocks: Vec<OcrTextBlock>,
    pub mean_confidence: f64,
}

#[derive(Debug)]
struct BlockAccumulator {
    words: Vec<String>,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    confidences: Vec<f64>,
}

impl BlockAccumulator {
    fn new(left: i32, top: i32, width: i32, height: i32) -> Self {
        Self {
            words: Vec::new(),
            left,
            top,
            right: left + width,
            bottom: top + height,
            confidences: Vec::new(),
        }
    }

    fn push(&mut self, text: &str, left: i32, top: i32, width: i32, height: i32, conf: f64) {
        self.words.push(text.to_string());
        self.left = self.left.min(left);
        self.top = self.top.min(top);
        self.right = self.right.max(left + width);
        self.bottom = self.bottom.max(top + height);
        self.confidences.push(conf);
    }
}

pub fn parse_tesseract_tsv(tsv: &str) -> Result<OcrPage> {
    let mut page_width = 0_i32;
    let mut page_height = 0_i32;
    let mut groups = BTreeMap::<(i32, i32), BlockAccumulator>::new();

    for line in tsv.lines().skip(1) {
        let columns = line.splitn(12, '\t').collect::<Vec<_>>();
        if columns.len() != 12 {
            continue;
        }
        let level = parse_i32(columns[0])?;
        let block_num = parse_i32(columns[2])?;
        let paragraph_num = parse_i32(columns[3])?;
        let left = parse_i32(columns[6])?;
        let top = parse_i32(columns[7])?;
        let width = parse_i32(columns[8])?;
        let height = parse_i32(columns[9])?;
        if level == 1 {
            page_width = width;
            page_height = height;
            continue;
        }
        if level != 5 {
            continue;
        }
        let text = columns[11].trim();
        let confidence = columns[10].parse::<f64>().unwrap_or(-1.0);
        if text.is_empty() || confidence < 0.0 || width <= 0 || height <= 0 {
            continue;
        }
        groups
            .entry((block_num, paragraph_num))
            .or_insert_with(|| BlockAccumulator::new(left, top, width, height))
            .push(text, left, top, width, height, confidence);
    }

    if page_width <= 0 || page_height <= 0 {
        return Err(anyhow!("tesseract_tsv_page_dimensions_missing"));
    }

    let blocks = groups
        .into_values()
        .filter_map(|group| {
            if group.words.is_empty() {
                return None;
            }
            let confidence = group.confidences.iter().sum::<f64>() / group.confidences.len() as f64;
            let x0 = group.left as f64 / page_width as f64;
            let x1 = group.right as f64 / page_width as f64;
            let y0 = 1.0 - group.bottom as f64 / page_height as f64;
            let y1 = 1.0 - group.top as f64 / page_height as f64;
            Some(OcrTextBlock {
                text: group.words.join(" "),
                bbox: NormalizedBBox::normalized(
                    x0.clamp(0.0, 1.0),
                    y0.clamp(0.0, 1.0),
                    x1.clamp(0.0, 1.0),
                    y1.clamp(0.0, 1.0),
                ),
                confidence,
            })
        })
        .collect::<Vec<_>>();
    let confidence_values = blocks
        .iter()
        .map(|block| block.confidence)
        .collect::<Vec<_>>();
    let mean_confidence = if confidence_values.is_empty() {
        0.0
    } else {
        confidence_values.iter().sum::<f64>() / confidence_values.len() as f64
    };
    Ok(OcrPage {
        blocks,
        mean_confidence,
    })
}

fn parse_i32(value: &str) -> Result<i32> {
    value
        .parse::<i32>()
        .map_err(|_| anyhow!("invalid_tesseract_tsv_integer:{value}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_words_into_paragraph_bbox() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
1\t1\t0\t0\t0\t0\t0\t0\t1000\t2000\t-1\t\n\
5\t1\t1\t1\t1\t1\t100\t200\t120\t40\t90.0\tDocuMind\n\
5\t1\t1\t1\t1\t2\t240\t200\t80\t40\t80.0\tOCR\n";
        let page = parse_tesseract_tsv(tsv).unwrap();

        assert_eq!(page.blocks.len(), 1);
        assert_eq!(page.blocks[0].text, "DocuMind OCR");
        assert_eq!(page.mean_confidence, 85.0);
        assert!((page.blocks[0].bbox.x0 - 0.1).abs() < 0.0001);
        assert!((page.blocks[0].bbox.y0 - 0.88).abs() < 0.0001);
    }
}

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// 原文锚点：解析阶段生成，用于引用定位与 FileView 高亮。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceAnchor {
    pub anchor_id: Uuid,
    pub doc_id: Uuid,
    pub parse_job_id: Uuid,
    pub tenant_id: Uuid,
    pub format: String,
    pub kind: String,
    pub page: Option<i32>,
    pub slide: Option<i32>,
    pub block_id: Option<Uuid>,
    pub table_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell_range: Option<CellRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub char_range: Option<CharRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bbox: Option<NormalizedBBox>,
    #[serde(default)]
    pub source_ref: Value,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_hash: Option<String>,
    #[serde(default)]
    pub anchor_quality: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellRange {
    pub row_start: i32,
    pub row_end: i32,
    pub col_start: i32,
    pub col_end: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharRange {
    pub start: i32,
    pub end: i32,
}

/// 归一化 bbox：x/y 在 [0,1] 之间，基于页面尺寸。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedBBox {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    #[serde(default = "default_unit")]
    pub unit: String,
    #[serde(default)]
    pub rotation: i32,
}

fn default_unit() -> String {
    "normalized".to_string()
}

impl NormalizedBBox {
    pub fn normalized(x0: f64, y0: f64, x1: f64, y1: f64) -> Self {
        Self {
            x0,
            y0,
            x1,
            y1,
            unit: "normalized".to_string(),
            rotation: 0,
        }
    }

    /// 把归一化坐标按给定页面宽高转成原始点坐标。
    pub fn to_points(&self, page_width: f64, page_height: f64) -> (f64, f64, f64, f64) {
        (
            self.x0 * page_width,
            self.y0 * page_height,
            self.x1 * page_width,
            self.y1 * page_height,
        )
    }
}

impl SourceAnchor {
    /// 从一段 PDF 文本生成一个段落级 anchor。
    ///
    /// `bbox` 只能传入解析器返回的真实坐标；仅知道页码时传 `None`，
    /// 避免把估算位置伪装成可用于高亮的精确坐标。
    pub fn for_pdf_paragraph(
        doc_id: Uuid,
        parse_job_id: Uuid,
        tenant_id: Uuid,
        block_id: Uuid,
        page: i32,
        text: &str,
        bbox: Option<NormalizedBBox>,
    ) -> Self {
        let anchor_quality = if bbox.is_some() { "bbox" } else { "page" };
        Self {
            anchor_id: Uuid::new_v4(),
            doc_id,
            parse_job_id,
            tenant_id,
            format: "pdf".to_string(),
            kind: "paragraph".to_string(),
            page: Some(page),
            slide: None,
            block_id: Some(block_id),
            table_id: None,
            cell_range: None,
            char_range: None,
            bbox,
            source_ref: serde_json::json!({"format": "pdf", "page": page}),
            text: text.to_string(),
            text_hash: Some(hex_hash(text)),
            anchor_quality: anchor_quality.to_string(),
        }
    }

    /// 为无 bbox 的格式生成 structural anchor。
    pub fn structural(
        doc_id: Uuid,
        parse_job_id: Uuid,
        tenant_id: Uuid,
        format: &str,
        kind: &str,
        block_id: Uuid,
        page: Option<i32>,
        slide: Option<i32>,
        source_ref: Value,
        text: &str,
    ) -> Self {
        Self {
            anchor_id: Uuid::new_v4(),
            doc_id,
            parse_job_id,
            tenant_id,
            format: format.to_string(),
            kind: kind.to_string(),
            page,
            slide,
            block_id: Some(block_id),
            table_id: None,
            cell_range: None,
            char_range: None,
            bbox: None,
            source_ref,
            text: text.to_string(),
            text_hash: Some(hex_hash(text)),
            anchor_quality: "structural".to_string(),
        }
    }

    /// 为表格的单元格范围生成 structural anchor。
    pub fn table_cell_range(
        doc_id: Uuid,
        parse_job_id: Uuid,
        tenant_id: Uuid,
        format: &str,
        block_id: Uuid,
        table_id: Uuid,
        page: Option<i32>,
        slide: Option<i32>,
        cell_range: CellRange,
        source_ref: Value,
        text: &str,
    ) -> Self {
        Self {
            anchor_id: Uuid::new_v4(),
            doc_id,
            parse_job_id,
            tenant_id,
            format: format.to_string(),
            kind: "table_cell_range".to_string(),
            page,
            slide,
            block_id: Some(block_id),
            table_id: Some(table_id),
            cell_range: Some(cell_range),
            char_range: None,
            bbox: None,
            source_ref,
            text: text.to_string(),
            text_hash: Some(hex_hash(text)),
            anchor_quality: "structural".to_string(),
        }
    }
}

fn hex_hash(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

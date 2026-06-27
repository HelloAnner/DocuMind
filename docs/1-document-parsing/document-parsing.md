# 文档解析 (Document Parsing)

把上传的 Word / PPT / PDF 文档解析为可追溯、可清洗、可切割、可检索的标准化结构，是 Ingest Pipeline 的第一阶段。

文档解析不只负责“抽文本”，还要保留原文结构、页码位置、表格形态、段落顺序和质量指标，更重要的是生成可回到原文的 `SourceAnchor`。下游的 Text Cleaning、Chunking、Embedding、Hybrid Search、Citation Resolver、FileView 都依赖这里产出的稳定结构与原文锚点。

## 核心职责

- **格式识别**：根据 MIME、扩展名、文件头三重校验识别 Word / PPT / PDF。
- **原始文件归档**：原文件进入对象存储或本地 blob 存储，PostgreSQL 只保存元数据和引用。
- **结构解析**：将文档解析为统一的 `ParsedDocument`，保留标题、段落、列表、表格、图片占位、页码、slide、坐标等信息。
- **原文锚点生成**：为每个可引用位置生成 `SourceAnchor`，包含 page/slide、block、table cell、bbox、char_range、source_ref 等定位信息。
- **准确性校验**：对页数、段落数、表格数、文本长度、异常字符比例、解析覆盖率、anchor 覆盖率进行质量评分。
- **结构化落库**：将解析快照、原文锚点、块级结构、表格全量数据、切片结果分层保存。
- **任务编排**：解析成功后进入 Text Cleaning；解析失败或低置信度进入重试 / 人工检查队列。

## 文档索引

- [解析框架与流程](parser-framework.md)
- [解析准确性保障](parsing-accuracy.md)
- [段落拆分与分块逻辑](block-and-chunking.md)
- [表格全量解析与保存](table-extraction-and-storage.md)
- [解析数据存储模型](storage-model.md)
- [原文锚点设计](../9-answer-generation/citation-location-preview.md)
- [工业落地注意事项](production-readiness.md)

## Pipeline 位置

```text
Upload
  -> Document Parsing
       -> SourceAnchor Generation
  -> Text Cleaning
       -> Offset Mapping
  -> Chunking
       -> ChunkAnchorMap
  -> Embedding
  -> Elasticsearch / PostgreSQL
  -> Preview Manifest
```

## 统一输出

解析阶段输出三类数据：

1. **结构化解析结果**：`ParsedDocument` JSON 快照，完整表达原始文档的逻辑结构。
2. **原文锚点**：`document_source_anchors`，为每个可引用位置生成 `SourceAnchor`，是后续引用定位与 FileView 高亮的权威依据。
3. **可检索块结构**：`document_blocks`，将标题、段落、列表项、表格、slide note 等拆成有顺序、有来源位置的块。

简化结构如下：

```json
{
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "file_type": "docx",
  "title": "2025 年度销售策略",
  "pages": 42,
  "blocks": [
    {
      "block_id": "uuid",
      "block_index": 12,
      "block_type": "paragraph",
      "heading_path": ["Q1 目标", "分地区策略"],
      "text": "华东区 Q1 销售目标为...",
      "page_start": 3,
      "page_end": 3,
      "source_ref": {
        "format": "docx",
        "xpath": "/w:document/w:body/w:p[12]"
      }
    }
  ],
  "tables": [
    {
      "table_id": "uuid",
      "block_id": "uuid",
      "page_start": 7,
      "headers": ["区域", "目标", "负责人"],
      "rows": [["华东", "1200 万", "张三"]]
    }
  ],
  "anchors": [
    {
      "anchor_id": "anchor_001",
      "format": "docx",
      "kind": "paragraph",
      "page": 3,
      "block_id": "uuid",
      "bbox": { "x0": 0.12, "y0": 0.21, "x1": 0.78, "y1": 0.26, "unit": "normalized" },
      "source_ref": { "format": "docx", "xpath": "/w:document/w:body/w:p[12]" }
    }
  ]
}
```

## 设计原则

- **结构优先**：优先保留标题层级、页码、slide、表格边界，再做文本清洗。
- **锚点为主线**：`SourceAnchor` 是解析、chunk、检索、引用、预览的共同契约，先于 chunk 生成。
- **原文可追溯**：每个 block 和 chunk 都能回溯到原文件、页码、slide、表格、段落或 XML 节点。
- **表格不压扁**：表格先完整保存为结构化数据，再按检索需要生成 table chunk；单元格应有自己的 anchor。
- **幂等可重跑**：同一文件内容 hash + 同一解析配置生成相同 parse version；重处理不污染旧版本。
- **低置信度显式暴露**：解析质量差时不悄悄进入检索，避免把错误内容变成答案依据。
- **清洗不破坏定位**：文本清洗只生成 `normalized_text`，原始 `text` 与 `anchor` 保持不变，通过 offset mapping 回溯源位置。

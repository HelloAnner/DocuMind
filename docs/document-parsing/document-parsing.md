# 文档解析 (Document Parsing)

把上传的 Word / PPT / PDF 文档解析为标准化文档结构，是 Ingest Pipeline 的第一阶段。

## 核心职责

- **PDF Parser**：提取文本、表格，过滤页眉页脚（`pdf-extract` / `lopdf`）
- **Word Parser**：解析 .docx（OpenXML），提取段落、标题层级、表格（`docx-rs`）
- **PPT Parser**：解析 .pptx，提取文本框、表格、备注，按 slide 分组

## 输出

统一的标准化 JSON 结构，包含标题、段落、表格、页码等层级信息，作为下游清洗和切割的输入。

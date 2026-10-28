# 表格全量解析与保存

表格是企业文档问答中最容易失真的内容。设计目标是：完整保存原表格结构，用适合检索的方式生成 chunk，用适合精确回答的方式回表读取。

## 表格解析目标

必须保存：

- 表格所在文档、页码、slide、标题路径。
- 表格标题或邻近说明文字。
- 表头、行、列、单元格文本。
- 合并单元格的 `rowspan` / `colspan`。
- 单元格坐标、样式、数据类型推断。
- 原始格式快照，包括 JSON、Markdown、CSV 可选导出。

不能只把表格压成纯文本，因为这样会丢失列含义、合并单元格和行列关系。

## 各格式表格解析

### Word 表格

Word 表格来自 `w:tbl`：

- `w:tr` 解析为 row。
- `w:tc` 解析为 cell。
- `w:gridSpan` 映射为 `colspan`。
- `w:vMerge` 映射为 `rowspan`。
- 单元格内段落按换行合并，同时保留 `cell_blocks`。

Word 表格结构最可靠，默认 `grid_confidence = 1.0`。

### PPT 表格

PPT 表格来自 `a:tbl`：

- `a:tr` 解析为 row。
- `a:tc` 解析为 cell。
- `gridSpan`、`rowSpan` 保存合并信息。
- 表格跟随 slide index 和 shape id。

PPT 表格也属于强结构表格，默认 `grid_confidence >= 0.95`。

### PDF 表格

PDF 表格需要从布局推断，分三类：

| 类型 | 识别方式 | 置信度 |
|---|---|---|
| 有边框表格 | 线段、矩形、文本坐标共同推断网格 | 高 |
| 无边框对齐表格 | 文本 x/y 对齐、列间距、行间距推断 | 中 |
| 类表格文本 | 制表符、连续空格、项目编号推断 | 低 |

PDF 表格处理流程：

1. 按页提取字符和坐标。
2. 检测水平线 / 垂直线 / 矩形。
3. 根据线段和文本 bbox 建立候选表格区域。
4. 根据 x 投影和 y 投影恢复列和行。
5. 将文本 cell 分配到网格。
6. 计算 `grid_confidence`。

低置信度 PDF 表格仍保存为 `raw_rows`，但不强行生成精确结构。

## 表格原始数据结构

解析后的表格快照示例：

```json
{
  "table_id": "uuid",
  "doc_id": "uuid",
  "block_id": "uuid",
  "table_index": 3,
  "title": "区域销售目标",
  "heading_path": ["年度策略", "Q2 目标"],
  "page_start": 7,
  "page_end": 7,
  "slide_index": null,
  "source_ref": {
    "format": "docx",
    "xpath": "/w:document/w:body/w:tbl[3]"
  },
  "headers": ["区域", "目标", "负责人"],
  "rows": [
    ["华东", "1200 万", "张三"],
    ["华南", "900 万", "李四"]
  ],
  "cells": [
    {
      "row_index": 0,
      "col_index": 0,
      "rowspan": 1,
      "colspan": 1,
      "text": "区域",
      "normalized_text": "区域",
      "is_header": true,
      "data_type": "text"
    }
  ],
  "quality": {
    "header_confidence": 0.98,
    "grid_confidence": 1.0,
    "empty_cell_ratio": 0.0,
    "warnings": []
  }
}
```

## 存储方式

表格采用双层存储：

1. `document_tables` 保存表级信息、完整 JSON 快照和可渲染文本。
2. `document_table_cells` 保存单元格级结构，支持精确回表、筛选、导出和后续表格问答增强。

### document_tables

```sql
CREATE TABLE document_tables (
  table_id UUID PRIMARY KEY,
  doc_id UUID NOT NULL,
  parse_job_id UUID NOT NULL,
  block_id UUID NOT NULL,
  table_index INT NOT NULL,
  title TEXT,
  heading_path TEXT[] NOT NULL DEFAULT '{}',
  page_start INT,
  page_end INT,
  slide_index INT,
  row_count INT NOT NULL,
  col_count INT NOT NULL,
  headers JSONB NOT NULL DEFAULT '[]',
  raw_json JSONB NOT NULL,
  markdown TEXT NOT NULL,
  csv_object_key TEXT,
  quality JSONB NOT NULL DEFAULT '{}',
  source_ref JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### document_table_cells

```sql
CREATE TABLE document_table_cells (
  cell_id UUID PRIMARY KEY,
  table_id UUID NOT NULL REFERENCES document_tables(table_id) ON DELETE CASCADE,
  row_index INT NOT NULL,
  col_index INT NOT NULL,
  rowspan INT NOT NULL DEFAULT 1,
  colspan INT NOT NULL DEFAULT 1,
  text TEXT NOT NULL DEFAULT '',
  normalized_text TEXT,
  is_header BOOLEAN NOT NULL DEFAULT false,
  data_type TEXT NOT NULL DEFAULT 'text',
  bbox JSONB,
  style JSONB NOT NULL DEFAULT '{}',
  source_ref JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_document_table_cells_table_pos
  ON document_table_cells(table_id, row_index, col_index);
```

## Markdown 与 CSV 派生物

每张表保存三份派生数据：

| 数据 | 用途 | 保存位置 |
|---|---|---|
| `raw_json` | 完整结构、回表读取 | PostgreSQL `document_tables.raw_json` |
| `markdown` | chunk 文本、LLM 上下文 | PostgreSQL `document_tables.markdown` |
| `csv` | 导出、人工检查、大表外置 | 对象存储，PG 保存 `csv_object_key` |

Markdown 用于检索和回答上下文，但不是权威数据源。权威数据源是 `raw_json` 和 `document_table_cells`。

## 表格 Chunk 策略

### 小表格

行数 ≤ 30 且 token ≤ 1200，整表一个 chunk：

```text
表格：区域销售目标
标题路径：年度策略 / Q2 目标
页码：7

| 区域 | 目标 | 负责人 |
|---|---:|---|
| 华东 | 1200 万 | 张三 |
| 华南 | 900 万 | 李四 |
```

### 中等表格

行数 31 到 300，按行窗口切分：

- 每个 chunk 都包含表标题、标题路径、页码、完整表头。
- 每个 chunk 包含 20 到 50 行。
- chunk metadata 记录 `row_range`。

### 超大表格

行数 > 300 或 token > 8000：

- 生成表格摘要 chunk：表名、列名、行数、关键统计。
- 行级数据不全部进入向量索引。
- 用户问到具体行时，根据检索命中的 `table_id` 回表查询。

## 表格回表读取

当检索命中 table chunk 后，Answer Generation 不只使用 chunk 文本，还可以根据 metadata 回表补充精确信息：

```json
{
  "chunk_id": "uuid",
  "source_type": "table",
  "table_id": "uuid",
  "row_range": [40, 80]
}
```

回表策略：

- 小表格：读取整张表。
- 中表格：读取命中 row window + 前后 3 行。
- 大表格：按问题关键词过滤相关列和行。

这样能避免大表格把上下文窗口占满，同时保留精确回答能力。

## 示例：最终保存形态

一张 Word 表格解析后会形成：

- `document_blocks` 一条 `table` block：负责文档顺序和引用锚点。
- `document_tables` 一条记录：负责表级结构和 JSON / Markdown 快照。
- `document_table_cells` 多条记录：负责每个单元格。
- `chunks` 一条或多条 `source_type = table` 的 chunk：负责检索。
- `chunk_tables` 关联记录：负责 chunk 与 table、row range 的关系。

这套结构保证“检索用文本”和“原始表格数据”分离，避免为了向量化牺牲表格完整性。

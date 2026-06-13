# 解析数据存储模型

本文档定义文档解析后的数据存在哪里、怎么存、各层数据的职责边界。

## 存储分层

| 层 | 数据 | 存储位置 | 用途 |
|---|---|---|---|
| 原始文件 | 用户上传的 docx / pptx / pdf | 对象存储或本地 blob 目录 | 重新解析、原文预览、审计 |
| 文档元数据 | 文件名、类型、大小、hash、状态 | PostgreSQL `documents` | 管理后台、权限、状态追踪 |
| 解析任务 | parser version、耗时、错误、质量分 | PostgreSQL `document_parse_jobs` | 重试、审计、版本管理 |
| 解析快照 | 完整 `ParsedDocument` JSON | PostgreSQL JSONB + 可选对象存储 | 调试、重跑清洗 / chunk |
| 块级结构 | heading / paragraph / table blocks | PostgreSQL `document_blocks` | 清洗、切割、引用定位 |
| 表格结构 | 表级和单元格级数据 | PostgreSQL `document_tables` / `document_table_cells` | 表格问答、导出、回表 |
| 切片 | chunk 文本和元数据 | PostgreSQL `chunks` | 检索结果展示、引用链 |
| 向量索引 | chunk embedding + BM25 文本 | Elasticsearch | 混合检索 |

## 原始文件保存

原始文件不直接保存到 PostgreSQL。推荐保存到对象存储：

```text
objects/
  tenants/{tenant_id}/knowledge-bases/{kb_id}/documents/{doc_id}/original/{file_sha256}.{ext}
```

`documents.storage_key` 保存对象路径。

如果第一版不接对象存储，也可以使用本地 blob 目录，但表结构保持 `storage_key` 抽象，后续迁移不影响业务表。

## documents

```sql
CREATE TABLE documents (
  doc_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  kb_id UUID NOT NULL,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  file_sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  parse_status TEXT NOT NULL DEFAULT 'uploaded',
  parse_version INT NOT NULL DEFAULT 0,
  latest_parse_job_id UUID,
  chunk_count INT NOT NULL DEFAULT 0,
  table_count INT NOT NULL DEFAULT 0,
  page_count INT,
  uploaded_by UUID,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_documents_kb_status
  ON documents(kb_id, parse_status);
```

## document_parse_jobs

```sql
CREATE TABLE document_parse_jobs (
  parse_job_id UUID PRIMARY KEY,
  doc_id UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  parser_version TEXT NOT NULL,
  parser_config JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  quality_score NUMERIC(4, 3),
  page_count INT,
  block_count INT,
  table_count INT,
  char_count INT,
  warnings JSONB NOT NULL DEFAULT '[]',
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_parse_jobs_doc
  ON document_parse_jobs(doc_id, created_at DESC);
```

一个文档可以有多个 parse job。`documents.latest_parse_job_id` 指向当前生效版本。

## document_parse_results

保存完整 `ParsedDocument` 快照。

```sql
CREATE TABLE document_parse_results (
  parse_job_id UUID PRIMARY KEY REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
  doc_id UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  parsed_json JSONB NOT NULL,
  parsed_json_object_key TEXT,
  schema_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

小到中等文档可直接存 JSONB；超大文档可把完整 JSON 放对象存储，PG 中仍保存精简索引字段和 `parsed_json_object_key`。

## document_blocks

```sql
CREATE TABLE document_blocks (
  block_id UUID PRIMARY KEY,
  doc_id UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  parse_job_id UUID NOT NULL REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
  block_index INT NOT NULL,
  block_type TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  normalized_text TEXT,
  heading_level INT,
  heading_path TEXT[] NOT NULL DEFAULT '{}',
  page_start INT,
  page_end INT,
  slide_index INT,
  table_id UUID,
  bbox JSONB,
  source_ref JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(parse_job_id, block_index)
);

CREATE INDEX idx_document_blocks_doc_order
  ON document_blocks(doc_id, parse_job_id, block_index);

CREATE INDEX idx_document_blocks_type
  ON document_blocks(doc_id, block_type);
```

`text` 是解析原文，`normalized_text` 是清洗后文本。若采用独立 `cleaned_blocks` 表，也可以不在此处写 `normalized_text`，但第一版放在同表能降低查询复杂度。

## chunks

```sql
CREATE TABLE chunks (
  chunk_id UUID PRIMARY KEY,
  doc_id UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  kb_id UUID NOT NULL,
  parse_job_id UUID NOT NULL REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  source_type TEXT NOT NULL,
  content TEXT NOT NULL,
  heading_path TEXT[] NOT NULL DEFAULT '{}',
  page_start INT,
  page_end INT,
  slide_start INT,
  slide_end INT,
  token_count INT NOT NULL,
  block_ids UUID[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(parse_job_id, chunk_index)
);

CREATE INDEX idx_chunks_doc_order
  ON chunks(doc_id, parse_job_id, chunk_index);

CREATE INDEX idx_chunks_kb_source
  ON chunks(kb_id, source_type);
```

chunk 内容进入 Elasticsearch；PostgreSQL 保留权威元数据、引用链和管理后台预览所需内容。

## chunk_tables

表格 chunk 与表格原始数据通过关联表连接。

```sql
CREATE TABLE chunk_tables (
  chunk_id UUID NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES document_tables(table_id) ON DELETE CASCADE,
  row_start INT,
  row_end INT,
  col_start INT,
  col_end INT,
  PRIMARY KEY (chunk_id, table_id)
);
```

这样一个大表格可以对应多个 chunk，一个 chunk 也可以包含表格说明文字和表格片段。

## Elasticsearch chunks 索引

Elasticsearch 保存检索需要的数据：

```json
{
  "chunk_id": "uuid",
  "doc_id": "uuid",
  "kb_id": "uuid",
  "tenant_id": "uuid",
  "content": "标题路径：年度策略 / Q1 目标\n...",
  "heading_path": ["年度策略", "Q1 目标"],
  "page_start": 3,
  "page_end": 4,
  "source_type": "paragraph",
  "token_count": 612,
  "table_ids": [],
  "embedding": [0.012, -0.034]
}
```

ES 不是权威存储，可以随时从 PostgreSQL 的 chunks 表和 embedding worker 重建。

## 版本与幂等

解析版本由以下字段决定：

```text
parse_identity = sha256(file_sha256 + parser_version + parser_config)
```

若同一 `parse_identity` 已成功完成，重复上传或重试可以直接复用结果。若 parser version 或 config 变化，则生成新的 parse job 和新的 chunks。

旧版本清理策略：

- 默认保留最近 2 个成功 parse job。
- 删除文档时级联删除 parse results、blocks、tables、chunks、ES 索引。
- 重新解析成功后，`documents.latest_parse_job_id` 切换到新版本，再异步清理旧 ES 索引。

## 解析后数据示例

一份 `2025年度销售策略.pptx` 上传后，最终数据分布如下：

```text
documents
  doc_id = doc_001
  storage_key = tenants/t1/knowledge-bases/kb1/documents/doc_001/original/sha.pptx
  parse_status = indexed
  latest_parse_job_id = job_001
  chunk_count = 47
  table_count = 3

document_parse_jobs
  parse_job_id = job_001
  parser_version = documind-parser@0.1.0
  quality_score = 0.94

document_blocks
  block 1: heading, slide 1, "年度销售策略"
  block 2: paragraph, slide 1, "本策略覆盖..."
  block 9: table, slide 3, table_id = tbl_001

document_tables
  tbl_001: raw_json + markdown + quality

document_table_cells
  tbl_001 row 0 col 0 = "区域"
  tbl_001 row 1 col 0 = "华东"

chunks
  chunk_001: paragraph chunk, block_ids = [block_1, block_2]
  chunk_006: table chunk, table_ids = [tbl_001]

Elasticsearch
  chunk_001 embedding + BM25 content
  chunk_006 embedding + BM25 table markdown
```

用户回答引用时的链路：

```text
answer citation
  -> chunk_id
  -> chunks.block_ids / chunk_tables.table_id
  -> document_blocks.source_ref / document_tables.source_ref
  -> documents.storage_key
  -> 原文页码、slide 或 bbox
```

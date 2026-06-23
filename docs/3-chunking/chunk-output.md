# Chunk 输出数据形态

本文档用具体示例说明：文档经过 Document Parsing、Text Cleaning、Chunking 之后，最终落到数据库和搜索引擎里的 chunk 长什么样。

## 示例原文

下面是一份 Markdown 原始内容：

```markdown
# 年度策略

## Q1 目标

华东区 Q1 销售目标为 1200 万元。重点客户包括 A、B、C。

华南区 Q1 销售目标为 900 万元。

## Q2 目标

| 区域 | 目标 |
|---|---|
| 华东 | 1300 万 |
| 华南 | 1000 万 |

Q2 重点关注客户留存。
```

经过解析、清洗、切分后，会生成 3 个 chunk：

| chunk_index | source_type | heading_path | 内容概要 |
|---|---|---|---|
| 0 | paragraph | [年度策略, Q1 目标] | 华东区 + 华南区目标 |
| 1 | table | [年度策略, Q2 目标] | 区域销售目标表 |
| 2 | paragraph | [年度策略, Q2 目标] | Q2 重点关注客户留存 |

## PostgreSQL `chunks` 表

权威元数据保存在 PostgreSQL 的 `chunks` 表：

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
```

查询结果：

```sql
SELECT chunk_id, chunk_index, source_type, heading_path, token_count
FROM chunks
WHERE doc_id = 'doc_001'
ORDER BY chunk_index;
```

| chunk_id | chunk_index | source_type | heading_path | token_count |
|---|---|---|---|---|
| chunk_001 | 0 | paragraph | {年度策略,Q1 目标} | 45 |
| chunk_002 | 1 | table | {年度策略,Q2 目标} | 28 |
| chunk_003 | 2 | paragraph | {年度策略,Q2 目标} | 12 |

## 段落型 chunk 示例

```json
{
  "chunk_id": "chunk_001",
  "doc_id": "doc_001",
  "kb_id": "kb_001",
  "parse_job_id": "job_001",
  "chunk_index": 0,
  "source_type": "paragraph",
  "content": "标题路径：年度策略 / Q1 目标\n\n华东区 Q1 销售目标为 1200 万元。重点客户包括 A、B、C。\n华南区 Q1 销售目标为 900 万元。",
  "heading_path": ["年度策略", "Q1 目标"],
  "page_start": 1,
  "page_end": 1,
  "slide_start": null,
  "slide_end": null,
  "token_count": 45,
  "block_ids": ["blk_002", "blk_003"],
  "table_ids": [],
  "overlap_prev_block_ids": [],
  "overlap_next_block_ids": ["blk_004"],
  "metadata": {
    "format": "markdown",
    "split_reason": "target_chunk_tokens",
    "overlap_tokens": 0
  }
}
```

## 表格型 chunk 示例

```json
{
  "chunk_id": "chunk_002",
  "doc_id": "doc_001",
  "kb_id": "kb_001",
  "parse_job_id": "job_001",
  "chunk_index": 1,
  "source_type": "table",
  "content": "标题路径：年度策略 / Q2 目标\n表格：区域销售目标\n\n| 区域 | 目标 |\n|---|---|\n| 华东 | 1300 万 |\n| 华南 | 1000 万 |",
  "heading_path": ["年度策略", "Q2 目标"],
  "page_start": 1,
  "page_end": 1,
  "token_count": 28,
  "block_ids": ["blk_005"],
  "table_ids": ["tbl_001"],
  "overlap_prev_block_ids": ["blk_003"],
  "overlap_next_block_ids": ["blk_006"],
  "metadata": {
    "format": "markdown",
    "table_row_range": [0, 2]
  }
}
```

## `chunk_tables` 关联表

表格 chunk 与表格原始数据通过 `chunk_tables` 关联：

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

示例记录：

```json
{
  "chunk_id": "chunk_002",
  "table_id": "tbl_001",
  "row_start": 0,
  "row_end": 2,
  "col_start": 0,
  "col_end": 1
}
```

## Elasticsearch 索引中的形态

Elasticsearch 保存用于检索的文本、元数据和向量：

```json
{
  "chunk_id": "chunk_002",
  "doc_id": "doc_001",
  "kb_id": "kb_001",
  "tenant_id": "tenant_001",
  "content": "标题路径：年度策略 / Q2 目标\n表格：区域销售目标\n\n| 区域 | 目标 |\n|---|---|\n| 华东 | 1300 万 |\n| 华南 | 1000 万 |",
  "heading_path": ["年度策略", "Q2 目标"],
  "page_start": 1,
  "page_end": 1,
  "source_type": "table",
  "token_count": 28,
  "table_ids": ["tbl_001"],
  "embedding": [0.012, -0.034, 0.089]
}
```

> ES 不是权威存储，可以随时从 PostgreSQL 的 `chunks` 表和 embedding worker 重建。

## 字段含义速查

| 字段 | 类型 | 说明 |
|---|---|---|
| `chunk_id` | UUID | chunk 主键 |
| `doc_id` | UUID | 所属文档 |
| `kb_id` | UUID | 所属知识库 |
| `parse_job_id` | UUID | 解析版本，用于版本回溯 |
| `chunk_index` | INT | 文档内顺序 |
| `source_type` | TEXT | `paragraph` / `table` / `slide_note` / `footnote` / `code` / `metadata` |
| `content` | TEXT | 用于检索和 LLM 上下文的文本 |
| `heading_path` | TEXT[] | 标题层级路径，回答时提供上下文 |
| `page_start` / `page_end` | INT | 原文页码范围 |
| `slide_start` / `slide_end` | INT | PPT slide 范围 |
| `token_count` | INT | `content` 的 token 数 |
| `block_ids` | UUID[] | 关联的 `document_blocks` |
| `table_ids` | UUID[] | 关联的 `document_tables` |
| `overlap_prev_block_ids` | UUID[] | 上一 chunk 末尾 overlap block |
| `overlap_next_block_ids` | UUID[] | 下一 chunk 开头 overlap block |
| `metadata` | JSONB | 扩展字段：切分原因、行范围、格式等 |

## 回答引用链

用户得到答案时，系统通过以下链路回到原文：

```text
answer citation
  -> chunk_id
  -> chunks.block_ids / chunk_tables.table_id
  -> document_blocks.source_ref / document_tables.source_ref
  -> documents.storage_key
  -> 原文页码、slide 或 bbox
```

例如：

1. 检索命中 `chunk_002`。
2. 通过 `chunk_002.table_ids = [tbl_001]` 找到完整表格。
3. 通过 `document_tables.source_ref` 回到原 Markdown 表格位置。
4. 通过 `documents.storage_key` 打开原始文件。

## 一句话总结

Chunking 之后，文档变成一组**带标题路径、带引用链、带向量的文本片段**：PostgreSQL 保存权威结构和关系，Elasticsearch 保存可检索的文本与向量。

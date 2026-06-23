# 智能切割 (Chunking)

Chunking 是 Ingest Pipeline 的第三阶段：输入来自 Text Cleaning 的 `cleaned_blocks`，输出是可检索的 `chunks`。核心矛盾是“切太碎丢失上下文、切太粗检索不准”。本文档定义所有格式共享的切分算法、参数、元数据和边界规则；Markdown、Word、PDF、PPT 的格式差异见各专题文档。

## Pipeline 位置

```text
Upload
  -> Document Parsing        (产出 document_blocks)
  -> Text Cleaning           (产出 cleaned_blocks)
  -> Chunking                (产出 chunks)
  -> Embedding
  -> Elasticsearch / PostgreSQL
```

## 设计目标

- **语义完整**：同一主题、同一段落、同一表格不被人为割裂。
- **检索粒度适中**：单个 chunk 既能被问题精准命中，又不会把无关内容带进来。
- **可追溯**：任意 chunk 都能回到原始文件、页码/slide、block、table。
- **可配置**：chunk 大小、overlap、边界策略可通过 `parser_config` / `chunker_config` 调整。

## 统一切分算法

### 输入：CleanedBlock

```json
{
  "block_id": "uuid",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "block_index": 12,
  "block_type": "paragraph",
  "text": "华东区 Q1 销售目标为 1200 万元。",
  "normalized_text": "华东区 Q1 销售目标为 1200 万元。",
  "heading_level": null,
  "heading_path": ["年度策略", "区域计划"],
  "page_start": 3,
  "page_end": 3,
  "slide_index": null,
  "table_id": null,
  "bbox": null,
  "source_ref": {
    "format": "docx",
    "xpath": "/w:document/w:body/w:p[12]"
  },
  "metadata": {
    "style": "Normal",
    "language": "zh-CN"
  }
}
```

### 输出：Chunk

```json
{
  "chunk_id": "uuid",
  "doc_id": "uuid",
  "kb_id": "uuid",
  "parse_job_id": "uuid",
  "chunk_index": 18,
  "source_type": "paragraph",
  "content": "标题路径：年度策略 / 区域计划\n页码：3\n\n华东区 Q1 销售目标为 1200 万元。重点客户包括...",
  "heading_path": ["年度策略", "区域计划"],
  "page_start": 3,
  "page_end": 3,
  "slide_start": null,
  "slide_end": null,
  "token_count": 612,
  "block_ids": ["uuid-1", "uuid-2"],
  "table_ids": [],
  "overlap_prev_block_ids": ["uuid-0"],
  "overlap_next_block_ids": ["uuid-3"],
  "metadata": {
    "split_reason": "target_chunk_tokens",
    "overlap_tokens": 120
  }
}
```

### 三阶段切分策略

1. **结构感知分组**：按硬边界把 `cleaned_blocks` 分成若干候选组。
2. **组内切分 / 子切分兜底**：把超过 `max_chunk_tokens` 的组继续切分；超长单 block 按段落/句子/token 递归切分。
3. **Overlap 补全**：在相邻 chunk 之间补充上下文，比例 15% ~ 20%。

### 核心伪代码

```rust
fn chunk(cleaned_blocks: Vec<CleanedBlock>, cfg: ChunkConfig) -> Vec<Chunk> {
    let mut groups: Vec<BlockGroup> = vec![];
    let mut cur = BlockGroup::new();

    for b in cleaned_blocks {
        // 硬边界：直接结束当前组，并单独处理特殊 block
        if is_hard_boundary(&b, &cur) {
            if !cur.is_empty() { groups.push(cur); }
            cur = BlockGroup::new();
            if b.block_type == "table" {
                groups.extend(table_chunks(&b, &cfg));
                continue;
            }
        }
        // 软边界：组内 token 超过目标时先尝试结束
        let tk = token_count(&b.normalized_text);
        if cur.tokens + tk > cfg.target_chunk_tokens && !cur.is_empty() {
            groups.push(cur);
            cur = BlockGroup::new();
        }
        cur.push(b, tk);
    }
    if !cur.is_empty() { groups.push(cur); }

    // 子切分兜底
    let mut chunks: Vec<Chunk> = vec![];
    for g in groups {
        chunks.extend(split_group(g, &cfg));
    }

    // Overlap 补全
    add_overlap(&mut chunks, &cfg);

    // 索引重排与元数据补全
    for (i, c) in chunks.iter_mut().enumerate() {
        c.chunk_index = i;
    }
    chunks
}
```

### 硬边界（Hard Boundary）

必须保持的硬边界：

- 不跨文档。
- 不跨 H1 章节。
- 不把表格拆进普通段落 chunk（表格单独成 table chunk）。
- 不跨 PPT slide（slide note 除外）。
- Markdown 代码块、frontmatter、独立表格不与其他类型混排。
- PDF 不跨列；低置信度表格不当作强结构表格 chunk。

### 软边界（Soft Boundary）

允许合并的软边界：

- 同一 H2 / H3 下的多个短段。
- 连续列表项。
- 标题与其后的第一段正文。
- 表格标题说明文字 + 表格 block。

## Token 计算

### Tokenizer 配置

```json
{
  "tokenizer": {
    "provider": "tiktoken",
    "model": "cl100k_base"
  },
  "fallback": "char_count_over_4"
}
```

- 默认使用 `tiktoken` 的 `cl100k_base`（与 OpenAI 系列嵌入/生成模型一致）。
- 若 tokenizer 不可用，回退到 `ceil(unicode_char_count / 4)`，中文按字计数。
- token 数在 block 级预计算并缓存，避免重复 tokenize。

### 参数定义

| 参数 | 默认值 | 说明 |
|---|---|---|
| `target_chunk_tokens` | 800 | 单个 chunk 的目标 token 数 |
| `max_chunk_tokens` | 1500 | 单个 chunk 的硬性上限 |
| `hard_split_tokens` | 2000 | 超过此值必须强制切分，即使破坏句子 |
| `min_chunk_tokens` | 200 | 低于此值可与相邻块合并 |
| `overlap_tokens` | 200 | 相邻 chunk 之间 overlap 的最大 token 数 |
| `overlap_ratio` | 15% ~ 20% | 以当前 chunk 主内容 token 数为基准 |
| `max_table_rows_per_chunk` | 50 | 中等表格按行窗口切分时每块最大行数 |
| `max_table_token_per_chunk` | 1200 | 表格 chunk 最大 token 数 |

## 子切分兜底

当单个 block 或一个 block group 超过 `max_chunk_tokens` 时，按以下优先级切分：

1. **block 边界**：若组内含多个 block，优先按 block 拆分。
2. **段落边界**：按 `\n\n` 拆分。
3. **句子边界**：按句号、问号、叹号、分号等切分，中文避免把数字/缩写切开。
4. **短语/逗号边界**：按逗号、顿号切分。
5. **token 边界**：当长度超过 `hard_split_tokens` 时，强制按 token 切分。

切分后每个片段仍保留完整标题路径、页码/slide、source_ref 链。

## Overlap 策略

Overlap 用于让相邻 chunk 共享部分上下文，提高检索召回率。

### 实现方式

- 在 `content` 头部追加上一 chunk 末尾最多 `overlap_tokens / 2` 的文本，前缀标记为 `【上文】`。
- 在 `content` 尾部追加下一 chunk 开头最多 `overlap_tokens / 2` 的文本，后缀标记为 `【下文】`。
- 同时将相邻 block ID 写入 `overlap_prev_block_ids` / `overlap_next_block_ids`。
- 若跨 H1、跨表格、跨 slide、跨代码块，则不再追加 overlap。

### 示例

```text
【上文】Q1 目标为 1200 万元。

标题路径：年度策略 / 区域计划
页码：3

华东区 Q1 销售目标为 1200 万元。重点客户包括 A、B、C。

【下文】华南区目标为 900 万元。
```

## 表格 Chunk 通用策略

表格在 `document_tables` 中完整保存；Chunking 阶段按需生成 table chunk。

| 表格大小 | 判定条件 | Chunk 策略 |
|---|---|---|
| 小表格 | 行数 ≤ 30 且 token ≤ `max_table_token_per_chunk` | 整表一个 chunk |
| 中等表格 | 行数 31 ~ 300 | 表头 + 行窗口，每个 chunk 20 ~ 50 行 |
| 超大表格 | 行数 > 300 或 token > 8000 | 表格摘要 chunk + 行级查询回表 |

详见 [表格全量解析与保存](../1-document-parsing/table-extraction-and-storage.md)。

## Chunk 元数据字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `chunk_id` | UUID | 主键 |
| `doc_id` | UUID | 所属文档 |
| `kb_id` | UUID | 所属知识库 |
| `parse_job_id` | UUID | 解析版本 |
| `chunk_index` | INT | 文档内顺序 |
| `source_type` | TEXT | `paragraph` / `table` / `slide_note` / `footnote` / `code` / `metadata` |
| `content` | TEXT | 用于检索和 LLM 的文本 |
| `heading_path` | TEXT[] | 标题层级路径 |
| `page_start` / `page_end` | INT | 页码范围 |
| `slide_start` / `slide_end` | INT | slide 范围（PPT） |
| `token_count` | INT | content 的 token 数 |
| `block_ids` | UUID[] | 包含的 block |
| `table_ids` | UUID[] | 关联的 table |
| `overlap_prev_block_ids` | UUID[] | 上文 overlap block |
| `overlap_next_block_ids` | UUID[] | 下文 overlap block |
| `metadata` | JSONB | 扩展字段：切分原因、语言、quality 等 |

## 格式专题文档

- [Markdown Chunking 详细设计](markdown-chunking.md)
- [Word Chunking 详细设计](word-chunking.md)
- [PDF Chunking 详细设计](pdf-chunking.md)
- [PPT Chunking 详细设计](ppt-chunking.md)
- [Chunk 输出数据形态](chunk-output.md)

## 质量与可观测性

### 关键指标

| 指标 | 目标 | 说明 |
|---|---|---|
| `chunk_count_per_doc` | 可预期 | 用于检测切分策略漂移 |
| `avg_chunk_tokens` | 接近 `target_chunk_tokens` | 过高/过低都需告警 |
| `max_chunk_tokens` | ≤ `max_chunk_tokens` | 硬性约束 |
| `empty_chunk_rate` | 0 | 空内容或仅标题的 chunk 必须被过滤 |
| `chunk_hard_split_rate` | < 5% | 触发 `hard_split_tokens` 强制切分的比例 |

### 日志字段

```json
{
  "event": "document_chunked",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "chunk_count": 47,
  "avg_tokens": 780,
  "max_tokens": 1420,
  "table_chunk_count": 3,
  "duration_ms": 234,
  "chunker_version": "documind-chunker@0.1.0"
}
```

## 版本与幂等

Chunking 版本由以下字段决定：

```text
chunk_identity = sha256(parse_identity + chunker_version + chunker_config)
```

- `chunker_version` 变更会触发重新 chunk。
- 旧 chunk 在新 chunk 写入并校验成功后切换 `documents.latest_parse_job_id`，再异步清理旧 ES 索引。

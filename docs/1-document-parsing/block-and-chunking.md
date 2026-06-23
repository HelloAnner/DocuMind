# 段落拆分与分块逻辑

本文档定义解析后的段落拆分、block 规范化，以及进入 Chunking 阶段前后的边界规则。

## 数据层级

```text
Original File
  -> ParsedDocument
  -> document_blocks
  -> cleaned_blocks
  -> chunks
  -> embeddings
```

解析阶段只产出 `document_blocks`，不直接产出最终 chunk。最终 chunk 由 Chunking 阶段生成，但分块边界依赖解析阶段的结构信息。

## Block 类型

| 类型 | 来源 | 是否进入检索 |
|---|---|---|
| `heading` | Word 标题、PPT 标题、PDF 推断标题 | 是，作为上下文前缀 |
| `paragraph` | 普通正文 | 是 |
| `list_item` | 编号 / 项目符号 | 是 |
| `table` | 表格占位 block | 是，但正文来自 table render |
| `slide_note` | PPT 备注 | 可配置，默认是 |
| `footnote` | Word 脚注 | 可配置，默认是 |
| `header_footer` | 页眉页脚候选 | 默认否 |
| `image_placeholder` | 图片或图表占位 | 默认否，后续可接 OCR / caption |

## 段落拆分规则

### Word

Word 以 `w:p` 作为天然段落边界。以下情况会合并：

- 连续 `w:p` 属于同一个列表项的多行延续。
- 同一段落被多个 run 拆开，但没有实际换段。
- 软换行 `<w:br/>` 保留为段内换行，不拆新段。

以下情况不合并：

- 标题和标题后的正文。
- 列表项之间。
- 表格前后正文。
- 页眉页脚与正文。

### PPT

PPT 以 slide 内 shape 为第一层边界，以 shape 内段落为第二层边界。

拆分规则：

- 标题 shape 生成独立 `heading`。
- 同一文本框内的多条 bullet 生成多个 `list_item`。
- 同一文本框内的普通短段可合并为一个 `paragraph`。
- 不同 shape 不跨 shape 合并，避免破坏版式语义。
- speaker notes 按备注段落拆为 `slide_note`。

### PDF

PDF 先从字符坐标恢复行，再从行恢复段落：

1. 同一行字符按 x 坐标合并。
2. 行间距小于正文行高 1.5 倍时归为同一段。
3. 行尾没有句末符号且下一行缩进一致时合并硬换行。
4. 行间距大、缩进变化大、字号变化大时拆段。
5. 表格候选区域内的文本不进入普通段落合并。

中文 PDF 的硬换行合并需要避免把列表和标题粘在一起。含编号前缀的行优先识别为 `list_item`。

## Heading Path 维护

解析时维护标题栈：

```text
H1 年度策略
  H2 Q1 目标
    paragraph -> heading_path = ["年度策略", "Q1 目标"]
  H2 Q2 目标
    table -> heading_path = ["年度策略", "Q2 目标"]
```

标题栈规则：

- 新标题 level 小于等于当前 level 时，弹出同级和更深层级标题。
- PDF 推断标题若置信度低于 0.7，不进入标题栈，只作为普通短段。
- PPT 每个 slide 的标题作为 slide 内默认 heading path。

## Cleaned Block

Text Cleaning 阶段在 `document_blocks` 基础上生成 `cleaned_blocks`：

```json
{
  "block_id": "uuid",
  "cleaned_text": "华东区 Q1 销售目标为 1200 万元。",
  "is_removed": false,
  "remove_reason": null,
  "cleaning_ops": ["normalize_space", "merge_pdf_line_break"]
}
```

原始 `text` 不覆盖，清洗结果单独保存，便于追溯和重新清洗。

## Chunk 生成策略

最终 chunk 由 `cleaned_blocks` 生成，遵循三级切割：

1. **结构感知切分**：按标题、小节、slide、表格边界切分。
2. **语义补全**：给 chunk 增加前后相邻 block 摘要或短 overlap。
3. **子切分兜底**：超长内容按段落、句子、token 递归切分。

默认参数：

| 参数 | 默认值 |
|---|---|
| `target_chunk_tokens` | 800 |
| `max_chunk_tokens` | 1500 |
| `hard_split_tokens` | 2000 |
| `overlap_tokens` | 200 |
| `overlap_ratio` | 15% 到 20% |

## Chunk 边界规则

必须保持的硬边界：

- 不跨文档。
- 不跨章节 H1。
- 不把表格拆进普通段落 chunk。
- 不跨 PPT slide，除非是 slide note 的连续摘要策略。
- 不把低置信度 PDF 表格当成强结构表格 chunk。

允许合并的软边界：

- 同一 H2 下多个短段。
- 连续列表项。
- 标题 + 标题下第一段正文。
- 表格标题说明 + 表格占位 block。

## Chunk 内容格式

段落 chunk：

```text
标题路径：年度策略 / Q1 目标
页码：3

华东区 Q1 销售目标为 1200 万元。重点客户包括...
```

表格 chunk：

```text
标题路径：年度策略 / Q2 目标
页码：7
表格：区域销售目标

| 区域 | 目标 | 负责人 |
|---|---:|---|
| 华东 | 1200 万 | 张三 |
| 华南 | 900 万 | 李四 |
```

chunk 中可以包含渲染后的 Markdown 表格，但完整表格数据以 `table_id` 回表读取，不依赖 chunk 文本保存全量结构。

## Chunk Metadata

```json
{
  "chunk_id": "uuid",
  "doc_id": "uuid",
  "kb_id": "uuid",
  "parse_job_id": "uuid",
  "chunk_index": 18,
  "source_type": "paragraph",
  "content": "标题路径：年度策略 / Q1 目标\n页码：3\n\n华东区...",
  "heading_path": ["年度策略", "Q1 目标"],
  "page_range": [3, 3],
  "slide_range": null,
  "block_ids": ["uuid-1", "uuid-2"],
  "table_ids": [],
  "token_count": 612,
  "overlap_prev_block_ids": ["uuid-0"],
  "overlap_next_block_ids": ["uuid-3"]
}
```

## 长文档处理

长文档不一次性把全文载入 LLM 或向量化模型。处理方式：

- 解析结果按 block 流式写入。
- chunk 生成按章节批处理。
- embedding worker 按 chunk batch 消费。
- document 记录 `chunk_count`、`parse_version`、`indexed_at`，支持断点续跑。

## 与表格的关系

表格在 block 层只占一个 `table` block。Chunking 阶段根据表格大小生成三类内容：

| 表格大小 | Chunk 策略 |
|---|---|
| 小表格 | 整表生成一个 table chunk |
| 中等表格 | 表头 + 分组行窗口，多个 table chunk |
| 超大表格 | 只生成表格摘要 chunk，行级查询回表读取 |

无论生成多少 table chunk，完整表格始终只保存在 `document_tables` / `document_table_cells` 中。

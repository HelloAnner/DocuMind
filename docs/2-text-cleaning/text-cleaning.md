# 文本清洗 (Text Cleaning)

文本清洗是 Ingest Pipeline 的第二阶段：输入来自 Document Parsing 的 `document_blocks`，输出为 `cleaned_blocks`。目标是在保留原文结构和语义的前提下，去除噪声、规范化表达，让下游 Chunking 和 Embedding 获得稳定、可检索的文本。

## Pipeline 位置

```text
Upload
  -> Document Parsing        (产出 document_blocks)
  -> Text Cleaning           (产出 cleaned_blocks)
  -> Chunking                (产出 chunks)
  -> Embedding
  -> Elasticsearch / PostgreSQL
```

## 核心职责

- **去除版式噪声**：页眉页脚、页码、水印、重复模板元素、HTML 脚本样式等。
- **合并 PDF/Word 常见硬换行**：在保留段落边界的前提下，把因版式产生的断行恢复为连续段落。
- **规范化空白字符**：统一换行符、统一空格、去除行尾空格、压缩连续空行。
- **去除控制字符与零宽字符**：BOM、零宽空格、对象替换符等。
- **Unicode 规范化**：统一字符表示形式（NFC）。
- **保留结构化标记**：标题、列表、代码块、表格、引用等语义边界不被破坏。
- **可追溯**：原始 `text` 不覆盖，清洗结果和清洗操作单独保存。

## 输入输出

### 输入：document_blocks

```json
{
  "block_id": "uuid",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "block_index": 12,
  "block_type": "paragraph",
  "text": "华东区 Q1 销售目标为 1200 万元。",
  "heading_path": ["年度策略", "Q1 目标"],
  "page_start": 3,
  "page_end": 3,
  "source_ref": {
    "format": "docx",
    "xpath": "/w:document/w:body/w:p[12]"
  }
}
```

### 输出：cleaned_blocks

```json
{
  "block_id": "uuid",
  "cleaned_text": "华东区 Q1 销售目标为 1200 万元。",
  "is_removed": false,
  "remove_reason": null,
  "cleaning_ops": ["normalize_space", "trim"]
}
```

清洗后的 block 保持与原始 block 相同的 `block_id`、`block_index`、`heading_path` 和 `source_ref`，仅对 `text` 做规范化处理。

## 通用清洗规则

所有格式共享的清洗规则：

1. **去除 BOM**：删除 UTF-8 BOM。
2. **统一换行符**：`\r\n`、`\r` 统一为 `\n`。
3. **统一空格**：全角空格、不间断空格、零宽空格统一为半角空格。
4. **去除控制字符**：除 `\n`、`\t` 外，删除 C0 控制字符和零宽字符。
5. **Unicode 规范化**：默认 NFC。
6. **压缩连续空行**：三个及以上连续换行压缩为两个。
7. **去除纯噪声 block**：空白 block、HTML 注释、script/style 块等。

## 格式专题文档

不同格式的清洗策略差异较大，按格式分别设计：

- [Markdown Text Cleaning 详细设计](markdown-text-cleaning.md)
- [Word Text Cleaning 详细设计](word-text-cleaning.md)
- [PDF Text Cleaning 详细设计](pdf-text-cleaning.md)
- [PPT Text Cleaning 详细设计](ppt-text-cleaning.md)

## 清洗操作记录

每条 `cleaned_blocks` 记录应保存 `cleaning_ops`，便于追溯和重新清洗：

| 操作 | 说明 |
|---|---|
| `remove_bom` | 去除 UTF-8 BOM |
| `normalize_line_endings` | 统一换行符 |
| `normalize_space` | 统一空格、压缩连续空格 |
| `remove_control_chars` | 删除控制/零宽字符 |
| `unicode_nfc` | Unicode NFC 规范化 |
| `trim` | 去除首尾空白 |
| `merge_pdf_line_break` | 合并 PDF 硬换行 |
| `remove_comment` | 删除注释 |
| `remove_script_style` | 删除 HTML script/style |
| `extract_alt_text` | 提取图片 alt 文本 |

## 配置参数

Text Cleaning 全局默认配置：

```json
{
  "cleaner": {
    "tab_to_spaces": 4,
    "unicode_normalize": "NFC",
    "remove_empty_blocks": true,
    "collapse_empty_lines": true,
    "keep_raw_text": true
  }
}
```

各格式可在 `cleaner_config.{format}` 中覆盖，详见各格式专题文档。

## 质量与可观测性

### 关键指标

| 指标 | 目标 | 说明 |
|---|---|---|
| `removed_block_ratio` | < 10% | 被清洗掉的 block 比例 |
| `empty_block_ratio` | 接近 0 | 空 block 进入下游的比例 |
| `control_char_remaining_rate` | 0 | 清洗后仍残留控制字符的比例 |
| `structure_corruption_rate` | 0 | 标题/列表/表格结构被破坏的比例 |

### 日志字段

```json
{
  "event": "document_text_cleaned",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "format": "markdown",
  "input_blocks": 120,
  "output_blocks": 115,
  "removed_blocks": 5,
  "cleaning_ops_top": ["normalize_space", "trim", "remove_comment"],
  "duration_ms": 45,
  "cleaner_version": "documind-cleaner@0.1.0"
}
```

## 版本与幂等

Text Cleaning 版本由以下字段决定：

```text
clean_identity = sha256(parse_identity + cleaner_version + cleaner_config)
```

- `cleaner_version` 或 `cleaner_config` 变更会触发重新清洗。
- 清洗任务可重跑，旧 `cleaned_blocks` 不覆盖，通过 `clean_job_id` 区分版本。

# Word Text Cleaning 详细设计

本文档定义 `.docx` 文件解析后的 `document_blocks` 如何被清洗为 `cleaned_blocks`，为下游 Word Chunking 提供规范化、低噪声、结构完整的输入。

## 输入

来自 Document Parsing 的 `document_blocks`，Word 相关 `block_type`：

| block_type | 来源 | 清洗重点 |
|---|---|---|
| `heading` | `w:p` 且样式为 Heading 1~9 或弱推断 | 保留样式，清洗文本 |
| `paragraph` | 普通正文 `w:p` | 合并 run、软换行、空白规范化 |
| `list_item` | 带 `w:numPr` 的段落 | 保留编号/项目符号，清洗文本 |
| `table` | `w:tbl` | 单元格文本清洗，保留表格结构 |
| `footnote` | 脚注/尾注 | 清洗文本，保留引用关系 |
| `header_footer` | 页眉页脚候选 | 默认标记为噪声并删除 |
| `text_box` | 文本框/形状内文本 | 清洗文本，保留 shape 来源 |
| `toc` | 目录段落 | 默认删除 |
| `image_placeholder` | 图片/图表占位 | 默认不进入检索 |
| `comment` | 批注 | 默认删除 |

## 通用清洗规则

所有 Word block 先执行通用清洗：

1. **去除 BOM**：删除 UTF-8 BOM。
2. **统一换行符**：`\r\n`、`\r` 统一为 `\n`。
3. **规范化空格**：全角空格、不间断空格统一为半角空格；多个连续空格合并为 1 个；删除行尾空格。
4. **去除控制/零宽字符**：零宽空格、对象替换符、除 `\n` / `\t` 外的控制字符。
5. **Unicode NFC 规范化**。
6. **制表符转空格**：`\t` 替换为 4 个空格（可配置）。

## 段落清洗

### 合并同一段落内的多个 run

OpenXML 中同一段落 `w:p` 的文本可能被拆成多个 `w:r`（run）。解析阶段已合并为一个 block，清洗阶段不再拆分。

### 软换行处理

`<w:br/>` 在 Word 中表示段内换行，清洗阶段转换为 `\n`，不生成新段落 block。

### 空白规范化

- 段落首尾 trim。
- 段落内部多个连续空格合并为 1 个。
- 保留段落内的 `\n`（来自软换行）。

### 空段落过滤

仅包含空白或格式标记的段落标记为 `is_removed = true`。

## 标题清洗

- 保留 `heading_level` 和 `heading_confidence`。
- 清洗标题文本：trim、合并多余空格。
- 删除标题末尾多余的标点（可选）。
- 弱推断标题若 `heading_confidence < 0.7`，降级为 `paragraph` block。

## 列表项清洗

### 保留编号与项目符号

Word 列表来自 `word/numbering.xml`，清洗时：

- 保留列表编号文本或项目符号（由解析阶段根据 `w:numPr` 生成）。
- 清洗 item 文本部分。
- 保留 `list_level`（`w:ilvl`），用于后续嵌套列表识别。

### 缩进规范化

- 将制表符替换为空格。
- 不修改 `list_level`；Chunking 阶段根据 `list_level` 恢复缩进。

### 空列表项

文本为空的列表项标记为 `is_removed = true`。

## 表格清洗

Word 表格解析阶段已产出 `document_tables` 和 `document_table_cells`。Text Cleaning 只清洗单元格文本：

- 每个单元格文本执行通用清洗。
- 合并单元格内多个 run/段落为一个字符串，段落之间用空格连接。
- 保留合并单元格信息（`gridSpan`、`vMerge`），不破坏表格结构。
- 空单元格保留为空字符串，不删除单元格本身。

> 表格 block 的 `normalized_text` 通常是表格的 Markdown 渲染或占位符，具体策略见 [Word Chunking](../3-chunking/word-chunking.md)。

## 页眉页脚过滤

页眉页脚在解析阶段已被标记为 `header_footer` block。Text Cleaning 阶段默认：

- `is_removed = true`。
- `remove_reason = header_footer`。

若解析阶段未完全识别，清洗阶段按以下规则补充过滤：

- 出现在超过 60% 页面相同位置的短文本。
- 内容为纯页码、日期、公司保密声明、文件路径。
- 与文档正文样式明显不同（字号小、颜色浅）。

## 脚注与尾注

- 清洗 footnote/endnote 文本，执行通用清洗。
- 保留引用标记（如 `[^1]`），便于回答时定位。
- 默认 `is_removed = false`，进入检索。
- 配置 `index_footnotes = false` 时标记为 `is_removed = true`。

## 文本框与形状

- 文本框内文本执行通用清洗。
- 保留 `shape_id` 和 `source_ref`，便于引用定位。
- 文本框内标题/正文按 block_type 区分，不跨文本框合并。

## 目录（TOC）

- Word 自动生成的目录通常含有大量页码和重复文本，清洗阶段默认删除。
- `is_removed = true`，`remove_reason = toc`。
- 若需要索引目录，配置 `index_toc = true`。

## 批注与修订

- 批注（comment）默认删除。
- 修订（track changes）中的删除内容丢弃，插入内容保留为正文。

## 域代码与超链接

### 域代码

Word 域代码（如 `{ PAGE }`、`{ TOC }`）在解析阶段应已展开为显示文本或丢弃。清洗阶段若仍有域代码标记，删除域代码保留显示文本。

### 超链接

```xml
<w:hyperlink r:id="rId5">
  <w:r><w:t>销售策略</w:t></w:r>
</w:hyperlink>
```

- 默认保留链接显示文本“销售策略”。
- URL 进入 `metadata.link_url`。
- 配置 `link_keep_url = true` 时保留 `销售策略 (https://...)` 形式。

## 空块与噪声过滤

以下 block 标记为 `is_removed = true`：

- 空白段落、空白列表项、空白标题。
- 页眉页脚。
- 目录。
- 批注。
- 仅包含页码/日期的孤立短文本。

## 清洗流水线伪代码

```rust
fn clean_word(blocks: Vec<DocumentBlock>, cfg: CleanConfig) -> Vec<CleanedBlock> {
    let mut out = vec![];

    for b in blocks {
        let mut ops = vec![];
        let mut text = b.text.clone();

        // 通用清洗
        text = remove_bom(text, &mut ops);
        text = normalize_line_endings(text, &mut ops);
        text = normalize_whitespace(text, &mut ops);
        text = remove_control_and_zero_width(text, &mut ops);
        text = unicode_nfc(text, &mut ops);
        text = tab_to_spaces(text, cfg.tab_to_spaces, &mut ops);

        // 类型-specific 清洗
        let cleaned = match b.block_type {
            "heading" => clean_heading(text, &mut ops, b.heading_confidence),
            "paragraph" => clean_paragraph(text, &mut ops),
            "list_item" => clean_list_item(text, &mut ops),
            "table" => clean_table_cell_text(text, &mut ops),
            "footnote" => clean_footnote(text, &mut ops, cfg),
            "header_footer" => { ops.push("remove_header_footer"); String::new() }
            "text_box" => clean_paragraph(text, &mut ops),
            "toc" => { ops.push("remove_toc"); String::new() }
            "comment" => { ops.push("remove_comment"); String::new() }
            _ => text,
        };

        let is_removed = should_remove(&cleaned, &b.block_type, cfg);
        let remove_reason = if is_removed { Some("empty_or_noise".into()) } else { None };

        out.push(CleanedBlock {
            block_id: b.block_id,
            cleaned_text: cleaned,
            is_removed,
            remove_reason,
            cleaning_ops: ops,
        });
    }

    out
}
```

## 配置参数

Word Text Cleaning 在 `cleaner_config.docx` 中可覆盖：

```json
{
  "docx": {
    "tab_to_spaces": 4,
    "index_footnotes": true,
    "index_headers_footers": false,
    "index_toc": false,
    "index_comments": false,
    "link_keep_url": false,
    "weak_heading_confidence_threshold": 0.7,
    "header_footer_min_page_ratio": 0.6
  }
}
```

| 参数 | 默认值 | 说明 |
|---|---|---|
| `tab_to_spaces` | 4 | 制表符转空格数 |
| `index_footnotes` | true | 是否索引脚注/尾注 |
| `index_headers_footers` | false | 是否索引页眉页脚 |
| `index_toc` | false | 是否索引目录 |
| `index_comments` | false | 是否索引批注 |
| `link_keep_url` | false | 超链接是否保留 URL |
| `weak_heading_confidence_threshold` | 0.7 | 弱推断标题置信度阈值 |
| `header_footer_min_page_ratio` | 0.6 | 页眉页脚最少出现页面比例 |

## 质量与可观测性

### 关键指标

| 指标 | 目标 | 说明 |
|---|---|---|
| `removed_block_ratio` | < 15% | Word 中页眉页脚/目录/批注较多，比例可能略高于 Markdown |
| `header_footer_remaining_rate` | 0 | 清洗后仍残留的页眉页脚比例 |
| `toc_remaining_rate` | 0 | 清洗后仍残留的目录比例 |
| `empty_block_ratio` | 接近 0 | 空 block 进入下游的比例 |
| `structure_corruption_rate` | 0 | 标题/列表/表格结构被破坏的比例 |

### 日志字段

```json
{
  "event": "document_text_cleaned",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "format": "docx",
  "input_blocks": 320,
  "output_blocks": 280,
  "removed_blocks": 40,
  "cleaning_ops_top": ["remove_header_footer", "normalize_space", "remove_toc"],
  "duration_ms": 89,
  "cleaner_version": "documind-cleaner@0.1.0"
}
```

## 与 Word Chunking 的衔接

Text Cleaning 的输出直接进入 Word Chunking：

```text
document_blocks
  -> clean_word()
  -> cleaned_blocks
  -> word_chunker()
  -> chunks
```

清洗阶段必须保证：

- 标题层级可识别（强标题样式或弱推断置信度）。
- 列表编号/项目符号和 `list_level` 保留。
- 段落边界不被软换行破坏。
- 表格结构完整，单元格文本已清洗。
- `heading_path` 在清洗阶段不修改，只复制到 `cleaned_blocks`。

## 常见边界问题

| 问题 | 处理 |
|---|---|
| 同一段落被拆成多个 run | 解析阶段已合并，清洗阶段不拆分 |
| 软换行 `<w:br/>` | 转换为段内换行，不生成新段落 |
| 页眉页脚与正文内容重复 | 按位置和出现频率识别并删除 |
| 目录页码被当作正文 | 标记为 `toc` 并删除 |
| 批注框内容混入正文 | 标记为 `comment` 并删除 |
| 脚注编号被清洗掉 | 保留引用标记，便于定位 |
| 文本框内标题样式丢失 | 解析阶段记录 `shape_id` 和样式，清洗阶段保留 |
| 超链接只保留 URL | 默认保留显示文本，URL 进 metadata |

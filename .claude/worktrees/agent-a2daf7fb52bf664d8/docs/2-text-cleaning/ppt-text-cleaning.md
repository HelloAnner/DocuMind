# PPT Text Cleaning 详细设计

本文档定义 `.pptx` 文件解析后的 `document_blocks` 如何被清洗为 `cleaned_blocks`。PPT 的最小语义单元是 slide，Text Cleaning 的核心任务是：**区分 slide 正文与模板噪声、清洗文本框内容、保留 bullet 层级和表格结构**，为下游 PPT Chunking 提供干净的输入。

## 输入

来自 Document Parsing 的 `document_blocks`，PPT 相关 `block_type`：

| block_type | 来源 | 清洗重点 |
|---|---|---|
| `heading` | slide 标题占位符 | 保留标题，清洗文本 |
| `paragraph` | 普通文本框内正文 | 清洗文本，保留 shape 来源 |
| `list_item` | 项目符号/编号段落 | 保留 bullet，清洗文本 |
| `table` | `a:tbl` | 单元格文本清洗 |
| `slide_note` | 演讲者备注 | 单独清洗 |
| `header_footer` | 模板页脚/日期/页码/logo | 默认删除 |
| `image_placeholder` | 图片/图表占位 | 默认不进入检索 |
| `comment` | 批注 | 默认删除 |

每个 block 必须携带 `slide_index` 和 `shape_id`（或占位符类型）。

## 通用清洗规则

所有 PPT block 先执行通用清洗：

1. **去除 BOM**。
2. **统一换行符**：`\r\n`、`\r` 统一为 `\n`。
3. **规范化空格**：全角空格、不间断空格统一为半角空格；多个连续空格合并为 1 个；删除行尾空格。
4. **去除控制/零宽字符**：零宽空格、对象替换符等。
5. **Unicode NFC 规范化**。
6. **制表符转空格**：`\t` 替换为 4 个空格（可配置）。

## 模板噪声过滤

PPT 中大量文本来自 `slideMaster` 和 `slideLayout`，不是当前 slide 的正文。解析阶段已标记为 `header_footer`，Text Cleaning 阶段默认删除：

- 重复 logo 文字。
- 每页相同的页脚、日期、slide 编号。
- 模板占位符中的默认提示文字（如“单击此处添加标题”）。
- 装饰性 shape 中的文字。

清洗规则：

- `header_footer` block 默认 `is_removed = true`。
- 同一文字在超过 60% slide 的相同位置重复出现 → 标记为噪声。

## 标题清洗

### Slide 标题

- 标题占位符（`phType="title"`）的文本作为 slide H1。
- 清洗文本：trim、合并空格。
- 若标题为空，尝试使用副标题或第一个文本框内容作为 fallback。

### 副标题/二级标题

- 副标题占位符（`phType="subTitle"`）作为 H2。
- 文本框内字号显著大于正文的短文本可推断为 H2/H3，记录 `heading_confidence`。

## 段落清洗

- 文本框内段落执行通用清洗。
- 保留 `shape_id` 和 `source_ref`，便于引用定位。
- 文本框内软换行转换为 `\n`，不拆分为多个 paragraph block。

## Bullet 列表清洗

### 保留 Bullet 层级

PPT bullet 来自 `a:pPr lvl="0/1/2"`，清洗时：

- 保留 bullet 字符或编号。
- 保留 `list_level`，用于后续嵌套列表识别。
- 清洗 item 文本。

### 空 Bullet

文本为空的 bullet 标记为 `is_removed = true`。

### 默认提示文字

形如“单击此处添加文本”的占位符提示文字标记为噪声并删除。

## 表格清洗

PPT 表格是强结构表格，解析阶段已产出 `document_tables` 和 `document_table_cells`：

- 清洗每个单元格文本。
- 保留合并单元格信息（`gridSpan`、`rowSpan`）。
- 空单元格保留为空字符串。

## Slide Note 清洗

- 演讲者备注按段落清洗。
- 保留 `slide_index` 关联。
- 默认进入检索；配置 `index_slide_notes = false` 时删除。

## 超链接

PPT 超链接通常出现在文本框内：

- 默认保留链接显示文本。
- URL 进入 `metadata.link_url`。
- 配置 `link_keep_url = true` 时保留 URL。

## 批注

- PPT 批注默认删除。
- `is_removed = true`，`remove_reason = comment`。

## 空 Slide 处理

- 若一个 slide 清洗后没有任何正文 block，可标记该 slide 为空白页。
- 空白 slide 不生成 chunk，但保留在 `parsed_json` 中供管理后台查看。

## 空块与噪声过滤

以下 block 标记为 `is_removed = true`：

- 空白段落、空白 bullet、空白标题。
- 页眉页脚、模板噪声。
- 默认提示文字。
- 批注。
- 图片占位无 alt 文本。

## 清洗流水线伪代码

```rust
fn clean_ppt(blocks: Vec<DocumentBlock>, cfg: CleanConfig) -> Vec<CleanedBlock> {
    let mut out = vec![];

    // 1. 识别模板噪声
    let noise_candidates = detect_master_layout_noise(&blocks, cfg);

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

        // 模板噪声过滤
        if noise_candidates.contains(&b.block_id) || b.block_type == "header_footer" {
            ops.push("remove_master_layout_noise");
            out.push(CleanedBlock { block_id: b.block_id, cleaned_text: String::new(), is_removed: true, remove_reason: Some("header_footer".into()), cleaning_ops: ops });
            continue;
        }

        // 类型-specific 清洗
        let cleaned = match b.block_type {
            "heading" => clean_heading(text, &mut ops),
            "paragraph" => clean_paragraph(text, &mut ops),
            "list_item" => clean_list_item(text, &mut ops),
            "table" => clean_table_cell_text(text, &mut ops),
            "slide_note" => clean_slide_note(text, &mut ops, cfg),
            "comment" => { ops.push("remove_comment"); String::new() }
            _ => text,
        };

        let is_removed = should_remove(&cleaned, &b.block_type, cfg);
        let remove_reason = if is_removed { Some("empty_or_noise".into()) } else { None };

        out.push(CleanedBlock { block_id: b.block_id, cleaned_text: cleaned, is_removed, remove_reason, cleaning_ops: ops });
    }

    out
}
```

## 配置参数

PPT Text Cleaning 在 `cleaner_config.pptx` 中可覆盖：

```json
{
  "pptx": {
    "tab_to_spaces": 4,
    "index_slide_notes": true,
    "index_headers_footers": false,
    "index_comments": false,
    "link_keep_url": false,
    "remove_placeholder_hints": true,
    "placeholder_hint_patterns": ["单击此处添加标题", "单击此处添加文本"],
    "master_noise_min_slide_ratio": 0.6
  }
}
```

| 参数 | 默认值 | 说明 |
|---|---|---|
| `tab_to_spaces` | 4 | 制表符转空格数 |
| `index_slide_notes` | true | 是否索引演讲者备注 |
| `index_headers_footers` | false | 是否索引页眉页脚 |
| `index_comments` | false | 是否索引批注 |
| `link_keep_url` | false | 超链接是否保留 URL |
| `remove_placeholder_hints` | true | 是否删除占位符提示文字 |
| `placeholder_hint_patterns` | 常见提示 | 占位符提示文字匹配列表 |
| `master_noise_min_slide_ratio` | 0.6 | 模板噪声最少出现 slide 比例 |

## 质量与可观测性

### 关键指标

| 指标 | 目标 | 说明 |
|---|---|---|
| `removed_block_ratio` | < 20% | PPT 模板噪声较多，比例可能较高 |
| `header_footer_remaining_rate` | 0 | 清洗后仍残留的页眉页脚 |
| `placeholder_hint_remaining_rate` | 0 | 残留的占位符提示文字 |
| `empty_block_ratio` | 接近 0 | 空 block 进入下游的比例 |
| `slide_blank_rate` | 可接受 | 空白 slide 比例 |

### 日志字段

```json
{
  "event": "document_text_cleaned",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "format": "pptx",
  "input_blocks": 210,
  "output_blocks": 170,
  "removed_blocks": 40,
  "cleaning_ops_top": ["remove_master_layout_noise", "normalize_space", "remove_placeholder_hint"],
  "duration_ms": 67,
  "cleaner_version": "documind-cleaner@0.1.0"
}
```

## 与 PPT Chunking 的衔接

Text Cleaning 的输出直接进入 PPT Chunking：

```text
document_blocks
  -> clean_ppt()
  -> cleaned_blocks
  -> ppt_chunker()
  -> chunks
```

清洗阶段必须保证：

- 每个 slide 的标题可识别。
- bullet 层级和文本保留。
- 模板噪声已过滤。
- 表格结构完整。
- slide note 与正文分离。
- `heading_path` 在清洗阶段不修改，只复制到 `cleaned_blocks`。

## 常见边界问题

| 问题 | 处理 |
|---|---|
| 标题占位符为空 | 使用副标题或第一个文本框作为 fallback |
| 母版 logo 文字每页重复 | 按位置和出现频率识别为噪声 |
| bullet 文本框内同时有标题和正文 | 解析阶段按样式/位置拆分 block |
| 表格单元格含多段 | 合并为一段，段落间加空格 |
| 演讲者备注很长 | 清洗后按段落拆分 slide_note chunk |
| 隐藏 slide | 解析阶段可选择是否包含，默认不包含 |
| 文本框内超链接 | 保留显示文本，URL 进 metadata |
| 默认提示文字 | 按 pattern 匹配删除 |

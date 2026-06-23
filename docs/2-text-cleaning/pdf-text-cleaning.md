# PDF Text Cleaning 详细设计

本文档定义 PDF 文件解析后的 `document_blocks` 如何被清洗为 `cleaned_blocks`。PDF 没有稳定的逻辑结构，Text Cleaning 的核心任务是：**从字符坐标中恢复阅读顺序、合并版式断行、去除页眉页脚等版式噪声**，为下游 PDF Chunking 提供语义连贯的段落。

## 输入

来自 Document Parsing 的 `document_blocks`，PDF 相关 `block_type`：

| block_type | 来源 | 清洗重点 |
|---|---|---|
| `heading` | 字号/位置/加粗推断的标题 | 保留置信度，清洗文本 |
| `paragraph` | 从行合并恢复的段落 | 合并硬换行、去连字符 |
| `list_item` | 带项目符号/编号前缀的行 | 保留前缀，清洗文本 |
| `table` | 表格候选区域 | 保留单元格文本，低置信度降级 |
| `header_footer` | 重复页眉页脚 | 默认删除 |
| `image_placeholder` | 图片/图表占位 | 默认不进入检索 |

每个 block 必须携带 `page`、`bbox` 和字体/坐标信息。

## 通用清洗规则

所有 PDF block 先执行通用清洗：

1. **去除 BOM**：PDF 文本流中偶发出现 BOM。
2. **统一换行符**：`\r\n`、`\r` 统一为 `\n`。
3. **规范化空格**：全角空格、不间断空格、零宽空格统一为半角空格；多个连续空格合并为 1 个。
4. **去除控制/零宽字符**：对象替换符、零宽字符、不可见控制字符。
5. **Unicode NFC 规范化**。
6. **连字/合字还原**：如 `ﬁ` -> `fi`、`ﬂ` -> `fl`。
7. **引号规范化**：把智能引号 `“”‘’` 可选保留或转换为普通引号（按配置）。

## 行合并与段落恢复

PDF 文本通常以行为单位提取，Text Cleaning 负责把行恢复为段落。

### 合并规则

1. **同一行字符合并**：按 x 坐标排序后合并为完整行。
2. **行间距判断**：
   - 行间距 < 1.5 倍正文行高 → 同属一段。
   - 行间距 ≥ 1.5 倍行高 → 新段落开始。
3. **缩进一致性**：
   - 上一行无句末标点且下一行缩进一致 → 合并硬换行。
   - 下一行缩进明显不同（如首行缩进） → 新段落开始。
4. **字号/字体突变**：行之间字号或字体发生显著变化 → 新段落或标题开始。
5. **表格区域内文本**：不进入普通段落合并，单独保留为 `table` block。

### 连字符处理

英文 PDF 常见行尾连字符：

```text
This is a long sen-
tence.
```

清洗后：

```text
This is a long sentence.
```

- 行尾为 `-` 且下一行以小写字母开头 → 删除连字符并合并。
- 行尾为 `-` 但下一行以大写字母开头 → 保留连字符，可能是复合词或新句。

### 中文 PDF 硬换行

中文 PDF 常把一行文本硬截断：

```text
华东区 Q1 销售目标
为 1200 万元。
```

清洗规则：

- 上一行无句末标点（。！？；）且下一行缩进一致 → 合并为空格或直接拼接。
- 下一行以数字、标点或短词开头 → 直接拼接不加空格。
- 含编号前缀的行优先识别为 `list_item`，避免与正文粘在一起。

## 阅读顺序恢复

PDF 字符在文件流中的顺序不一定等于阅读顺序。Text Cleaning 阶段按坐标重排：

1. 按 `page` 升序分组。
2. 单页内检测列布局（双栏/三栏）。
3. 同一列内按 `y` 降序（从上到下）、`x` 升序（从左到右）排序。
4. 对标题/页眉等短文本根据位置重新归类。

### 列检测

- 统计单页所有 block 的 `x0` 分布。
- 若存在明显谷值（gap ≥ 页面宽度 20%），判定为多栏。
- 多栏页面按列分组，列之间不跨列合并段落。

## 页眉页脚过滤

页眉页脚过滤分两步：

1. 解析阶段标记 `header_footer` 候选。
2. Text Cleaning 阶段根据重复频率和内容规则确认删除。

判定规则：

- 出现在超过 60% 页面相同位置的短文本。
- 内容为纯页码、日期、公司保密声明、文件路径、重复 logo 文字。
- 字体/字号与正文明显不同，或位于页面顶部/底部固定区域。

清洗后 `is_removed = true`，`remove_reason = header_footer`。

## 标题推断与清洗

### 标题清洗

- 保留 `heading_confidence`。
- 清洗标题文本：trim、合并空格。
- 低置信度标题（`heading_confidence < 0.7`）降级为 `paragraph` block。

### H1 推断

满足以下条件之一视为 H1：

- 字号为全文档最大标题字号。
- 独占一行且段前有大段空白。
- 后面紧跟大量正文，形成新的章节。

## 列表处理

PDF 列表通过项目符号或编号前缀识别：

- 项目符号：`•`、`·`、`○`、`●`、`-`、`*`。
- 编号：`1.`、`(1)`、`(一)`、`①`、`1)`。

清洗规则：

- 保留前缀符号。
- 清洗 item 文本。
- 连续列表项按缩进和垂直间距分组。
- 误识别为列表的短行（如以 `-` 开头的负数）根据上下文修正。

## 表格处理

### 强结构表格

`grid_confidence >= 0.65` 的表格：

- 清洗单元格文本，执行通用清洗。
- 保留行列结构和合并单元格信息。

### 低置信度表格

`grid_confidence < 0.65` 的表格：

- 不生成强结构化 `table` block。
- 将单元格文本按阅读顺序拼接为 `paragraph` block。
- 记录 `metadata.table_grid_confidence` 和 warning。

## 水印与噪声

### 水印识别

- 文字半透明、字号大、居中、内容为公司名/保密字样。
- 同一文字在多个页面重复出现但不在页眉页脚区域。
- 清洗阶段标记为 `is_removed = true`，`remove_reason = watermark`。

### 乱码/编码异常

- 检测 block 中乱码字符比例，超过阈值时：
  - 整页乱码：降低 `quality_score`，进入 `parse_low_confidence`。
  - 局部乱码：删除乱码字符或标记 block 为低置信度。

### 孤立字符

- 单页中散落的孤立字符（如无意义字母、数字）标记为噪声并删除。

## 扫描版 PDF

- 扫描版 PDF 无文本层，解析阶段标记为 `scanned_pdf_no_text_layer`。
- Text Cleaning 阶段不做处理，等待 OCR 增强后重新进入清洗流程。
- 若 OCR 完成，按 OCR 产出的 `document_blocks` 重新执行本策略。

## 空块与噪声过滤

以下 block 标记为 `is_removed = true`：

- 空白或仅含空格的 paragraph / heading / list_item。
- 页眉页脚。
- 水印。
- 乱码比例过高的 block。
- 表格区域外的孤立数字/字母。

## 清洗流水线伪代码

```rust
fn clean_pdf(blocks: Vec<DocumentBlock>, cfg: CleanConfig) -> Vec<CleanedBlock> {
    let mut out = vec![];

    // 1. 按页和坐标重排
    let ordered = reorder_by_reading_order(blocks);

    // 2. 识别页眉页脚和水印
    let noise_candidates = detect_noise(&ordered, cfg);

    // 3. 行合并为段落
    let merged = merge_lines_into_paragraphs(ordered, cfg);

    for b in merged {
        let mut ops = vec![];
        let mut text = b.text.clone();

        // 通用清洗
        text = remove_bom(text, &mut ops);
        text = normalize_line_endings(text, &mut ops);
        text = normalize_whitespace(text, &mut ops);
        text = remove_control_and_zero_width(text, &mut ops);
        text = unicode_nfc(text, &mut ops);
        text = defragment_ligatures(text, &mut ops);
        text = remove_trailing_hyphens(text, &mut ops);

        // 噪声过滤
        if noise_candidates.contains(&b.block_id) {
            ops.push("remove_noise");
            out.push(CleanedBlock { block_id: b.block_id, cleaned_text: String::new(), is_removed: true, remove_reason: Some("noise".into()), cleaning_ops: ops });
            continue;
        }

        // 类型-specific 清洗
        let cleaned = match b.block_type {
            "heading" => clean_pdf_heading(text, &mut ops, b.heading_confidence),
            "paragraph" => clean_paragraph(text, &mut ops),
            "list_item" => clean_list_item(text, &mut ops),
            "table" => clean_pdf_table(text, &mut ops, b.grid_confidence),
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

PDF Text Cleaning 在 `cleaner_config.pdf` 中可覆盖：

```json
{
  "pdf": {
    "line_spacing_factor": 1.5,
    "indent_consistency_threshold": 0.1,
    "header_footer_min_page_ratio": 0.6,
    "hyphen_merge_lowercase_only": true,
    "heading_confidence_threshold": 0.7,
    "table_grid_confidence_threshold": 0.65,
    "column_gap_ratio": 0.2,
    "garbled_char_ratio_threshold": 0.3,
    "watermark_opacity_threshold": 0.5
  }
}
```

| 参数 | 默认值 | 说明 |
|---|---|---|
| `line_spacing_factor` | 1.5 | 同一段落的行间距上限倍数 |
| `indent_consistency_threshold` | 0.1 | 缩进一致性容差（相对页面宽度） |
| `header_footer_min_page_ratio` | 0.6 | 页眉页脚最少出现页面比例 |
| `hyphen_merge_lowercase_only` | true | 仅小写开头时合并连字符 |
| `heading_confidence_threshold` | 0.7 | 标题推断置信度阈值 |
| `table_grid_confidence_threshold` | 0.65 | 表格结构置信度阈值 |
| `column_gap_ratio` | 0.2 | 多栏检测的栏间距阈值 |
| `garbled_char_ratio_threshold` | 0.3 | 乱码字符比例阈值 |
| `watermark_opacity_threshold` | 0.5 | 水印透明度阈值 |

## 质量与可观测性

### 关键指标

| 指标 | 目标 | 说明 |
|---|---|---|
| `header_footer_remaining_rate` | 0 | 清洗后仍残留的页眉页脚 |
| `line_merge_error_rate` | < 3% | 错误合并或拆分段落的比例 |
| `table_corruption_rate` | 0 | 表格结构被破坏的比例 |
| `garbled_block_ratio` | < 5% | 乱码 block 比例 |
| `scanned_pdf_detection_rate` | 100% | 扫描版 PDF 必须被识别 |

### 日志字段

```json
{
  "event": "document_text_cleaned",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "format": "pdf",
  "input_blocks": 850,
  "output_blocks": 720,
  "removed_blocks": 130,
  "cleaning_ops_top": ["remove_header_footer", "merge_line_break", "remove_hyphen"],
  "duration_ms": 312,
  "cleaner_version": "documind-cleaner@0.1.0"
}
```

## 与 PDF Chunking 的衔接

Text Cleaning 的输出直接进入 PDF Chunking：

```text
document_blocks
  -> clean_pdf()
  -> cleaned_blocks
  -> pdf_chunker()
  -> chunks
```

清洗阶段必须保证：

- 阅读顺序正确，列不混排。
- 段落边界准确，硬换行已合并。
- 页眉页脚、水印已过滤。
- 标题置信度可靠，低置信度降级为段落。
- 表格结构完整或已降级为段落。

## 常见边界问题

| 问题 | 处理 |
|---|---|
| 双栏 PDF 段落跨栏误合并 | 列检测失败时按 x 坐标分栏 |
| 行尾 `-` 是减号还是连字符 | 结合下一行首字符大小写判断 |
| 标题字号与正文接近 | 低置信度标题，不进入标题栈 |
| 表格与正文坐标重叠 | 表格候选区域优先，重叠文本归入 table |
| 页眉页脚未被过滤 | 按重复频率和位置补充过滤 |
| 扫描 PDF | 标记为低置信度，等待 OCR |
| 行内公式/特殊字体 | 保留文本，不破坏段落边界 |
| 中文竖排 PDF | 第一版可标记为不支持或低置信度 |

# Word Chunking 详细设计

本文档定义 `.docx` 文件在 Text Cleaning 之后如何切分为 chunks。Word 具有强结构标记（段落样式、列表编号、表格、分节符等），Chunking 阶段应充分利用 OpenXML 段落和样式信息，避免把版式噪声带入语义块。

## 输入

来自 Text Cleaning 的 `cleaned_blocks`，Word 相关 block_type：

| block_type | 来源 | 是否进入 chunk |
|---|---|---|
| `heading` | `w:p` 样式为 Heading 1~9 或弱推断标题 | 作为上下文，不单独成 chunk |
| `paragraph` | 普通正文 `w:p` | 是 |
| `list_item` | 带 `w:numPr` 的段落 | 是 |
| `table` | `w:tbl` | 是，按表格策略切分 |
| `footnote` | 脚注/尾注 | 可配置，默认是 |
| `header_footer` | 页眉页脚 | 默认否 |
| `text_box` | 文本框/形状内文本 | 是，不跨文本框合并 |
| `image_placeholder` | 图片/图表占位 | 默认否 |

## 标题栈维护

### 强标题

Word 标题样式从 `styles.xml` 映射：

| Word 样式 | heading_level |
|---|---|
| `Heading 1` / 标题 1 | 1 |
| `Heading 2` / 标题 2 | 2 |
| ... | ... |
| `Heading 9` / 标题 9 | 9 |

- 强标题直接更新标题栈。
- 标题 block 不单独生成 chunk，作为后续 block 的 `heading_path` 前缀。

### 弱推断标题

当文档没有标准标题样式时，使用以下启发规则推断：

- 字号显著大于正文（如 ≥ 1.5 倍）。
- 加粗且段前/段后间距大。
- 段落长度较短（如 ≤ 50 字）。
- 居中或缩进特殊。

弱推断标题记录 `heading_confidence < 1.0`，仅在置信度 ≥ 0.7 时进入标题栈。

## 硬边界规则

1. **Heading 1**：每个 `Heading 1` / 标题 1 强制结束当前 chunk 候选组。
2. **分节符（Section Break）**：Word 分节符通常对应章节/附录边界，强制结束当前组。
3. **表格**：每个 `w:tbl` 单独生成 table chunk，不与普通段落合并。
4. **文本框**：不同文本框（shape）之间不跨框合并。
5. **脚注/尾注**：footnote block 不与其引用段落合并，单独生成 `source_type = footnote` chunk。
6. **页眉页脚**：已标记为噪声，不进入 chunk。
7. **分页符**：默认不视为硬边界，除非分页符后紧跟 H1 或分节符。

## 软边界规则

- 同一 H2 / H3 下的多个短段落合并。
- 连续 `list_item` 合并为一个 chunk。
- 标题与其后第一段正文合并。
- 表格前一段的“表 N：xxx”说明文字可与表格 block 合并为一个 table chunk 的标题前缀。

## 段落合并细节

### 同一段落被多个 run 拆开

解析阶段已按 `w:p` 合并为一个 block；Chunking 不再拆分。

### 软换行

`<w:br/>` 在清洗阶段已转换为段内换行，不拆新 chunk。

### 孤行控制

- 段落只有 1~2 个字且下一段为同一段落延续时，与下一段合并。
- 标题后的空行/短说明与标题合并到第一段正文 chunk。

## 列表处理

### 列表识别

Word 列表来自 `word/numbering.xml`：

- `w:numPr` + `w:numId` 表示属于某个列表。
- 同一 `numId` 的连续段落合并为列表 chunk。
- 多级列表通过 `w:ilvl` 区分层级，保留缩进/编号。

### 超长列表拆分

- 优先在顶层列表项之间拆分。
- 不要把子列表从父项中割裂。
- 每个拆分后的 chunk 保留列表前缀上下文。

## 表格处理

Word 表格是强结构表格，解析阶段已产出 `document_tables` 和 `document_table_cells`。

| 表格大小 | 策略 |
|---|---|
| 小表格（行 ≤ 30，token ≤ 1200） | 整表一个 table chunk |
| 中等表格（行 31 ~ 300） | 表头 + 行窗口，每 chunk 20 ~ 50 行 |
| 超大表格（行 > 300 或 token > 8000） | 摘要 chunk + 行级回表 |

### 表格标题说明

表格前一段若包含“表 N”、“Table N”或短说明，优先合并为 table chunk 的标题前缀：

```text
标题路径：年度策略 / Q2 目标
表格：区域销售目标（表 1）
页码：7

| 区域 | 目标 | 负责人 |
|---|---|---|
| 华东 | 1200 万 | 张三 |
```

### 表格内的长单元格

若单个单元格文本过长（超过 `hard_split_tokens`），在单元格内部按句子切分，但 table chunk 仍保持行完整性；必要时把该行独立成一个 chunk。

## 文本框与形状

- 每个文本框作为一个独立 block group，不与正文混排。
- 文本框内部若有标题和正文，按普通段落规则切分。
- 文本框内表格按表格策略处理。
- 页眉页脚中的文本框已过滤。

## 脚注与尾注

### 处理方式

- 默认生成 `source_type = footnote` 的 chunk。
- footnote chunk 在文档流中放在其引用位置附近，但不与普通段落合并。
- 若配置 `index_footnotes = false`，则跳过。

### 内容格式

```text
标题路径：正文标题路径
来源：脚注 3
页码：5

原文引用：...
脚注内容：...
```

## 切分示例

### 输入结构

```text
[Heading 1] 年度策略
  [Heading 2] Q1 目标
    [Paragraph] 华东区 Q1 销售目标为 1200 万元...
    [Paragraph] 华南区 Q1 销售目标为 900 万元...
  [Heading 2] Q2 目标
    [Table] 区域销售目标
    [Paragraph] Q2 重点关注客户留存。
```

### 输出 Chunks

| chunk_index | source_type | heading_path | 内容 |
|---|---|---|---|
| 0 | paragraph | [年度策略, Q1 目标] | 华东区、华南区目标 |
| 1 | table | [年度策略, Q2 目标] | 区域销售目标表 |
| 2 | paragraph | [年度策略, Q2 目标] | Q2 重点关注客户留存 |

## 元数据补充

Word chunk 的 `metadata` 建议包含：

```json
{
  "format": "docx",
  "style": "Normal",
  "heading_confidence": 1.0,
  "section_index": 2,
  "is_text_box": false,
  "is_footnote": false
}
```

## 常见边界问题

| 问题 | 处理 |
|---|---|
| 文档无标准标题样式 | 弱推断标题，置信度 < 1.0，低置信度不进入标题栈 |
| 标题单独占一页 | 标题作为下一页正文的 heading_path，不单独生成空 chunk |
| 表格跨页 | Word 表格仍是单一 `w:tbl`，按完整 table 处理；页码范围记录起止页 |
| 目录（TOC）段落 | 解析阶段识别为 `toc` block，默认不进入 chunk |
| 修订/批注 | 清洗阶段过滤，不进入 chunk |
| 分栏 | Word 分栏通常不影响段落顺序，按解析顺序处理 |

## 配置参数覆盖

Word 可在 `chunker_config.docx` 中覆盖：

```json
{
  "docx": {
    "index_footnotes": true,
    "index_headers_footers": false,
    "merge_table_caption": true,
    "weak_heading_confidence_threshold": 0.7,
    "section_break_as_hard_boundary": true
  }
}
```

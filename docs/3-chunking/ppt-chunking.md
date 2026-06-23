# PPT Chunking 详细设计

本文档定义 `.pptx` 文件在 Text Cleaning 之后如何切分为 chunks。PPT 的最小语义单元是 slide，Chunking 阶段应尊重 slide 边界，同时把单个 slide 内的标题、正文、列表、表格、备注合理组织成可检索片段。

## 输入

来自 Text Cleaning 的 `cleaned_blocks`，PPT 相关 block_type：

| block_type | 来源 | 是否进入 chunk |
|---|---|---|
| `heading` | slide 标题占位符 / 强推断标题 | 作为上下文，不单独成 chunk |
| `paragraph` | 普通文本框内正文 | 是 |
| `list_item` | 项目符号/编号段落 | 是 |
| `table` | `a:tbl` | 是，按表格策略切分 |
| `slide_note` | 演讲者备注 | 可配置，默认是 |
| `image_placeholder` | 图片/图表占位 | 默认否 |
| `header_footer` | 模板页脚/日期/页码 | 默认否 |

每个 block 必须携带 `slide_index` 和 `shape_id`（或占位符类型）。

## Slide 是最小硬边界

**PPT 不允许跨 slide 合并 chunk。** 每个 slide 生成一个或多个 chunk，但 chunk 的内容不会跨 slide。

原因：

- slide 是演讲者按页组织的内容单元。
- 跨 slide 合并会把不同主题的 bullet 混在一起。
- 引用定位需要回到具体 slide。

## 单 Slide 内排序

### 读取顺序

1. 标题占位符（`phType="title"`）优先。
2. 副标题/中心文本框（`phType="ctrTitle"`、`phType="subTitle"`）。
3. 其余 shape 按阅读顺序排序：
   - 多栏布局先按列分组（x 坐标）。
   - 同一列内按 y 坐标从上到下排序。

### 列检测

- 若同一 slide 内 shape 明显分为左右两栏，按栏分组。
- 不同栏之间不合并为同一个 chunk。

## 标题栈维护

### Slide 标题

- 每个 slide 的标题占位符作为该 slide 内所有内容的默认 H1。
- 标题 block 不单独生成 chunk，作为 `heading_path` 的第一个元素。

### 副标题/二级标题

- 副标题作为 H2 进入标题栈。
- 文本框内字号显著大于正文的短文本可推断为 H2/H3。

### 标题路径示例

```text
Slide 1: 年度策略
  -> heading_path = ["年度策略"]
Slide 5: Q1 目标
  -> heading_path = ["Q1 目标"]
```

## 硬边界规则

1. **Slide 边界**：不跨 slide 合并。
2. **表格边界**：slide 内表格单独生成 table chunk。
3. **Notes 边界**：slide note 不与其 slide 正文合并。
4. **多栏边界**：不同栏之间不合并。
5. **不同 shape 之间**：默认可合并，但如果 shape 间距大或属于不同语义区，可分 chunk。

## 软边界规则

- 同一文本框内的多个 bullet（list_item）合并为一个 chunk。
- 标题 + 其下第一段正文合并。
- 连续短段落合并。
- 表格前的简短说明文字可与表格合并为 table chunk 前缀。

## 列表处理

### Bullet 合并

同一文本框内的 bullet 是典型的 PPT 内容形式，应合并：

```text
标题路径：Q1 目标
Slide：5

- 华东区 1200 万
- 华南区 900 万
- 华北区 800 万
```

### 多级 Bullet

- 通过缩进层级区分（`a:pPr lvl="0/1/2"`）。
- 嵌套 bullet 不单独拆出，除非整体 token 超过 `max_chunk_tokens`。

### 超长 Bullet 列表拆分

- 按顶层 bullet 拆分。
- 不要把子 bullet 从父 bullet 中割裂。
- 每个 chunk 保留 slide 标题作为 heading_path。

## 表格处理

PPT 表格与 Word 表格同为强结构表格：

| 表格大小 | 策略 |
|---|---|
| 小表格 | 整表一个 table chunk |
| 中等表格 | 行窗口，每 chunk 带完整表头 |
| 超大表格 | 摘要 chunk + 行级回表 |

### 表格说明

slide 内表格前的文本框若包含表格说明（如“表 1：销售目标”），可合并为 table chunk 标题前缀。

## Slide Note 处理

### 默认策略

- 每个 slide 的备注解析为 `slide_note` block。
- 生成 `source_type = slide_note` 的 chunk。
- slide note chunk 与 slide 正文 chunk 分开，但 metadata 中记录 `slide_index` 便于关联。

### 内容格式

```text
标题路径：Q1 目标
Slide：5
来源：演讲者备注

备注内容：这里需要强调华东区目标...
```

### 配置

`index_slide_notes = true`（默认）；关闭时完全不生成 slide_note chunk。

## 单 Slide 多 Chunk

一个内容丰富的 slide 可能生成多个 chunk：

| chunk_index | source_type | slide | 内容 |
|---|---|---|---|
| 10 | paragraph | 5 | 标题 + 引言 |
| 11 | paragraph | 5 | bullet 列表 |
| 12 | table | 5 | 表格 |
| 13 | slide_note | 5 | 演讲者备注 |

## 标题页处理

- 标题页通常只有标题和副标题，无正文。
- 标题页生成一个 paragraph chunk，内容为标题 + 副标题，用于检索“这份 PPT 讲什么”。
- 不要把标题页与下一 slide 合并。

## 模板噪声过滤

解析阶段已根据 `slideMaster` / `slideLayout` 过滤模板元素：

- 重复 logo、页脚、日期、 slide 编号。
- 装饰性 shape。
- 标题占位符外的重复文本。

Chunking 阶段不再处理这些 block。

## 切分示例

### 输入结构

```text
Slide 1
  [Heading] 年度策略
  [Paragraph] 本策略覆盖华东、华南、华北三大区域。
Slide 2
  [Heading] Q1 目标
  [ListItem] 华东区 1200 万
  [ListItem] 华南区 900 万
  [Table] 区域目标明细
  [SlideNote] 强调华东区重点客户...
```

### 输出 Chunks

| chunk_index | source_type | slide | heading_path | 内容 |
|---|---|---|---|---|
| 0 | paragraph | 1 | [年度策略] | 年度策略 + 本策略覆盖... |
| 1 | paragraph | 2 | [Q1 目标] | bullet 列表 |
| 2 | table | 2 | [Q1 目标] | 区域目标明细表 |
| 3 | slide_note | 2 | [Q1 目标] | 强调华东区重点客户 |

## 元数据补充

PPT chunk 的 `metadata` 建议包含：

```json
{
  "format": "pptx",
  "slide_index": 5,
  "shape_ids": ["shape_2", "shape_3"],
  "placeholder_type": "title",
  "is_slide_note": false
}
```

## 常见边界问题

| 问题 | 处理 |
|---|---|
| 空白 slide | 不生成 chunk；若整个 PPT 空白率过高，降低 quality_score |
| 标题占位符为空 | slide 标题从第一个文本框推断，否则使用 "Slide N" |
| 单 slide 内容极多 | 按文本框/列表/表格拆分为多个 chunk |
| 演讲者备注极长 | 按段落边界拆分为多个 slide_note chunk |
| 多栏 PPT | 按列分组，避免左右栏混排 |
| 隐藏 slide | 解析阶段可选择是否包含，默认不包含 |

## 配置参数覆盖

PPT 可在 `chunker_config.pptx` 中覆盖：

```json
{
  "pptx": {
    "index_slide_notes": true,
    "slide_title_as_h1": true,
    "subtitle_as_h2": true,
    "column_gap_ratio": 0.25,
    "merge_bullets_same_shape": true,
    "empty_slide_skip": true
  }
}
```

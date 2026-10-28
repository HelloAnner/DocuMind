# PDF Chunking 详细设计

本文档定义 PDF 文件在 Text Cleaning 之后如何切分为 chunks。PDF 是“版式格式”，没有稳定的逻辑结构（标题、段落、列表、表格都需要从字符坐标和布局中推断），因此 PDF 的 chunk 设计重点在于：**恢复阅读顺序、识别语义边界、避免把版式噪声当正文**。

## 输入

来自 Text Cleaning 的 `cleaned_blocks`，PDF 相关 block_type：

| block_type | 来源 | 是否进入 chunk |
|---|---|---|
| `heading` | 字号/位置/加粗推断的标题 | 作为上下文，不单独成 chunk |
| `paragraph` | 从行合并恢复的段落 | 是 |
| `list_item` | 带项目符号/编号前缀的行 | 是 |
| `table` | 表格候选区域 | 是，按表格策略切分 |
| `header_footer` | 重复页眉页脚 | 默认否 |
| `image_placeholder` | 图片/图表占位 | 默认否 |

每个 block 必须携带 `bbox`（页面坐标）和 `page`。

## 阅读顺序恢复

### 输入顺序校正

PDF 文本在文件流中的顺序不一定等于阅读顺序。Chunking 前必须按页面坐标重排：

1. 按 `page` 升序分组。
2. 单页内检测列布局（双栏/三栏）。
3. 在同一列内按 `y` 降序（从上到下）、`x` 升序（从左到右）排序。
4. 标题/页眉等短文本在排序后仍可能位置靠前，按规则识别为 heading。

### 列检测

- 统计单页所有 block 的 `x0` 分布。
- 若存在明显谷值（gap ≥ 页面宽度 20%），判定为多栏。
- 多栏页面按列分组，列之间不合并 chunk。

## 标题栈维护

### 标题推断规则

PDF 标题没有显式标签，使用以下特征推断：

- 字号显著大于正文（≥ 1.3 倍）。
- 加粗（字体名含 Bold / 字重高）。
- 段前/段后间距大。
- 文本长度短（一般 ≤ 60 字）。
- 居中或左对齐且缩进特殊。

### 层级推断

- 字号越大、层级越高。
- 同一页面出现多个字号阶梯时，建立相对层级。
- 推断标题记录 `heading_confidence`，仅当 ≥ 0.7 时进入标题栈。

### H1 边界

满足以下条件之一视为 H1：

- 字号为全文档最大标题字号。
- 独占一行且段前有大段空白。
- 后面紧跟大量正文，形成新的章节。

H1 作为硬边界，结束当前 chunk 候选组。

## 硬边界规则

1. **H1 标题**：章节边界，不跨章节合并。
2. **表格候选区域**：表格 block 单独生成 table chunk；低置信度表格降级为普通段落 chunk。
3. **列边界**：多栏 PDF 不跨列合并。
4. **页面边界**：默认不作为硬边界（段落可能跨页），但若页面起始出现 H1 或大块空白，则结束当前组。
5. **页眉页脚**：已过滤，不进入 chunk。
6. **大段垂直空白**：同页内两个 block 之间的垂直间距 > 3 倍行高，视为段落/章节分隔。
7. **字体突变**：字号变化大且伴随位置变化，视为边界。

## 软边界规则

- 同一段落内的多行合并为一个 paragraph block 后不再拆分。
- 同一 H2 / H3 下的多个 paragraph block 可合并。
- 连续 `list_item` 合并。
- 标题与其后第一段正文合并。

## 段落恢复与 Chunking

### 从行到段落的清洗

Text Cleaning 阶段已完成：

- 同一行字符按 x 坐标合并。
- 行间距 < 1.5 倍行高时合并为同一段。
- 行尾无句末符号且下一行缩进一致时合并硬换行。
- 行距大/缩进变化大/字号变化大时拆段。

### 孤行与段内换行

- PDF 中的硬换行（如中英文混排）可能把一句话拆成两行；清洗阶段按缩进和标点合并。
- 连字符 `-` 在行尾出现时，清洗阶段做去连字符合并。

### 超长段落切分

若单个 paragraph block 超过 `max_chunk_tokens`：

1. 优先按句号、问号、叹号拆分。
2. 仍超长时按逗号、分号拆分。
3. 仍超过 `hard_split_tokens` 时按 token 边界强制切分。

每个子片段保留相同的 `heading_path` 和 `page_start` / `page_end`。

## 列表处理

PDF 列表识别：

- 项目符号：`•`、`·`、`○`、`●`、`-` 等。
- 编号：`1.`、`(1)`、`(一)`、`①` 等。
- 列表项通常缩进一致且垂直间距接近。

### 合并规则

- 连续 `list_item` block 合并为一个 chunk。
- 列表项之间的大间距视为列表结束。
- 嵌套列表通过缩进层级区分，子列表不单独拆出，除非整体超长。

## 表格处理

PDF 表格需要从布局推断，置信度低于 Word / PPT。

### 表格置信度

| 置信度 | 处理 |
|---|---|
| `grid_confidence >= 0.85` | 强结构表格，按 table chunk 切分 |
| `0.65 <= grid_confidence < 0.85` | 生成 table chunk，但标注低置信度，可回表校验 |
| `grid_confidence < 0.65` | 不生成 table chunk，降级为普通段落 chunk |

### 表格切分

强结构表格按通用表格策略：

- 小表格：整表一个 chunk。
- 中等表格：行窗口。
- 超大表格：摘要 + 回表。

低置信度表格保留原始文本，作为 paragraph chunk，不引用 `document_tables` 精确结构。

## 双栏/多栏 PDF

### 切分原则

- 同一列内的段落可以合并跨多行 chunk。
- 不同列之间必须分 chunk。
- 若文章从右栏接续到左栏（某些语言），按解析时确定的阅读顺序处理。

### 栏边界检测

```python
# 伪代码
x_centers = [b.x0 + b.width/2 for b in blocks]
# KMeans 或直方图聚类
clusters = cluster_1d(x_centers, gap_threshold=page_width*0.2)
columns = sorted(clusters, key=lambda c: min(b.x0 for b in c))
```

## 扫描版 PDF

- 扫描版 PDF 无文本层，解析阶段标记为 `scanned_pdf_no_text_layer`。
- 不进入默认 chunking；等待 OCR 增强后重新走解析流程。
- 若 OCR 完成，按 OCR 产出的 `cleaned_blocks` 重新执行本策略。

## 切分示例

### 输入结构

```text
Page 1
  [H1] 年度策略
  [Paragraph] 本文档描述 2025 年销售策略...
Page 2
  [H2] Q1 目标
  [ListItem] 华东区 1200 万
  [ListItem] 华南区 900 万
Page 3
  [Table] 区域销售目标（强结构）
  [Paragraph] Q1 重点客户...
```

### 输出 Chunks

| chunk_index | source_type | heading_path | page_range | 内容 |
|---|---|---|---|---|
| 0 | paragraph | [年度策略] | [1, 1] | 本文档描述... |
| 1 | paragraph | [年度策略, Q1 目标] | [2, 2] | 华东区、华南区目标 |
| 2 | table | [年度策略, Q1 目标] | [3, 3] | 区域销售目标表 |
| 3 | paragraph | [年度策略, Q1 目标] | [3, 3] | Q1 重点客户 |

## 元数据补充

PDF chunk 的 `metadata` 建议包含：

```json
{
  "format": "pdf",
  "column_index": 0,
  "heading_confidence": 0.92,
  "table_grid_confidence": 0.88,
  "line_spacing": 1.2,
  "font_size": 12.0
}
```

## 常见边界问题

| 问题 | 处理 |
|---|---|
| 标题字号与正文接近 | 低置信度标题，不进入标题栈 |
| 双栏段落跨栏误合并 | 列检测失败时会出现，需人工样例校准 |
| 表格与正文坐标重叠 | 表格候选区域优先，重叠文本归入 table |
| 页眉页脚未被过滤 | 清洗阶段按重复频率过滤，必要时管理后台标记 |
| 扫描 PDF | 走 OCR 流程，不默认进入 chunk |
| 行内公式/特殊字体 | 保留文本，不破坏段落边界 |

## 配置参数覆盖

PDF 可在 `chunker_config.pdf` 中覆盖：

```json
{
  "pdf": {
    "heading_confidence_threshold": 0.7,
    "table_grid_confidence_threshold": 0.65,
    "column_gap_ratio": 0.2,
    "paragraph_line_spacing_factor": 1.5,
    "section_break_blank_factor": 3.0
  }
}
```

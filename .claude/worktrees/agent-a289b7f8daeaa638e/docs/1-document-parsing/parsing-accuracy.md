# 解析准确性保障

解析准确性决定后续检索和回答是否可信。这里的目标不是“尽量抽出文本”，而是让系统知道哪些内容抽得准、哪些内容不可靠。

## 准确性目标

| 指标 | 目标 |
|---|---|
| 可解析成功率 | 常规 Word / PPT / PDF ≥ 98% |
| 文本覆盖率 | 非扫描文档 ≥ 95% |
| 表格结构保留率 | Word / PPT 表格 ≥ 98%，规则型 PDF 表格 ≥ 85% |
| 页码 / slide 可追溯率 | ≥ 99% |
| 低质量解析拦截率 | 不可靠结果不得直接进入索引 |

## 质量评分

每次解析生成 `quality_score`，满分 1.0。低于 0.75 标记为 `parse_low_confidence`，低于 0.55 标记为 `parse_failed`。

```text
quality_score =
  0.30 * text_coverage_score
+ 0.20 * structure_score
+ 0.20 * table_score
+ 0.15 * order_score
+ 0.15 * noise_score
```

| 维度 | 检查方式 |
|---|---|
| `text_coverage_score` | 解析字符数和文件元数据 / 页数 / XML 节点数是否匹配 |
| `structure_score` | 标题、段落、列表、表格是否有合理层级和顺序 |
| `table_score` | 表格行列数、合并单元格、空行比例、表头识别置信度 |
| `order_score` | block 顺序是否稳定，是否出现大量坐标交叉或页码倒序 |
| `noise_score` | 乱码、重复页眉页脚、水印、异常空白、控制字符比例 |

## 格式级校验

### Word

- 校验 `docProps/app.xml` 中的段落数、页数、字数与解析结果是否大体一致。
- 校验 `w:tbl` 数量与 `document_tables` 数量一致。
- 校验 `w:p` 中的文本节点是否被全部消费。
- 对标题样式缺失的文档，记录推断来源，不把弱推断标题当作强结构。

### PPT

- 校验 slide 数量与 `ppt/presentation.xml` 中的关系一致。
- 每个 slide 至少生成一个 block 或被标记为空白页。
- 模板页脚、日期、页码等重复 shape 进入噪声候选，不进入正文。
- notes 解析失败不影响正文解析，但写入 warning。

### PDF

- 校验 PDF 页数和解析页数一致。
- 同页文本坐标应处于页面 bbox 内。
- 对每页字符数突变、重复行比例过高、乱码比例过高的页面打 warning。
- 若整份 PDF 几乎无文本层，标记为 `scanned_pdf_no_text_layer`，等待 OCR 增强。

## 页眉页脚与噪声过滤

页眉页脚过滤分两步：

1. 解析阶段只标记噪声候选，不删除。
2. Text Cleaning 阶段根据重复频率、位置和内容规则删除。

候选规则：

- 出现在超过 60% 页面相同位置的短文本。
- 内容为纯页码、日期、公司保密声明、文件路径。
- PPT 中来自 master/layout 且每页重复的 shape。

这样可以避免把真正的章节标题误删。

## 表格准确性校验

表格解析后必须生成 `table_quality`：

| 字段 | 含义 |
|---|---|
| `header_confidence` | 表头识别置信度 |
| `grid_confidence` | 行列网格恢复置信度 |
| `merged_cell_count` | 合并单元格数量 |
| `empty_cell_ratio` | 空单元格比例 |
| `numeric_cell_ratio` | 数值单元格比例 |
| `warnings` | 异常信息 |

PDF 表格若 `grid_confidence < 0.65`，仍保存原始文本和候选行列，但不生成强结构化问答用的 table chunk，只生成普通段落 chunk 或低置信度 table chunk。

## 可追溯锚点

每个 block 必须有 `source_ref`：

| 格式 | 锚点 |
|---|---|
| DOCX | XML xpath、段落 index、table index |
| PPTX | slide index、shape id、paragraph index |
| PDF | page、bbox、text span index |

回答引用时使用 `chunk -> block -> source_ref -> original file` 的链路回到原文。

## 解析差异检测

同一文档重处理时保留版本差异：

- `file_sha256` 不变但 parser version 变化：比较 block 数、字符数、表格数。
- `file_sha256` 变化：视为新文档版本。
- 差异超过阈值时标记 `parse_diff_large`，提醒管理员检查。

阈值建议：

| 项目 | 阈值 |
|---|---|
| 总字符数变化 | > 10% |
| block 数变化 | > 15% |
| 表格数变化 | > 1 张或 > 10% |
| 页码变化 | > 1 页 |

## 错误与降级

| 错误 | 处理 |
|---|---|
| 文件损坏 | `parse_failed`，提示重新上传 |
| 加密 PDF | `parse_failed`，错误码 `encrypted_pdf` |
| 扫描 PDF | `parse_low_confidence`，等待 OCR |
| Word / PPT XML 不完整 | 尝试读取可恢复节点，低置信度落库 |
| 单页超大表格 | 保存表格原始结构，chunk 延迟到表格专用策略 |

低置信度解析不会进入默认检索索引，除非管理员手动确认。

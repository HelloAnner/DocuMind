# 解析框架与流程

本文档定义 Word、PPT、PDF 的解析逻辑、框架选型和统一输出结构。

## 总体流程

```text
Upload API
  -> 保存原始文件
  -> 创建 parse job
  -> 识别文件类型
  -> 调用格式 Parser
  -> 生成 ParsedDocument
  -> 写入 document_parse_results / document_blocks / document_tables
  -> 质量校验
  -> 成功进入 Text Cleaning
```

解析任务由异步 worker 执行。上传接口只负责落原文件和创建任务，不在请求线程内完成解析。

整体技术架构、框架选型、链式设计见 [DocuMind 技术架构总览](../tech.md)。本文档聚焦解析流程和格式-specific 逻辑。

## 文件识别

文件类型必须同时检查：

- 上传声明的 MIME type
- 文件扩展名
- 文件头或压缩包内部结构

判断规则：

| 类型 | 校验方式 |
|---|---|
| PDF | 文件头以 `%PDF-` 开始 |
| DOCX | zip 包含 `word/document.xml` |
| PPTX | zip 包含 `ppt/presentation.xml` 和 `ppt/slides/slide*.xml` |

若三者不一致，文件状态置为 `parse_failed`，错误码为 `file_type_mismatch`，不继续解析。

## Word 解析逻辑

DOCX 本质是 OpenXML zip 包。解析时读取：

- `word/document.xml`：正文段落、标题、表格、列表
- `word/styles.xml`：标题样式、正文样式
- `word/numbering.xml`：有序 / 无序列表编号
- `word/_rels/document.xml.rels`：图片、附件等关系
- `word/header*.xml` / `word/footer*.xml`：页眉页脚候选噪声
- `docProps/core.xml` / `docProps/app.xml`：作者、标题、页数等元数据

Word block 生成规则：

| OpenXML 节点 | 输出 block |
|---|---|
| `w:p` 且样式为 heading | `heading` |
| `w:p` 普通正文 | `paragraph` |
| `w:p` 带 numbering | `list_item` |
| `w:tbl` | `table` + `document_tables` |
| 脚注 / 尾注 | `footnote` |

标题层级从 `styles.xml` 中的 `Heading 1` 到 `Heading 6` 推断。若没有标准标题样式，则用字体大小、加粗、段前段后间距作为弱推断，并在 block metadata 中记录 `heading_confidence`。

## PPT 解析逻辑

PPTX 解析以 slide 为最小页面单位：

- 读取 `ppt/presentation.xml` 获取 slide 顺序
- 读取 `ppt/slides/slideN.xml` 获取文本框、表格、图片占位
- 读取 `ppt/notesSlides/notesSlideN.xml` 获取演讲者备注
- 读取 `ppt/slideLayouts` 和 `ppt/slideMasters` 辅助识别标题区、页脚和模板噪声

PPT block 生成规则：

| 内容 | 输出 block |
|---|---|
| slide 标题占位符 | `heading`，level 固定为 1 或 2 |
| 普通文本框 | `paragraph`，带 shape 坐标 |
| 项目符号 | `list_item` |
| slide 表格 | `table` + `document_tables` |
| speaker notes | `slide_note` |

同一 slide 内读取顺序按 `y -> x` 坐标排序，但标题占位符优先。多栏布局会根据横向间隔和重叠区间推断列，再按列内 `y` 排序。

## PDF 解析逻辑

PDF 没有稳定的逻辑结构，解析策略分两层：

1. **文本层提取**：使用 `pdf-extract` 提取页面文本，得到基础文本和页码。
2. **布局层分析**：使用 `lopdf` 读取 text operators 和坐标，恢复文本块、行、列、表格候选区域。

PDF block 生成规则：

| 识别结果 | 输出 block |
|---|---|
| 字号明显更大 / 居中 / 加粗的短文本 | `heading` |
| 连续文本行合并 | `paragraph` |
| 带项目符号、编号前缀 | `list_item` |
| 表格区域 | `table` + `document_tables` |
| 重复页眉页脚 | 标记为 `header_footer`，默认不进入清洗后正文 |

PDF 解析必须保留 page coordinate：

```json
{
  "page": 3,
  "bbox": { "x0": 72.1, "y0": 120.4, "x1": 520.2, "y1": 168.9 },
  "rotation": 0
}
```

后续引用定位可以用页码 + bbox 高亮原文区域。

## 统一 Block Schema

```json
{
  "block_id": "uuid",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "block_index": 23,
  "block_type": "paragraph",
  "text": "本季度重点关注...",
  "normalized_text": null,
  "heading_level": null,
  "heading_path": ["年度策略", "区域计划"],
  "page_start": 5,
  "page_end": 5,
  "slide_index": null,
  "table_id": null,
  "bbox": null,
  "source_ref": {
    "format": "docx",
    "xpath": "/w:document/w:body/w:p[23]"
  },
  "metadata": {
    "style": "Normal",
    "language": "zh-CN"
  }
}
```

## 状态机

| 状态 | 含义 |
|---|---|
| `uploaded` | 原文件已保存，等待解析 |
| `parsing` | 解析 worker 正在处理 |
| `parsed` | 结构解析完成，等待清洗 |
| `parse_low_confidence` | 解析完成但质量不达标，需要人工或备用策略 |
| `parse_failed` | 解析失败 |
| `cleaned` | 清洗完成 |
| `chunked` | 切割完成 |
| `indexed` | 向量和全文索引完成 |

解析任务必须可重试。重试会生成新的 `parse_job_id` 和 `parse_version`，不会覆盖旧版本。

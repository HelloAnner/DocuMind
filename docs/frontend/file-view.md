# DocuMind FileView 组件设计

本文档定义 DocuMind 右侧原文预览组件 `FileView` 的架构、协议和各格式渲染策略。

## 1. 设计原则

1. **FileView 只消费后端 anchor，不做全文搜索定位。**
   前端禁止用 `indexOf(quote)` 去正文里找位置。

2. **同一个文件多条 citation 切换时，不重新加载文件，只更新 active highlight。**

3. **高亮失败必须显示状态。**
   例如“只能定位到第 5 页”“只能定位到段落附近”，不能静默展示错误片段。

4. **所有坐标都按归一化坐标存储，前端根据当前缩放和旋转转换成屏幕坐标。**

5. **文档原文 URL 不暴露 MinIO 内部地址。**
   当前已支持 `/api/files/{doc_id}/preview-url` 返回带 `preview_token` 的短期 API 代理 URL；预览端使用 `/api/files/{doc_id}/preview/*` 访问 manifest、content 和 page PDF，不直接接触对象存储地址。

## 2. 组件结构

```text
<FileViewShell>
  <FileToolbar />            <!-- 缩放、旋转、页码、下载 -->
  <FileMetaBar />            <!-- 文件名、当前页/slide、总页数 -->
  <CitationStatus />         <!-- 当前定位状态：exact / page_only / unavailable -->
  <ViewerRouter>
    <PdfViewer />
    <OfficePdfPreviewViewer />
    <PptSlideViewer />
    <TextSourceViewer />
    <MarkdownSourceViewer />
  </ViewerRouter>
  <HighlightOverlay />       <!-- 统一高亮层，按 anchor 绘制 -->
  <PageThumbnailRail />      <!-- 可选：页缩略图导航 -->
</FileViewShell>
```

## 3. FileView 打开协议

前端只认这一种输入：

```ts
type FileViewOpenInput = {
  docId: string
  parseJobId: string
  fileName: string
  format: "pdf" | "docx" | "pptx" | "md" | "txt"
  previewUrl: string        // 当前为带 preview_token 的短期 API 代理 URL
  manifestUrl: string        // 页面尺寸、旋转、页数、预览类型等
  initialLocation: SourceAnchor
  highlights: SourceAnchor[]
}
```

### 3.1 Manifest 契约

```json
{
  "doc_id": "doc_001",
  "parse_job_id": "parse_001",
  "preview_type": "pdf",
  "page_count": 12,
  "pages": [
    {
      "page": 1,
      "width": 595.28,
      "height": 841.89,
      "rotation": 0,
      "text_layer_available": true
    }
  ]
}
```

### 3.2 SourceAnchor 消费

```ts
type SourceAnchor = {
  anchor_id: string
  parse_job_id: string
  format: "pdf" | "docx" | "pptx" | "md" | "txt"
  kind: "text_span" | "paragraph" | "table_cell_range" | "slide_shape" | "image_caption"
  page?: number
  slide?: number
  block_id?: string
  table_id?: string
  cell_range?: { row_start: number; row_end: number; col_start: number; col_end: number }
  char_range?: { start: number; end: number }
  bbox?: {
    x0: number
    y0: number
    x1: number
    y1: number
    unit: "normalized" | "pt"
    rotation: number
  }
  location_status: "exact" | "structural_only" | "page_only" | "slide_only" | "unavailable"
}
```

## 4. 各格式渲染策略

### 4.1 PDF Viewer

技术选型：**PDF.js + 自研 Highlight Layer**

当前实现已通过浏览器 smoke 验证：点击 OCR/PDF citation 后，右侧 FileView 能渲染 PDF canvas、bbox overlay、目标页 ready 状态和精确定位文案。后端 PDF bbox 仍主要受段落级 anchor 精度限制，text-run/word 级 bbox 属于后续增强。

渲染流程：

```text
加载 manifest
  -> 按 previewUrl 加载 PDF
  -> 渲染目标 page 到 canvas
  -> 在 canvas/text layer 上叠加 HighlightOverlay
  -> 根据 anchor.bbox 绘制高亮框
  -> 滚动到高亮区域
```

坐标转换：

```ts
const pdfRect = [
  anchor.bbox.x0 * pageWidth,
  anchor.bbox.y0 * pageHeight,
  anchor.bbox.x1 * pageWidth,
  anchor.bbox.y1 * pageHeight,
]

const viewportRect = viewport.convertToViewportRectangle(pdfRect)
drawHighlight(viewportRect)
```

定位优先级：

1. `anchor.bbox`（归一化坐标 -> 页面像素 -> viewport 坐标）。
2. `anchor.source_ref.text_run_ids` 重新计算 bbox。
3. `page + char_range` 在同页文本层模糊校验后定位。
4. 只跳页不高亮，标记 `location_status = page_only`。

### 4.2 Office / DOCX Preview

Word 原文件没有稳定页码坐标，必须先生成预览版本。当前后端已能用 LibreOffice 把 DOCX/PPTX 转为 PDF 并通过 manifest/content/page PDF 端点预览；结构节点到转换后 PDF bbox 的精确映射仍未完成。

```text
DOCX / PPTX 原文件
  -> 后台生成预览版本：PDF 或 page-image + text layer
  -> 同时保存结构节点到预览页面 bbox 的映射
  -> 前端 FileView 打开预览版本
  -> 根据 anchor 高亮 page + bbox / slide + shape / paragraph node
```

定位优先级：

1. `rendered_page + bbox`（转换后页面坐标）。
2. `source_ref.xpath + paragraph/table/cell index`（结构节点高亮）。
3. `block_id + char_range`（在对应 block 内高亮）。
4. 只打开文件并定位到段落附近，标记 `location_status = structural_only`。

### 4.3 PPT Preview

PPT 以 slide 和 shape 为主定位方式：

```text
slide_number + shape_id + bbox
```

表格要能定位到 cell range，而不是只跳到整页 slide：

```json
{
  "format": "pptx",
  "kind": "table_cell_range",
  "slide": 8,
  "source_ref": {
    "shape_id": "rId12",
    "table_id": "tbl_01",
    "cell_range": { "row_start": 2, "row_end": 3, "col_start": 1, "col_end": 2 }
  },
  "bbox": { "x0": 0.31, "y0": 0.44, "x1": 0.62, "y1": 0.53 }
}
```

### 4.4 Markdown / TXT Viewer

使用 CodeMirror 6 或 Monaco 打开原文件：

- 根据 `char_range` 滚动到对应位置。
- 高亮对应字符范围。
- 若文件过大，使用虚拟滚动。

## 5. HighlightOverlay 设计

统一高亮层负责在所有 viewer 上绘制高亮框：

```ts
type HighlightProps = {
  anchors: SourceAnchor[]
  activeAnchorId: string
  onAnchorClick?: (anchor: SourceAnchor) => void
}
```

绘制规则：

- active anchor 用高对比色 + 描边 + 轻微阴影。
- 非 active 用半透明色。
- bbox 区域在 viewport 变化时重新计算。
- 高亮失败时显示 `CitationStatus` 提示。

## 6. CitationStatus 组件

根据 `location_status` 显示不同状态：

| 状态 | UI 提示 |
|---|---|
| `exact` | 已高亮原文位置 |
| `structural_only` | 已定位到段落/表格，无法精确高亮区域 |
| `page_only` | 只能定位到第 N 页 |
| `slide_only` | 只能定位到第 N 张幻灯片 |
| `unavailable` | 来源不可用（已删除/无权限/版本失效） |

## 7. 状态管理

```ts
interface FileViewState {
  docId: string
  parseJobId: string
  format: FileFormat
  manifest: Manifest | null
  highlights: SourceAnchor[]
  activeAnchorId: string | null
  scale: number
  rotation: number
  currentPage: number
  status: 'loading' | 'ready' | 'error' | 'unavailable'
}
```

## 8. 性能优化

- 大 PDF 分页懒加载，只渲染可视页 + 前后缓冲页。
- manifest 缓存，避免重复请求。
- 同一文件切换 citation 时不重新加载 PDF，只更新 active highlight。
- 使用 TanStack Virtual 处理大引用列表和缩略图。

## 9. 错误处理

| 错误 | 处理 |
|---|---|
| manifest 加载失败 | 显示“预览信息加载失败”，提供重试 |
| PDF 加载失败 | 显示“文件加载失败”，检查 API 代理响应或 preview_token 是否过期 |
| anchor 格式不兼容 | 降级为 `page_only` 或 `structural_only` |
| bbox 越界 | 记录错误，只跳页 |
| 无权限 | 显示“无权限查看来源” |

## 10. 相关文档

- [引用定位与原文预览设计](../9-answer-generation/citation-location-preview.md)
- [Citation Resolver 详细设计](../9-answer-generation/citation-resolver.md)
- [DocuMind 技术架构总览](../tech.md)

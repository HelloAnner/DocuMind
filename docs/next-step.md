i下面是基于你上传的 `docs.zip` 和当前主流技术选型整理的系统优化建议。核心判断是：**你现在体验差的根因不是单纯“前端组件不好”，而是定位链路设计错了**。如果继续让前端拿 `quote` 去正文里 `indexOf`，即使换再好的 PDF/Office 组件，也会出现定位漂移、重复引用、表格定位不准、Word/PPT 页码不稳定等问题。

## 1. 总体结论：不要先大换框架，先重构“原文锚点链路”

你们现有文档里已经规划了 Rust + axum + tokio、Next.js 静态导出、PostgreSQL、Elasticsearch、Redis、RabbitMQ、MinIO 这一套。这个基础架构不用立刻推倒重来，真正需要优先改的是：

**从“chunk 文本定位”改成“解析期生成 SourceAnchor，问答期返回 Anchor，前端只负责渲染 Anchor”。**

也就是说：

```text
错误路线：
检索 chunk -> 生成 quote -> 前端 indexOf(quote) -> 尝试滚动/高亮

正确路线：
解析文档 -> 生成 page/slide/block/bbox/char_range/source_ref
          -> chunk 只携带 anchor_ids
          -> 回答生成后 CitationResolver 选择真正支撑 claim 的 anchor
          -> API 返回 anchor
          -> FileView 按 anchor 跳页、滚动、高亮
```

这条链路改完后，前端组件才有意义。否则组件只是把错误定位渲染得更漂亮。

---

## 2. 前端组件建议

### 2.1 前端主框架：保留 Next.js + React + TypeScript

如果你们现在已经是 Next.js 静态导出并嵌入 Rust 二进制，这个方案可以继续。Next.js 官方静态导出适合从静态站点或 SPA 起步，再根据需要升级到服务端特性；你们这种“Rust 统一对外服务 + 前端静态资源嵌入”的部署形态是合理的。需要注意的是，文档预览、PDF 渲染、SSE 流式聊天这些页面都应作为 client component 动态加载，不要依赖 Next server action。([Next.js][1])

建议的前端基础栈：

| 场景                  | 推荐                                    |
| ------------------- | ------------------------------------- |
| UI 组件               | shadcn/ui + Radix + Tailwind          |
| 服务端状态               | TanStack Query                        |
| 聊天消息、引用列表、大文档目录虚拟滚动 | TanStack Virtual                      |
| 轻量全局状态              | Zustand 或 Jotai                       |
| 流式问答                | 原生 EventSource / fetch stream 封装      |
| 文本/Markdown 原文预览    | CodeMirror 6 或 Monaco                 |
| PDF 原文预览            | PDF.js 自研封装优先                         |
| Office 原文预览         | 优先转 PDF 预览；需要在线编辑再接 OnlyOffice/商业 SDK |

TanStack Virtual 适合大量滚动 DOM 节点的虚拟化渲染，适用于聊天历史、引用卡片、目录、页缩略图等场景。([TanStack][2]) shadcn/ui 更适合作为设计系统基础，它是可复制、可改造的组件集合，不会把你绑死在黑盒组件里。([Shadcn][3])

---

### 2.2 PDF 预览组件：优先 PDF.js + 自定义 Highlight Layer

**推荐优先级：**

| 优先级 | 方案                                    | 适用情况                                    |
| --: | ------------------------------------- | --------------------------------------- |
|   1 | PDF.js + 自研 FileView/HighlightLayer   | 最适合你们这种“后端返回 bbox，前端精准高亮”的场景            |
|   2 | react-pdf-highlighter / extended fork | MVP 可用，但后期复杂定位、缩放、旋转、多页缓存仍可能要改源码        |
|   3 | Apryse WebViewer / Nutrient Web SDK   | 企业版、预算充足、要求 Office/PDF/批注/签名/权限/可访问性一体化 |
|   4 | 浏览器 iframe / 原生 PDF viewer            | 不建议，无法稳定控制坐标和高亮                         |

PDF.js 是浏览器端 PDF 渲染事实标准之一，官方示例支持作为浏览器库使用。你们需要的是对页面、缩放、旋转、文本层、canvas 层和自定义高亮层的完全控制，因此不要只把 PDF 塞进 iframe。([Mozilla GitHub][4])

如果用开源 React 组件，`react-pdf-highlighter` 这类库本身基于 PDF.js，支持文本/图片高亮、popover、滚动到高亮，适合快速验证；但你们的核心高亮应来自后端 `bbox/quads`，不是用户在前端选择文本后生成的 highlight。([GitHub][5])

如果你们预算充足、希望少踩 Office/PDF 渲染坑，可以评估 Apryse WebViewer 或 Nutrient Web SDK。Apryse WebViewer 官方定位是 JavaScript 文档 SDK，支持 PDF、Office、图片等格式的查看、批注、编辑。([apryse-docs][6]) Nutrient Web SDK 也是企业级 JavaScript PDF/文档 SDK，支持浏览器内查看、批注、编辑 PDF，并提供 Word、Excel、PowerPoint、图片等格式的 viewer 能力。([Nutrient][7])

我的建议是：**先用 PDF.js 自研 FileView，把 anchor 链路打通；等产品商业化、Office 高保真要求变高后，再评估 Apryse/Nutrient。**

---

### 2.3 Office 文档预览：不要直接显示解析文本

Word/PPT 的定位问题比 PDF 更麻烦。Word 原文件没有稳定页码，PPT 有 slide 和 shape 但浏览器原生没有标准 viewer。因此建议：

```text
DOCX / PPTX 原文件
  -> 后台生成预览版本：PDF 或 page-image + text layer
  -> 同时保存结构节点到预览页面 bbox 的映射
  -> 前端 FileView 打开预览版本
  -> 根据 anchor 高亮 page + bbox / slide + shape / paragraph node
```

OnlyOffice Docs 适合需要在线 Office 查看、编辑、协作的场景，它官方提供文档、表格、演示、PDF、表单等在线编辑器/查看器能力。([ONLYOFFICE API][8]) 但如果你的目标只是“问答引用精准定位”，**把 Office 统一转成 PDF page view + anchor mapping，通常比直接嵌 Office 编辑器更可控**。

---

## 3. FileView 应该怎么设计

你现在的右侧预览不要叫“chunk preview”，应该升级成一个统一的 `FileView`。

### 3.1 前端组件结构

```text
<FileViewShell>
  <FileToolbar />
  <FileMetaBar />
  <CitationStatus />
  <ViewerRouter>
    <PdfViewer />
    <OfficePdfPreviewViewer />
    <PptSlideViewer />
    <TextSourceViewer />
    <MarkdownSourceViewer />
  </ViewerRouter>
  <HighlightOverlay />
  <PageThumbnailRail />
</FileViewShell>
```

关键点：

1. **FileView 只消费后端 anchor，不做全文搜索定位。**
2. 同一个文件多条 citation 切换时，不重新加载文件，只更新 active highlight。
3. 高亮失败必须显示状态，比如“只能定位到第 5 页”“只能定位到段落附近”，不能静默展示错误片段。
4. 所有坐标都按原始页面坐标或归一化坐标存储，前端根据当前缩放和旋转转换成屏幕坐标。
5. 文档原文 URL 用短期签名 URL，不要把 MinIO 内部地址暴露给浏览器。

### 3.2 FileView 打开协议

建议前端只认这一种输入：

```ts
type FileViewOpenInput = {
  docId: string
  parseJobId: string
  fileName: string
  format: "pdf" | "docx" | "pptx" | "md" | "txt"
  previewUrl: string
  manifestUrl: string
  initialLocation: SourceAnchor
  highlights: SourceAnchor[]
}
```

`manifestUrl` 返回页面尺寸、旋转、页数、预览类型、可用文本层、权限状态等信息：

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

---

## 4. 原文定位算法：从 quote 定位改成 anchor 定位

### 4.1 统一 SourceAnchor

你们文档里已经有 `SourceAnchor` 思路，我建议把它变成系统硬契约，而不是后续优化项。

```json
{
  "anchor_id": "uuid",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "format": "pdf",
  "kind": "text_span",
  "page": 3,
  "slide": null,
  "block_id": "uuid",
  "table_id": null,
  "cell_range": null,
  "char_range": { "start": 128, "end": 196 },
  "bbox": {
    "x0": 0.121,
    "y0": 0.276,
    "x1": 0.812,
    "y1": 0.315,
    "unit": "normalized",
    "rotation": 0
  },
  "source_ref": {
    "pdf_text_run_ids": ["run_0031", "run_0032"]
  },
  "text_hash": "sha256..."
}
```

我建议 `bbox` 默认存归一化坐标，而不是直接存像素：

```text
x0 = raw_x0 / page_width
y0 = raw_y0 / page_height
x1 = raw_x1 / page_width
y1 = raw_y1 / page_height
```

这样前端在缩放、旋转、不同 DPR 屏幕、canvas 重绘时不会漂移。

### 4.2 PDF 定位

PDF 解析阶段应抽取：

```text
page
text_run_id
text
bbox
font_size
rotation
block_id
line_id
char_range
```

PyMuPDF 的 `Page.get_text("blocks")` 和 `Page.get_text("words")` 可以返回带位置信息的文本块和单词，用于构建这类 anchor；它的文档也提醒普通文本抽取顺序未必等于自然阅读顺序，因此还需要按坐标和版面恢复阅读顺序。([PyMuPDF 文档][9])

前端高亮时：

```ts
// 伪代码
const pdfRect = [
  anchor.bbox.x0 * pageWidth,
  anchor.bbox.y0 * pageHeight,
  anchor.bbox.x1 * pageWidth,
  anchor.bbox.y1 * pageHeight,
]

const viewportRect = viewport.convertToViewportRectangle(pdfRect)
drawHighlight(viewportRect)
```

PDF.js 的 PageViewport 坐标转换适合把 PDF 坐标转换成浏览器 viewport 坐标；实现时要特别处理 PDF 坐标系和浏览器坐标系方向、旋转、CropBox/MediaBox 差异。([Nutrient][10])

### 4.3 Word 定位

Word 不要依赖页码，应使用双锚点：

```text
结构锚点：OpenXML paragraph/table/cell path
视觉锚点：转换后的 preview page + bbox
```

建议解析时保存：

```json
{
  "source_ref": {
    "docx": {
      "paragraph_index": 128,
      "run_index_range": [2, 5],
      "table_index": null,
      "row": null,
      "col": null,
      "xpath": "/w:document/w:body/w:p[128]"
    }
  },
  "render_ref": {
    "preview_page": 5,
    "bbox": { "x0": 0.13, "y0": 0.21, "x1": 0.78, "y1": 0.26 }
  }
}
```

没有转换布局时，至少能定位到段落；有转换布局时，再高亮 bbox。

### 4.4 PPT 定位

PPT 定位主键应该是：

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
    "cell_range": {
      "row_start": 2,
      "row_end": 3,
      "col_start": 1,
      "col_end": 2
    }
  },
  "bbox": { "x0": 0.31, "y0": 0.44, "x1": 0.62, "y1": 0.53 }
}
```

---

## 5. 后端框架建议

### 5.1 Rust + axum 可以保留

你们现在 Rust + axum + tokio 的方向适合做：

```text
鉴权 / 租户 / 权限过滤
文档元数据
对话与 SSE
检索 API
CitationResolver
文件预览签名 URL
异步任务调度入口
统一部署
```

Rig 作为 Rust LLM 抽象层也可以继续用。Rig 官方定位是 Rust 中构建 portable、modular、lightweight AI agents 的库，支持 completion、embedding、provider 抽象等能力。([Rig][11])

但我不建议把所有文档解析和 OCR 都强行留在 Rust。原因不是 Rust 不行，而是**文档智能生态目前 Python 工具更丰富，模型、OCR、layout、table 相关能力迭代更快**。

### 5.2 建议增加一个可选的 Python Document Intelligence Worker

推荐架构：

```text
Rust API / Orchestrator
  -> RabbitMQ / Temporal
  -> Python doc-intel-worker
       - Docling
       - PyMuPDF
       - OCR
       - layout/table model
       - anchor generation
  -> ParsedDocument JSON
  -> PostgreSQL + MinIO + Elasticsearch
```

Docling 官方支持 PDF、DOCX、PPTX、XLSX、HTML、Markdown、图片等多格式解析，并提供统一的 DoclingDocument 表示、PDF layout、reading order、table structure 等能力。([docling-project.github.io][12]) 对你们这种企业资料问答系统，建议把它作为候选 parser worker，而不是完全依赖 `pdf-extract + lopdf + quick-xml` 自研所有版面算法。

这不是“后端改 Python”，而是：

```text
Rust 负责产品系统与强类型业务主链路
Python 负责文档智能/模型生态适配
两者用 JSON contract 隔离
```

### 5.3 Agent 编排：自研状态机优先，复杂 Agent 再考虑 LangGraph

你们是企业文档问答，不是开放式自主 Agent。当前应优先保证：

```text
可控
可审计
可回放
可解释
可权限过滤
可拒答
```

因此 `documind-agent` 自研强类型状态机是合理的。LangGraph 适合在后续出现复杂多步骤 Agent、人审中断、长期状态、可恢复执行时引入；它官方定位包含 durable execution、streaming、human-in-the-loop、persistence 等能力。([LangChain文档][13])

建议不是替换，而是：

```text
普通 RAG 问答：自研状态机
复杂研究任务 / 多知识库规划 / 人审流程：LangGraph 或独立 workflow service
```

### 5.4 异步任务：RabbitMQ 可继续，复杂长流程再上 Temporal

RabbitMQ 适合你们现在的解析、清洗、切片、embedding 队列。要补的是：

```text
幂等键
重试次数
死信队列
任务状态表
任务可重放
任务版本
```

RabbitMQ 支持 dead-letter exchange，消息在拒绝、过期、超过队列长度等场景可以被 dead-letter 到其他 exchange。([RabbitMQ][14])

如果后续文档处理变成长链路：

```text
上传 -> 病毒扫描 -> 解密 -> 转换 -> OCR -> layout -> table -> chunk -> embedding -> index -> preview
```

并且需要跨天恢复、可视化每一步、失败后从中间继续，那就评估 Temporal。Temporal 的 Workflow Execution 官方定义是 durable、reliable、scalable 的函数执行单元，并且支持失败后的重试策略。([Temporal Docs][15])

---

## 6. 检索与向量存储建议

### 6.1 Elasticsearch 先保留

你们现在用 Elasticsearch 做 BM25 + dense vector + metadata filter + RRF，是合理的。Elasticsearch 官方 `dense_vector` 字段用于存储稠密向量并支持 kNN 搜索；RRF retriever 官方文档也给出了 lexical search + dense vector search 的 hybrid search 示例。([Elastic][16])

因此当前不建议马上引入 Milvus/Qdrant 再维护一套向量库，除非你们出现以下情况：

```text
向量规模非常大，ES HNSW 内存压力明显
需要复杂多向量/多模态检索
需要专门的 vector payload filtering 能力
ES 中文 BM25 和向量混合已经无法满足延迟/召回
```

Qdrant 也支持 dense + sparse 的 hybrid query 和 RRF，但如果你们仍然需要强 BM25、中文分词、文档字段检索，单独上 Qdrant 往往意味着还要继续保留 ES/OpenSearch。([Qdrant][17])

**推荐当前路线：继续 ES，先把 schema 和检索算法做好。**

### 6.2 ES 索引里要补 anchor 字段

ES chunk 文档建议增加：

```json
{
  "chunk_id": "chunk_001",
  "doc_id": "doc_001",
  "parse_job_id": "parse_001",
  "tenant_id": "tenant_001",
  "kb_id": "kb_001",
  "content": "...",
  "heading_path": ["制度", "报销"],
  "source_type": "paragraph",
  "page_range": { "gte": 3, "lte": 3 },
  "anchor_ids": ["anchor_001", "anchor_002"],
  "primary_anchor_id": "anchor_001",
  "anchor_quality": "bbox",
  "embedding": [...]
}
```

检索返回时必须带：

```json
{
  "chunk_id": "chunk_001",
  "score": 0.82,
  "content": "...",
  "anchor_refs": ["anchor_001", "anchor_002"],
  "primary_anchor": { "...": "..." }
}
```

---

## 7. RAG 流程优化建议

### 7.1 Ingest Pipeline

建议改成：

```text
Upload
  -> File Validate
  -> Parse
  -> SourceAnchor Generate
  -> Clean with Offset Mapping
  -> Block Normalize
  -> Chunk
  -> ChunkAnchorMap
  -> Embedding
  -> Index
  -> Preview Manifest
```

关键是 **Clean 阶段不能破坏定位映射**。清洗后的文本可以用于检索和生成，但定位必须回到原始 block/run/anchor。

你需要同时保存三份文本：

| 文本              | 用途                     |
| --------------- | ---------------------- |
| original_text   | 定位、校验、quote 溯源         |
| normalized_text | exact match、数字日期校验     |
| chunk_content   | embedding、BM25、LLM 上下文 |

### 7.2 Chunking 策略

不要只有固定 token chunk。建议多粒度：

```text
atomic chunk：段落、表格行、slide shape，适合精准引用
parent chunk：章节、表格、整页，适合提供上下文
summary chunk：长文档章节摘要，适合宽泛问题召回
table chunk：表头 + 行/列 + 单元格坐标
```

检索时：

```text
先召回 atomic/summary
再扩展 parent context
最终 citation 回到 atomic anchor
```

这样可以同时解决“召回需要上下文”和“引用需要精确位置”的矛盾。

### 7.3 Query Rewrite

建议把 query rewrite 做成可解释输出：

```json
{
  "intent": "fact_lookup | compare | summarize | table_lookup | policy_check",
  "rewritten_query": "...",
  "keywords": ["付款节点", "30%", "5个工作日"],
  "entities": ["Q3采购合同"],
  "numbers": ["30%", "5"],
  "date_constraints": [],
  "metadata_filters": {
    "kb_id": ["..."],
    "doc_type": "contract"
  },
  "sub_queries": []
}
```

数字、日期、金额、条款编号必须进入 BM25/keyword 侧，不要只靠 embedding。

### 7.4 Hybrid Search

你们已有 Dense + BM25 + RRF 思路，可以继续。需要补三点：

1. **权限和知识库范围必须 pre-filter**，不能检索后再过滤。
2. **数字/日期/条款编号给 BM25 更高权重**。
3. **同文档多 chunk 要做多样性控制**，避免 Top-20 都来自同一页附近。

Elasticsearch kNN 官方也提醒 approximate kNN/HNSW 对资源有要求，向量数据需要适配内存/page cache，否则性能会明显受影响。([Elastic][18])

### 7.5 Reranking

建议精排分成两层：

```text
语义精排：cross-encoder reranker
证据校验：entity/number/date/exact match verifier
```

模型选择可以这样：

| 场景           | 建议                                               |
| ------------ | ------------------------------------------------ |
| 中文/中英混合、本地部署 | BGE-M3 + bge-reranker-v2-m3                      |
| 国内云服务快速上线    | DashScope embedding/rerank                       |
| 国际化/多语言      | BGE-M3、multilingual embedding、OpenAI embedding 等 |
| 高准确引用校验      | reranker + entailment/LLM verifier               |

BGE-M3 官方介绍强调 multi-functionality、multi-linguality、multi-granularity；bge-reranker-v2-m3 是基于 bge-m3 的 multilingual reranker。([Hugging Face][19]) DashScope 的 `text-embedding-v4` 文档显示它支持多种维度配置，适合按成本和效果调参。([AlibabaCloud][20]) OpenAI embedding 也支持不同维度的 text-embedding-3-small/large。([OpenAI开发者][21])

---

## 8. Answer Generation 与 CitationResolver

当前很多 RAG 系统的问题是：**模型说了什么，就把 Top-K chunk 全挂成引用**。这会导致引用很多但不可信。

建议流程：

```text
Reranked Evidence
  -> Context Assembly
  -> LLM Answer Draft
  -> Claim Extractor
  -> CitationResolver
  -> CitationVerifier
  -> Final Answer + Citations
```

### 8.1 CitationResolver 规则

每个 claim 都要判断：

```text
这个 claim 是否需要引用？
候选 evidence 是否真的支撑 claim？
claim 中的数字/日期/金额/实体是否能在 evidence 中找到？
evidence 是否有可用 anchor？
用户是否有权限看该来源？
anchor 对应 parse_job 是否仍有效？
```

引用评分建议：

```text
citation_score =
  0.35 * entailment_score
+ 0.25 * rerank_score
+ 0.20 * exact_match_score
+ 0.15 * anchor_quality_score
+ 0.05 * freshness_score
```

数值类回答必须强校验：

```text
答案里出现 30%
原文里必须出现 30% 或等价表达
否则不能引用该 anchor
```

### 8.2 最终 CitationOutput

```json
{
  "index": 1,
  "doc_id": "doc_001",
  "doc_title": "采购合同.pdf",
  "source_status": "available",
  "quote": "合同签署后 5 个工作日内支付首付款 30%。",
  "score": 0.91,
  "anchor": {
    "anchor_id": "anchor_001",
    "parse_job_id": "parse_001",
    "format": "pdf",
    "kind": "text_span",
    "page": 5,
    "bbox": {
      "x0": 0.12,
      "y0": 0.34,
      "x1": 0.86,
      "y1": 0.38,
      "unit": "normalized"
    },
    "location_status": "exact"
  },
  "claim_refs": [
    {
      "claim_id": "claim_001",
      "answer_char_range": { "start": 12, "end": 38 }
    }
  ]
}
```

`location_status` 必须标准化：

| 状态              | 含义                            | 前端行为             |
| --------------- | ----------------------------- | ---------------- |
| exact           | 有 bbox / quads / shape / cell | 跳转并高亮            |
| structural_only | 有段落/表格/shape，无 bbox           | 滚动到结构块并框选        |
| page_only       | 只有页码                          | 跳页，提示只能定位到页      |
| slide_only      | 只有 slide                      | 跳 slide，提示只能定位到页 |
| unavailable     | 删除、无权限、版本失效                   | 禁止打开或脱敏展示        |

---

## 9. 数据库需要补的表

### 9.1 document_source_anchors

```sql
CREATE TABLE document_source_anchors (
  anchor_id UUID PRIMARY KEY,
  doc_id UUID NOT NULL,
  parse_job_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  format TEXT NOT NULL,
  kind TEXT NOT NULL,
  page INT,
  slide INT,
  block_id UUID,
  table_id UUID,
  cell_range JSONB,
  char_range JSONB,
  bbox JSONB,
  source_ref JSONB NOT NULL DEFAULT '{}',
  text TEXT NOT NULL DEFAULT '',
  text_hash TEXT,
  anchor_quality TEXT NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_source_anchors_doc_parse
ON document_source_anchors(doc_id, parse_job_id);

CREATE INDEX idx_source_anchors_block
ON document_source_anchors(block_id);

CREATE INDEX idx_source_anchors_tenant_doc
ON document_source_anchors(tenant_id, doc_id);
```

### 9.2 chunk_anchor_map

```sql
CREATE TABLE chunk_anchor_map (
  chunk_id UUID NOT NULL,
  anchor_id UUID NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (chunk_id, anchor_id)
);
```

`relation` 可以是：

```text
primary
covered
overlap
parent_context
table_header
```

### 9.3 conversation_citation_snapshots

历史回答必须保存当时的 anchor 快照：

```sql
CREATE TABLE conversation_citation_snapshots (
  citation_id UUID PRIMARY KEY,
  message_id UUID NOT NULL,
  doc_id UUID NOT NULL,
  parse_job_id UUID NOT NULL,
  anchor_id UUID,
  citation_index INT NOT NULL,
  quote TEXT,
  anchor_snapshot JSONB NOT NULL,
  claim_refs JSONB NOT NULL DEFAULT '[]',
  source_status TEXT NOT NULL,
  location_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

否则文档重新解析后，历史回答引用会失效或错位。

---

## 10. 评估与可观测性

你们要建立一套专门针对文档问答的评估，不只是看“答案像不像”。

### 10.1 必须评估的指标

| 层  | 指标                                                                  |
| -- | ------------------------------------------------------------------- |
| 解析 | parse_success_rate、layout_confidence、table_accuracy、anchor_coverage |
| 检索 | recall@k、MRR、nDCG@5、keyword_hit_rate、metadata_filter_correctness    |
| 精排 | rerank_ndcg@5、threshold_pass_rate、fallback_rate                     |
| 生成 | faithfulness、answer_relevancy、no_answer_accuracy                    |
| 引用 | citation_coverage、citation_precision、numeric_citation_accuracy      |
| 定位 | click_to_exact_highlight_rate、bbox_error、page_only_rate             |
| 前端 | preview_load_p95、highlight_render_p95、SSE_disconnect_rate           |

Ragas 提供面向 RAG 的组件级评估指标，例如 faithfulness、answer relevancy、context recall、context precision 等。([Ragas][22]) TruLens 的 RAG Triad 把评估拆成 context relevance、groundedness、answer relevance 三类，也适合你们做线上抽样评估。([TruLens][23])

### 10.2 Trace 设计

每次问答要能看到：

```text
query
rewrite output
metadata filter
dense top-k
bm25 top-k
RRF top-k
reranker input/output
LLM context
answer draft
claim list
citation resolver result
final citations
FileView click result
```

建议用 OpenTelemetry 做统一 trace。OpenTelemetry 官方定位是开源可观测性框架，提供统一的 API、库、agent、collector，用于采集分布式 traces 和 metrics。([OpenTelemetry][24])

---

## 11. 推荐落地顺序（可执行版）

下面把建议拆成 **5 个阶段、每个阶段有明确交付物、验收标准和下一步触发条件**。阶段之间不要跳：P0 不完成，P1 的 CitationResolver 没有可靠 anchor；P1 不完成，P2 的 Office 高亮没有高质量引用可测。

### 阶段 0：架构共识与文档对齐（1-2 天）

目标：让前后端对 `SourceAnchor -> CitationResolver -> FileView` 这条主链路有统一理解。

| 序号 | 任务 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| 0.1 | 团队确认 SourceAnchor 为系统硬契约 | 设计评审记录 | 前后端、产品一致认可 anchor 是引用定位唯一合法输入 |
| 0.2 | 更新所有相关设计文档 | `docs/tech.md`、`docs/1-document-parsing/*.md`、`docs/3-chunking/chunking.md`、`docs/9-answer-generation/*.md`、`docs/frontend/file-view.md` | 文档中禁止出现“前端用 quote indexOf 定位”的表述 |
| 0.3 | 定义 SourceAnchor JSON Schema | `schemas/source_anchor.json` 或 Rust struct | Schema 覆盖 pdf/docx/pptx/md/txt 五种格式 |
| 0.4 | 定义 API/SSE citation 输出契约 | OpenAPI / TS type 更新 | `CitationOutput` 必须包含 `anchor` 和 `location_status` |

**触发下一阶段条件**：设计评审通过，Schema 定稿。

### P0：打通“点击引用回原文”的主链路（2-3 周）

目标：PDF 文档点击 citation 后，右侧 FileView 能跳转到对应页并高亮 bbox。

| 序号 | 任务 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| P0.1 | 新增 `document_source_anchors` 表与 `chunk_anchor_map` 表 | SQL migration | 表结构符合 `docs/1-document-parsing/storage-model.md` |
| P0.2 | PDF Parser 输出 text_run + bbox | `ParsedDocument.anchors` + `document_source_anchors` 数据 | 抽样 PDF 的 anchor 覆盖率 ≥ 95%，bbox 覆盖率 ≥ 80% |
| P0.3 | `document_blocks` 绑定 `anchor_ids` | block 写入时附带 anchor 关联 | 每个 paragraph/table block 至少有一个 anchor |
| P0.4 | Chunk 携带 `anchor_ids` + `primary_anchor_id` | `Chunk` struct + DB + ES 索引更新 | ES `chunks` 索引有 `anchor_ids` / `primary_anchor_id` / `anchor_quality` |
| P0.5 | 检索返回 `anchor_refs` | `RetrievedChunk` 输出更新 | 每个检索结果都带 primary anchor |
| P0.6 | API/SSE 返回 `CitationOutput.anchor` | answer generation 输出更新 | citation 包含 anchor + location_status |
| P0.7 | 前端实现 PDF.js FileView | `apps/web/components/file-view` | 点击 citation 跳页 + 高亮 bbox，允许误差 ≤ 6pt |
| P0.8 | 禁止前端 `indexOf(quote)` 主定位 | 代码审查 + 删除相关逻辑 | `rg "indexOf.*quote" apps/web` 无命中 |
| P0.9 | 服务器端到端验证 | `make deploy` + 浏览器验收 | 用 3 份不同 PDF 测试，点击引用都能跳到正确页 |

**关键指标**：

- `click_to_exact_highlight_rate` ≥ 80%
- `page_only_rate` ≤ 15%

**触发下一阶段条件**：P0 验收用例全部通过，且服务器上真实 PDF 问答可稳定回原文。

### P1：提升引用质量（2-3 周）

目标：答案中的每个 citation 都真实支撑 claim，数字/日期类 citation 强校验。

| 序号 | 任务 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| P1.1 | 实现 Claim Extractor | `agent/claim_extractor` | 能把答案拆成 claim，并标记是否需要引用 |
| P1.2 | 实现 CitationResolver | `agent/citation_resolver` | 输出 citation 不再简单映射 Top-K evidence |
| P1.3 | 实现数值/日期/金额/实体校验器 | `agent/citation_verifier` | 数字类 citation 校验通过率 ≥ 95% |
| P1.4 | 实现 canonical anchor 去重与相邻合并 | resolver 内部去重逻辑 | 同一段原文只展示 1 条 citation |
| P1.5 | 低质量 citation 降级/删除 | 输出 `location_status` + 置信度 | 无 bbox 的 citation 显示对应状态提示 |
| P1.6 | 无证据 claim 改写 | prompt + 后处理 | 系统不再对无证据事实做确定性陈述 |
| P1.7 | 保存引用快照 | `conversation_citation_snapshots` 表 | 历史会话重新打开后引用仍指向当时的 parse_job |
| P1.8 | 服务器端到端验证 | 黄金问题集测试 | 10 条黄金问题中 citation 精确度 ≥ 85% |

**关键指标**：

- `citation_precision` ≥ 85%
- `numeric_citation_accuracy` ≥ 95%
- `duplicate_citation_rate` ≤ 5%

**触发下一阶段条件**：黄金问题集 citation 质量达标。

### P2：扩展 Office 与表格定位（2-3 周）

目标：DOCX / PPTX / Markdown / TXT 都能稳定回原文，表格能定位到 cell。

| 序号 | 任务 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| P2.1 | DOCX 生成 PDF preview + 结构节点映射 | `/api/files/{doc_id}/preview` | Word 段落点击后定位到正确页 |
| P2.2 | PPTX 生成 slide preview + shape 映射 | slide viewer | PPT shape 点击后高亮对应文本框 |
| P2.3 | 表格 cell-level anchor | `document_source_anchors.kind = table_cell_range` | 表格问题 citation 定位到单元格 |
| P2.4 | Markdown/TXT char offset 高亮 | text viewer | 点击引用滚动到正确字符位置 |
| P2.5 | FileView 支持 format router | `ViewerRouter` | 根据 format 自动切换 viewer |
| P2.6 | 服务器端到端验证 | 各格式样本文档测试 | DOCX/PPTX/MD/TXT 各 3 份样本能稳定回原文 |

**关键指标**：

- DOCX/PPTX `click_to_exact_highlight_rate` ≥ 70%
- 表格问题 citation 能定位到 cell range 的比例 ≥ 80%

**触发下一阶段条件**：Office 与表格定位基本可用。

### P3：解析质量与检索效果优化（3-4 周）

目标：用更高质量解析器和更优检索策略提升整体问答效果。

| 序号 | 任务 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| P3.1 | 引入可选 Python Document Intelligence Worker | `workers/doc-intel` + RabbitMQ 任务 | Worker 输出与 Rust Parser 同 Schema |
| P3.2 | PDF OCR fallback | OCR 任务 + 扫描件 anchor | 扫描件 PDF 能生成可定位 anchor |
| P3.3 | 多粒度 chunk（atomic/parent/summary/table） | chunker 更新 | 召回率与引用精度同时提升 |
| P3.4 | Hybrid search 参数调优 | 检索配置 + A/B 结果 | recall@5 提升 ≥ 5% |
| P3.5 | Reranker 阈值校准 | 阈值策略 | 低质量结果过滤合理 |
| P3.6 | 建立 golden dataset | `tests/golden/*.json` | 至少 50 条覆盖多格式的问题对 |
| P3.7 | 自动评估流水线 | evaluation job | 每次改动可跑通评估并输出指标 |
| P3.8 | 服务器端到端验证 | 评估报告 | golden set 上综合指标 ≥ 目标基线 |

**关键指标**：

- `recall@5` ≥ 90%
- `faithfulness` ≥ 85%
- `answer_relevancy` ≥ 85%

**触发下一阶段条件**：golden set 指标稳定达标。

### P4：企业级体验与运维（2-3 周）

目标：系统可灰度、可观测、可运维。

| 序号 | 任务 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| P4.1 | 预览 manifest 缓存 | Redis 缓存 + 失效策略 | 重复打开同一文档 preview 命中缓存 |
| P4.2 | 大 PDF 分页懒加载 | FileView 懒加载 | 100MB PDF 打开不卡死 |
| P4.3 | 文件预览签名 URL | `/api/files/{doc_id}/preview-url` | URL 含过期时间，不暴露 MinIO |
| P4.4 | 权限审计 | 管理后台 + 审计日志 | 可查看谁访问了哪份文档 |
| P4.5 | OpenTelemetry trace | trace 接入 | 每次问答可查看完整链路 |
| P4.6 | RabbitMQ 死信队列与重跑 | DLX + 重试任务 | 失败任务自动重试 3 次后入死信 |
| P4.7 | 评估 Temporal（可选） | 调研报告 | 若解析链路超过 8 步且需跨天恢复，给出决策 |
| P4.8 | 灰度上线与观察 | 灰度方案 + 观察清单 | 内部 3-5 用户试用 1 周无 P0 故障 |

**关键指标**：

- `preview_load_p95` ≤ 2s
- `highlight_render_p95` ≤ 500ms
- 死信任务比例 ≤ 0.1%

## 12. 落地检查清单（每条任务开始前自问）

1. 这条改动是否影响 `SourceAnchor` 结构？如果是，先更新 Schema 和文档。
2. 这条改动是否让前端重新用 `indexOf(quote)` 定位？如果是，重新设计。
3. 这条改动是否让 citation 更简单或更可信？如果不是，说明价值。
4. 这条改动是否能在 `ssh documind` 上验证？如果不能，补充验收路径。
5. 这条改动是否需要更新黄金问题集？如果是，同步更新。

## 13. 推荐首次冲刺（Sprint 0：2 周）

如果你现在就要开干，建议前两周只做这 5 件事：

1. **Day 1-2**：对齐 Schema。`SourceAnchor` JSON Schema + DB 表 + TS type 定稿。
2. **Day 3-5**：让 PDF Parser 输出 anchor。先用最小改动在 `pdf-extract`/`lopdf` 链路里把 page + bbox 跑通。
3. **Day 6-7**：让 chunk 携带 `anchor_ids`，并写入 ES。
4. **Day 8-10**：让 API 在 citation 里返回 `anchor`（即使前端还没高亮）。
5. **Day 11-14**：前端接 PDF.js，实现点击 citation 跳页 + 画 bbox。

Sprint 0 结束的标志：在服务器上打开一个 PDF 问答，点击引用，右侧 FileView 高亮命中区域。

## 14. 需要避开的坑

| 坑 | 为什么 | 怎么做 |
|---|---|---|
| 先把 PDF 组件换成商业 SDK | 根因是定位链路，不是组件 | 先用 PDF.js 自研 FileView 打通 anchor 链路 |
| 继续让前端 indexOf(quote) | 清洗/overlap/版式会导致漂移 | 后端必须返回 anchor，前端只渲染 |
| 一开始就做全格式完美定位 | 应先把 PDF 主线跑通 | P0 只做 PDF，P2 再做 Office |
| 把 CitationResolver 做成纯规则 | 初期规则可行，但要预留 LLM 升级接口 | 第一版规则 + 轻量模型，后续接 entailment |
| 忽略历史回答引用快照 | 重新解析后历史回答会失效 | P1 必须实现 `conversation_citation_snapshots` |
| 在本地启动服务验证 | 本地与生产环境差异大 | 所有验收都在 `ssh documind` 上执行 |

---

## 15. 最终推荐技术组合

结合你们当前项目，我建议这样定：

| 层             | 建议                                         |
| ------------- | ------------------------------------------ |
| 前端框架          | 保留 Next.js + React + TypeScript            |
| UI            | shadcn/ui + Radix + Tailwind               |
| 数据请求          | TanStack Query                             |
| 大列表/聊天/引用虚拟滚动 | TanStack Virtual                           |
| PDF 预览        | PDF.js + 自研 FileView/HighlightLayer        |
| Office 预览     | 后端转 PDF/page preview；需要编辑时接 OnlyOffice     |
| 商业文档 SDK 备选   | Apryse WebViewer 或 Nutrient Web SDK        |
| 后端 API        | 保留 Rust + axum + tokio                     |
| LLM 抽象        | 继续 Rig + OpenAI-compatible adapter         |
| 文档智能 worker   | 增加可选 Python worker：Docling / PyMuPDF / OCR |
| 权威数据          | PostgreSQL                                 |
| 检索            | 继续 Elasticsearch hybrid search             |
| 缓存            | Redis                                      |
| 异步队列          | RabbitMQ；长流程复杂后评估 Temporal                 |
| 对象存储          | MinIO                                      |
| 评估            | Ragas / TruLens 思路 + 自建 golden set         |
| 可观测性          | OpenTelemetry trace + 业务指标                 |

最关键的一句话：**先不要把“引用定位”当成前端问题，它是解析、chunk、检索、生成、引用校验、前端预览共同遵守的数据契约问题。**

下一步最值得做的是把 `SourceAnchor -> CitationResolver -> FileView` 这条链路做成系统主干。具体执行路径见上文 §11-§14，建议从 **Sprint 0（2 周）** 开始，先在服务器上跑通 PDF 回原文高亮，再逐步扩展到 Office、表格和自动评估。

[1]: https://nextjs.org/docs/app/guides/static-exports?utm_source=chatgpt.com "Guides: Static Exports"
[2]: https://tanstack.com/virtual/latest?utm_source=chatgpt.com "TanStack Virtual"
[3]: https://ui.shadcn.com/?utm_source=chatgpt.com "The Foundation for your Design System - shadcn/ui"
[4]: https://mozilla.github.io/pdf.js/examples/?utm_source=chatgpt.com "PDF.js - Examples"
[5]: https://github.com/agentcooper/react-pdf-highlighter?utm_source=chatgpt.com "agentcooper/react-pdf-highlighter: Set of ..."
[6]: https://docs.apryse.com/web/guides/overview?utm_source=chatgpt.com "Overview of JavaScript PDF, DOCX WebViewer"
[7]: https://www.nutrient.io/guides/web/?utm_source=chatgpt.com "JavaScript PDF library – Render, edit, and annotate PDFs"
[8]: https://api.onlyoffice.com/?utm_source=chatgpt.com "ONLYOFFICE API | ONLYOFFICE"
[9]: https://pymupdf.readthedocs.io/en/latest/recipes-text.html?utm_source=chatgpt.com "Text - PyMuPDF documentation"
[10]: https://www.nutrient.io/blog/pdfjs-coordinate-systems-pdf-to-screen/?utm_source=chatgpt.com "PDF.js coordinates: Convert PDF space to screen space"
[11]: https://docs.rig.rs/?utm_source=chatgpt.com "Rig docs"
[12]: https://docling-project.github.io/docling/reference/document_converter/?utm_source=chatgpt.com "Document converter - Docling"
[13]: https://docs.langchain.com/oss/python/langgraph/overview?utm_source=chatgpt.com "LangGraph overview - Docs by LangChain"
[14]: https://www.rabbitmq.com/docs/dlx?utm_source=chatgpt.com "Dead Letter Exchanges"
[15]: https://docs.temporal.io/workflow-execution?utm_source=chatgpt.com "Temporal Workflow Execution overview"
[16]: https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/dense-vector?utm_source=chatgpt.com "Dense vector field type | Elasticsearch Reference"
[17]: https://qdrant.tech/documentation/search/hybrid-queries/?utm_source=chatgpt.com "Hybrid Queries"
[18]: https://www.elastic.co/docs/solutions/search/vector/knn?utm_source=chatgpt.com "kNN search in Elasticsearch"
[19]: https://huggingface.co/BAAI/bge-m3?utm_source=chatgpt.com "BAAI/bge-m3"
[20]: https://www.alibabacloud.com/help/en/model-studio/embedding?utm_source=chatgpt.com "Alibaba Cloud Model Studio:Embedding"
[21]: https://developers.openai.com/api/docs/guides/embeddings?utm_source=chatgpt.com "Vector embeddings | OpenAI API"
[22]: https://docs.ragas.io/en/v0.1.21/concepts/metrics/?utm_source=chatgpt.com "Metrics"
[23]: https://www.trulens.org/getting_started/core_concepts/rag_triad/?utm_source=chatgpt.com "RAG Triad"
[24]: https://opentelemetry.io/?utm_source=chatgpt.com "OpenTelemetry"

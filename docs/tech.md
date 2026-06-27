# DocuMind 技术架构总览

本文档是 DocuMind 的技术架构目标态单一来源（single source of truth），说明整体技术选型、服务形态、Ingest Pipeline 与 Query Pipeline 的链式设计，以及各文件类型如何基于“通用链 + 格式特化链”处理。

当前代码和服务器部署并非所有目标态都已完成。已实现能力、未实现差距和下一步优先级以 [文档与代码实现差距总账](implementation-gap-analysis.md) 为准；特别是 RabbitMQ 任务编排、Python Document Intelligence Worker、Office/PDF 精确 bbox、OpenTelemetry/告警仍属于待补齐能力。

## 1. 总体技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 后端服务 | **Rust + axum + tokio** | 高性能、单二进制、可静态编译 |
| 前端 | **Next.js 静态导出** | 构建后嵌入 Rust 二进制，由 Rust 统一对外服务 |
| LLM 抽象 | **rig-core + async-openai adapter** | Rust 生态 LLM 抽象；OpenAI-compatible client 兜底私有模型和流式 |
| Agent 编排 | **自研 `documind-agent` crate** | 强类型状态机，可控、可观测、可测试 |
| RAG 工具 | **自研 trait + adapter** | 检索、精排、引用校验、缓存都走本地接口 |
| 关系数据库 | **PostgreSQL + SQLx** | 文档、chunk、对话、trace、权限的权威存储 |
| 向量/全文检索 | **Elasticsearch** | embedding + BM25 混合检索 |
| 缓存/状态 | **Redis** | 热点问答、请求去重、短期状态、分布式锁 |
| 消息队列 | **RabbitMQ** | 解析、清洗、切片、embedding 异步任务编排 |
| 对象存储 | **MinIO / 本地 blob** | 原始文件、解析快照、CSV 派生物、预览文件 |
| 文档智能 Worker | **可选 Python Worker（Docling / PyMuPDF / OCR）** | 通过 JSON contract 与 Rust 主链路隔离，用于高质量版面/表格/扫描件解析 |
| 部署目标 | **x86_64-unknown-linux-musl** | 单二进制 + 静态前端，通过 `ssh documind` 部署 |

### 1.1 前端组件栈

| 场景 | 选型 |
|---|---|
| UI 组件 | **shadcn/ui + Radix + Tailwind** |
| 服务端状态 | **TanStack Query** |
| 大列表/聊天/引用虚拟滚动 | **TanStack Virtual** |
| 轻量全局状态 | **Zustand** |
| 流式问答 | 原生 `EventSource` / fetch stream 封装 |
| PDF 原文预览 | **PDF.js + 自研 FileView / HighlightLayer** |
| Office 原文预览 | 后端转 PDF / page preview；需要编辑时接 OnlyOffice |
| 文本/Markdown 原文预览 | CodeMirror 6 / Monaco |

## 2. 为什么选择 Rust

- **单体二进制**：一个文件包含 API + Agent Kernel + 静态前端，部署、回滚、版本管理简单。
- **类型安全**：复杂的状态机（文档解析流程、Agent 决策流程）在编译期就能排除大量错误。
- **性能**：PDF/Word/PPT 解析、embedding、RAG 检索都是重 CPU/IO 任务，Rust 能控制好内存与并发。
- **与现有栈一致**：Northline / Corevo 同样以 Rust/Go 为主，运维和基础设施可复用。
- **无 Python 运行时依赖**：默认纯 Rust 解析即可运行；文档智能增强通过可选 Python Worker 以 JSON contract 接入，不污染主链路。

> 文档智能生态（OCR、layout、table、多格式解析）在 Python 中迭代更快。DocuMind 的取舍是：**Rust 负责产品系统与强类型业务主链路，Python 负责文档智能/模型生态适配**，两者用 JSON contract 隔离。

## 3. 为什么选择 Rig

`rig-core` 是 Rust 生态的 LLM 应用抽象层，负责：

- model provider 统一接入
- completion / chat completion
- embedding
- tool calling

但 DocuMind **不把业务编排完全交给 Rig**。Rig 被包在 `LlmClient` / `ToolClient` adapter 后面：

```text
Agent Kernel
  │
  └── LlmClient trait
        ├── RigLlmClient
        └── OpenAiCompatClient
```

这样后续即使替换 Rig 或引入新的私有模型，也不会影响 Agent 的领域流程。

## 4. 服务形态

```text
┌─────────────────────────────────────────────┐
│              ssh documind:8089               │
│                                              │
│  ┌───────────────────────────────────────┐  │
│  │        Next.js 静态前端                │
│  │        （/documind/）                  │
│  └───────────────────────────────────────┘  │
│                  │                           │
│  ┌───────────────┴───────────────────────┐  │
│  │         Rust API Server (axum)        │  │
│  │  /api/conversations  /api/admin/...   │  │
│  │  /api/files/{doc_id}/preview          │  │
│  └───────────────────────────────────────┘  │
│                  │                           │
│  ┌───────────────┼───────────────────────┐  │
│  │               │                       │  │
│  ▼               ▼                       ▼  │
│ PostgreSQL    Redis                 RabbitMQ │
│ Elasticsearch  MinIO/blob                   │
│                                              │
│  ┌───────────────────────────────────────┐  │
│  │      可选 Python Document Intelligence │  │
│  │      Worker (Docling / PyMuPDF / OCR)  │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

- 对外端口统一为 `8089`。
- 前端入口为 `/documind/`。
- Rust 二进制同时服务 API 和静态前端。
- 文件预览目标态支持短期签名 URL，不直接暴露 MinIO 内网地址；当前已部署版本通过应用代理接口 `/api/files/{doc_id}/preview/*` 提供 manifest、content 和 page PDF，权限校验仍在 DocuMind API 内完成。

## 5. Ingest Pipeline 链式设计

### 5.1 总体流程

```text
Upload API
  │
  ▼
Blob Storage  ───────────────────────────────┐
  │                                          │
  ▼                                          │
Parse Job  ──────┐                           │
  │              │                           │
  ▼              ▼                           │
Parser Chain ──► SourceAnchor Generator ──► Cleaner Chain ──► Chunker Chain
  │                  │                           │                  │
  │                  │                           ▼                  │
  │                  │                    Embedder Worker          │
  │                  │                           │                  │
  └──────────────────┴──────────────────────►  Index Writer ◄──────┘
                                                    │
                                                    ▼
                                         PostgreSQL + Elasticsearch
                                                    │
                                                    ▼
Preview Manifest / Page PDF Cache
```

当前实现状态：上传、解析、切块、embedding 和索引主链路已经可用；解析/OCR/embedding 任务仍主要由 Rust API 进程内异步任务执行，尚未切换到 RabbitMQ worker 消费。RabbitMQ 在服务器部署中已健康，但队列编排、重试、死信和 worker 隔离仍按 [实现差距总账](implementation-gap-analysis.md) 跟踪。

### 5.2 链式架构核心原则

Ingest Pipeline 被设计为一条**可组合、可观测、可独立重跑的处理链**：

1. **通用链（Common Chain）**：定义统一接口、数据契约、错误处理、可观测性、配置管理。
2. **格式特化链（Format-Specific Chain）**：针对 DOCX / PPTX / PDF / Markdown 实现具体逻辑。
3. **每节链独立版本**：Parser / Cleaner / Chunker / Embedder 各有版本号，变更只触发下游重跑。
4. **统一 Context 传递**：链上节点通过 `ParseContext` / `CleanContext` / `ChunkContext` 传递状态，支持断点续跑。
5. **幂等**：同一输入 + 同一配置生成同一版本，重复上传不重复计算。
6. **SourceAnchor 为主线**：解析阶段生成的原文锚点是贯穿清洗、chunk、检索、引用、预览的核心数据契约。

### 5.3 链上数据契约

```text
Original File
  -> ParsedDocument         (JSON 解析快照)
  -> document_source_anchors (原文锚点：page/slide/block/bbox/char_range/source_ref)
  -> document_blocks        (结构化 block，带 source_ref)
  -> cleaned_blocks         (清洗后 block，带 cleaning_ops / offset mapping)
  -> chunks                 (检索片段，带 heading_path / block_ids / anchor_ids)
  -> embeddings             (向量)
```

每个阶段输出都保留 `source_ref` 和 `anchor` 信息，保证任意 chunk 都能回到原文件、页码、slide、表格或 XML 节点。

清洗阶段必须保存 **offset mapping**：清洗后的文本用于检索和生成，但定位必须回到原始 block/run/anchor。

需要同时保存三份文本：

| 文本 | 用途 |
|---|---|
| `original_text` | 定位、校验、quote 溯源 |
| `normalized_text` | exact match、数字日期校验 |
| `chunk_content` | embedding、BM25、LLM 上下文 |

## 6. Parser Chain 详细设计

### 6.1 统一接口

```rust
pub trait Parser: Send + Sync {
    fn name(&self) -> &str;
    fn supported_formats(&self) -> &[FileFormat];
    fn parse(&self, ctx: ParseContext, file: &Blob) -> Result<ParsedDocument, ParseError>;
}
```

所有格式解析器都实现同一 `Parser` trait，上层通过文件类型自动路由。

### 6.2 Parser Chain 阶段

```text
ParserChain
  │
  ├── Stage 1: File Type Detection
  │       ├── MIME type
  │       ├── file extension
  │       └── file header / zip structure
  │
  ├── Stage 2: Format-Specific Extractor
  │       ├── DocxExtractor   -> zip + quick-xml + docx-rs
  │       ├── PptxExtractor   -> zip + quick-xml
  │       ├── PdfExtractor    -> pdf-extract + lopdf（默认）
  │       │                    可选 Python Worker：Docling / PyMuPDF
  │       └── MarkdownExtractor
  │
  ├── Stage 3: SourceAnchor Generation
  │       ├── PDF: page + text_run_id + bbox + char_range
  │       ├── DOCX: paragraph/table/cell path + render_ref (preview page + bbox)
  │       ├── PPTX: slide + shape_id + cell_range + bbox
  │       └── MD/TXT: char_range + byte_offset
  │
  ├── Stage 4: Common Post-Processing
  │       ├── Reading order recovery (PDF/PPT)
  │       ├── Heading path inference
  │       ├── Header/footer detection
  │       ├── Table candidate detection
  │       ├── Quality scoring
  │       └── Block normalization
  │
  └── Output: ParsedDocument + document_blocks + document_tables + document_source_anchors
```

### 6.3 文件类型识别链

| 格式 | MIME | 扩展名 | 文件头 / 结构 |
|---|---|---|---|
| PDF | `application/pdf` | `.pdf` | 文件头 `%PDF-` |
| DOCX | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `.docx` | zip 包含 `word/document.xml` |
| PPTX | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | `.pptx` | zip 包含 `ppt/presentation.xml` 和 `ppt/slides/slide*.xml` |
| Markdown | `text/markdown` | `.md` | 文本文件 |

若三者不一致，进入 `parse_failed(file_type_mismatch)`。

### 6.4 各格式解析链

#### DOCX

```text
DocxExtractor
  -> zip 解包
  -> word/document.xml (正文段落、表格)
  -> word/styles.xml (标题样式)
  -> word/numbering.xml (列表编号)
  -> word/header*.xml / word/footer*.xml (噪声候选)
  -> docProps/*.xml (元数据)
  -> 输出 heading / paragraph / list_item / table / footnote / text_box
  -> 为每个 paragraph/table/cell 生成 SourceAnchor
     - source_ref: xpath + paragraph_index + run_index_range
     - render_ref: preview_page + bbox（若已生成预览）
```

#### PPTX

```text
PptxExtractor
  -> zip 解包
  -> ppt/presentation.xml (slide 顺序)
  -> ppt/slides/slideN.xml (文本框、表格)
  -> ppt/notesSlides/notesSlideN.xml (备注)
  -> ppt/slideLayouts + ppt/slideMasters (模板噪声识别)
  -> 输出 heading / paragraph / list_item / table / slide_note
  -> 为每个 shape/table cell 生成 SourceAnchor
     - source_ref: slide + shape_id + table_id + cell_range
     - bbox: 基于 slide 尺寸归一化坐标
```

#### PDF

```text
PdfExtractor
  -> pdf-extract / PyMuPDF / Docling (文本层)
  -> lopdf (布局坐标、字符、线段)
  -> text_run 提取：run_id + text + bbox + font_size + rotation
  -> 行合并 -> 段落恢复
  -> 列检测 -> 阅读顺序恢复
  -> 表格候选区域检测 -> cell bbox
  -> 页眉页脚检测
  -> 输出 heading / paragraph / list_item / table / header_footer
  -> 为每个 text_run / paragraph / table cell 生成 SourceAnchor
     - bbox 存归一化坐标 (x0 = raw_x0 / page_width)
     - source_ref: text_run_ids
```

#### Markdown

```text
MarkdownExtractor
  -> 词法/语法分析
  -> frontmatter / heading / paragraph / list / code / table / blockquote
  -> 无需版式恢复
  -> 为每个 block 生成 SourceAnchor
     - char_range + byte_offset
```

### 6.5 SourceAnchor 统一模型

解析阶段输出的 `SourceAnchor` 是系统硬契约：

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

`bbox` 默认存归一化坐标，便于前端在不同缩放、旋转、DPR 下稳定渲染：

```text
x0 = raw_x0 / page_width
y0 = raw_y0 / page_height
x1 = raw_x1 / page_width
y1 = raw_y1 / page_height
```

## 7. Cleaner Chain 详细设计

```rust
pub trait Cleaner: Send + Sync {
    fn name(&self) -> &str;
    fn supported_formats(&self) -> &[FileFormat];
    fn clean(&self, ctx: CleanContext, blocks: Vec<DocumentBlock>) -> Result<Vec<CleanedBlock>, CleanError>;
}
```

### 7.1 通用清洗阶段

所有格式共享：

```text
CommonCleaner
  -> remove BOM
  -> normalize line endings
  -> normalize whitespace
  -> remove control / zero-width chars
  -> Unicode NFC
  -> tab -> spaces
```

### 7.2 格式特化清洗阶段

| 格式 | 特化清洗 |
|---|---|
| Markdown | frontmatter 提取、链接/图片处理、代码块保护、HTML 过滤 |
| Word | 页眉页脚过滤、目录删除、批注删除、footnote 保留、域代码展开 |
| PDF | 行合并、连字符处理、阅读顺序恢复、列检测、水印/噪声过滤 |
| PPT | 母版/布局噪声过滤、占位符提示删除、bullet 层级保留、slide note 分离 |

### 7.3 Offset Mapping

清洗时禁止破坏定位映射。每个 `CleanedBlock` 必须记录：

```json
{
  "block_id": "uuid",
  "original_text": "...",
  "normalized_text": "...",
  "cleaning_ops": [
    { "op": "remove_header", "original_range": [0, 12], "cleaned_range": null },
    { "op": "merge_line", "original_range": [45, 47], "cleaned_range": [43, 44] }
  ],
  "anchor_ids": ["anchor_001", "anchor_002"]
}
```

这样 `chunk_content` 中的任意字符范围都可以通过 offset mapping 还原到 `original_text` 和 `SourceAnchor`。

## 8. Chunker Chain 详细设计

```rust
pub trait Chunker: Send + Sync {
    fn name(&self) -> &str;
    fn supported_formats(&self) -> &[FileFormat];
    fn chunk(&self, ctx: ChunkContext, blocks: Vec<CleanedBlock>) -> Result<Vec<Chunk>, ChunkError>;
}
```

### 8.1 多粒度 Chunking 策略

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

### 8.2 通用 Chunking 阶段

```text
CommonChunker
  -> 结构感知分组（硬边界：H1 / table / slide / code fence）
  -> 子切分兜底（段落 -> 句子 -> token）
  -> Overlap 补全（15%~20%）
  -> 元数据补全（heading_path / page_range / block_ids / anchor_ids）
```

### 8.3 Chunk 必须携带 Anchor

```json
{
  "chunk_id": "uuid",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "anchor_ids": ["anchor_001", "anchor_002"],
  "primary_anchor_id": "anchor_001",
  "anchor_quality": "bbox",
  "content": "...",
  "heading_path": ["..."],
  "page_range": { "gte": 3, "lte": 3 }
}
```

| 字段 | 说明 |
|---|---|
| `anchor_ids` | chunk 覆盖的所有原文锚点 |
| `primary_anchor_id` | 默认引用锚点 |
| `anchor_quality` | `bbox` / `structural` / `page_only` / `unknown` |

### 8.4 格式特化 Chunking 阶段

| 格式 | 特化 chunk 规则 |
|---|---|
| Markdown | heading 栈、代码块原子性、列表合并、blockquote 边界 |
| Word | 段落/标题样式、分节符、列表编号、表格标题说明、footnote |
| PDF | 阅读顺序、列边界、标题推断、低置信度表格降级 |
| PPT | slide 硬边界、shape 顺序、bullet 合并、slide note 分离 |

## 9. Query Pipeline 架构

```text
User Question
  │
  ▼
Query Rewriting    (指代消解、关键词提取、intent、sub_queries)
  │
  ▼
Embedding          ( dense vector )
  │
  ▼
Hybrid Search      ( vector + BM25，pre-filter 权限与范围 )
  │
  ▼
Reranker           ( 精排 Top-K )
  │
  ▼
Context Assembly   ( token budget + 引用元数据 )
  │
  ▼
LLM Generation     ( Rig / OpenAI-compatible adapter )
  │
  ▼
Claim Extractor    ( 答案拆 claim )
  │
  ▼
CitationResolver   ( claim -> evidence -> anchor 匹配、去重、排序 )
  │
  ▼
CitationVerifier   ( 数字/日期/金额/实体/权限/版本校验 )
  │
  ▼
Answer + Citations + Confidence
```

Agent Kernel 负责整个 Query Pipeline 的编排，详见 `docs/11-agent/technical-framework.md`。

### 9.1 Query Rewrite 输出

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

### 9.2 CitationResolver 规则

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

数值类回答必须强校验：答案里出现 `30%`，原文里必须出现 `30%` 或等价表达，否则不能引用该 anchor。

## 10. 存储与索引架构

| 数据 | 存储 | 用途 |
|---|---|---|
| 原始文件 | MinIO / blob | 重新解析、审计、下载 |
| 文档元数据 | PostgreSQL `documents` | 权限、状态、管理 |
| 解析任务 | PostgreSQL `document_parse_jobs` | 版本、重试、质量 |
| 解析快照 | PostgreSQL JSONB / blob | 调试、重跑 |
| 原文锚点 | PostgreSQL `document_source_anchors` | 引用定位、FileView 高亮 |
| chunk 锚点映射 | PostgreSQL `chunk_anchor_map` | chunk 与 anchor 多对多关系 |
| 块级结构 | PostgreSQL `document_blocks` | 清洗、chunk、引用 |
| 清洗结果 | PostgreSQL `cleaned_blocks` | 重新清洗、审计 |
| chunk | PostgreSQL `chunks` | 权威元数据、引用链 |
| 表格结构 | PostgreSQL `document_tables` / `document_table_cells` | 精确回表 |
| 向量/全文 | Elasticsearch | 混合检索 |
| 对话/消息 | PostgreSQL | 多轮上下文 |
| 引用快照 | PostgreSQL `conversation_citation_snapshots` | 历史回答引用可追溯 |
| trace | PostgreSQL / OpenTelemetry | 可观测、审计 |

### 10.1 Elasticsearch chunks 索引

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

## 11. 版本与幂等

每个链节都有独立的版本标识：

```text
parse_identity   = sha256(file_sha256 + parser_version + parser_config)
clean_identity   = sha256(parse_identity + cleaner_version + cleaner_config)
chunk_identity   = sha256(parse_identity + chunker_version + chunker_config)
embedding_version = sha256(chunk_identity + embedding_model + embedding_config)
```

- 任一配置变更只触发下游链节重跑。
- 旧版本保留最近 2 个成功版本，便于回滚和对比。

## 12. 安全与隔离

- 上传文件当成不可信输入处理。
- 解析 worker 与 API 服务进程隔离。
- 文件大小、页数、解压后体积、XML 节点深度有限制。
- DOCX/PPTX 解包防 zip bomb。
- PDF 解析设置 CPU / 内存上限。
- 多租户数据隔离：所有表带 `tenant_id` / `kb_id`，ES 查询强制 filter。
- 文件预览 URL 为短期签名 URL，不暴露对象存储内网地址。

## 13. 可观测性

每次问答要能看到完整 trace：

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

每个链节输出结构化日志：

```json
{
  "event": "document_chunked",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "format": "docx",
  "chunk_count": 47,
  "duration_ms": 234,
  "version": "documind-chunker@0.1.0"
}
```

核心指标：

- 解析/清洗/chunk 成功率
- 平均/分位耗时
- 队列积压
- 低置信度文档比例
- chunk 平均 token 数
- `click_to_exact_highlight_rate`（点击引用后精准高亮率）
- `page_only_rate`（只能定位到页的比例）

## 14. 相关文档

- [解析框架与流程](1-document-parsing/parser-framework.md)
- [段落拆分与分块逻辑](1-document-parsing/block-and-chunking.md)
- [解析准确性保障](1-document-parsing/parsing-accuracy.md)
- [工业落地注意事项](1-document-parsing/production-readiness.md)
- [Markdown Text Cleaning](2-text-cleaning/markdown-text-cleaning.md)
- [Word Text Cleaning](2-text-cleaning/word-text-cleaning.md)
- [PDF Text Cleaning](2-text-cleaning/pdf-text-cleaning.md)
- [PPT Text Cleaning](2-text-cleaning/ppt-text-cleaning.md)
- [Chunking 统一设计](3-chunking/chunking.md)
- [引用定位与原文预览设计](9-answer-generation/citation-location-preview.md)
- [Citation Resolver 详细设计](9-answer-generation/citation-resolver.md)
- [Agent 技术框架](11-agent/technical-framework.md)

# DocuMind 技术架构总览

本文档是 DocuMind 的技术架构单一来源（single source of truth），说明整体技术选型、服务形态、Ingest Pipeline 与 Query Pipeline 的链式设计，以及各文件类型如何基于“通用链 + 格式特化链”处理。

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
| 消息队列 | **RabbitMQ** | 解析、清洗、chunk、embedding 异步任务编排 |
| 对象存储 | **MinIO / 本地 blob** | 原始文件、解析快照、CSV 派生物 |
| 部署目标 | **x86_64-unknown-linux-musl** | 单二进制 + 静态前端，通过 `ssh documind` 部署 |

## 2. 为什么选择 Rust

- **单体二进制**：一个文件包含 API + Agent Kernel + 静态前端，部署、回滚、版本管理简单。
- **类型安全**：复杂的状态机（文档解析流程、Agent 决策流程）在编译期就能排除大量错误。
- **性能**：PDF/Word/PPT 解析、embedding、RAG 检索都是重 CPU/IO 任务，Rust 能控制好内存与并发。
- **与现有栈一致**：Northline / Corevo 同样以 Rust/Go 为主，运维和基础设施可复用。
- **无 Python 运行时依赖**：默认纯 Rust 解析，不引入 Python 服务，降低部署复杂度。

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
│  │        Next.js 静态前端                │  │
│  │        （/documind/）                  │  │
│  └───────────────────────────────────────┘  │
│                  │                           │
│  ┌───────────────┴───────────────────────┐  │
│  │         Rust API Server (axum)        │  │
│  │  /api/conversations  /api/admin/...   │  │
│  └───────────────────────────────────────┘  │
│                  │                           │
│  ┌───────────────┼───────────────────────┐  │
│  │               │                       │  │
│  ▼               ▼                       ▼  │
│ PostgreSQL    Redis                 RabbitMQ │
│ Elasticsearch  MinIO/blob                   │
└─────────────────────────────────────────────┘
```

- 对外端口统一为 `8089`。
- 前端入口为 `/documind/`。
- Rust 二进制同时服务 API 和静态前端。

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
Parser Chain ──► Cleaner Chain ──► Chunker Chain
  │                  │                  │
  │                  ▼                  │
  │           Embedder Worker           │
  │                  │                  │
  └──────────────►  Index Writer ◄──────┘
                         │
                         ▼
              PostgreSQL + Elasticsearch
```

### 5.2 链式架构核心原则

Ingest Pipeline 被设计为一条**可组合、可观测、可独立重跑的处理链**：

1. **通用链（Common Chain）**：定义统一接口、数据契约、错误处理、可观测性、配置管理。
2. **格式特化链（Format-Specific Chain）**：针对 DOCX / PPTX / PDF / Markdown 实现具体逻辑。
3. **每节链独立版本**：Parser / Cleaner / Chunker / Embedder 各有版本号，变更只触发下游重跑。
4. **统一 Context 传递**：链上节点通过 `ParseContext` / `CleanContext` / `ChunkContext` 传递状态，支持断点续跑。
5. **幂等**：同一输入 + 同一配置生成同一版本，重复上传不重复计算。

### 5.3 链上数据契约

```text
Original File
  -> ParsedDocument         (JSON 解析快照)
  -> document_blocks        (结构化 block，带 source_ref)
  -> cleaned_blocks         (清洗后 block，带 cleaning_ops)
  -> chunks                 (检索片段，带 heading_path / block_ids)
  -> embeddings             (向量)
```

每个阶段输出都保留 `source_ref`，保证任意 chunk 都能回到原文件、页码、slide、表格或 XML 节点。

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
  │       ├── PdfExtractor    -> pdf-extract + lopdf
  │       └── MarkdownExtractor
  │
  ├── Stage 3: Common Post-Processing
  │       ├── Reading order recovery (PDF/PPT)
  │       ├── Heading path inference
  │       ├── Header/footer detection
  │       ├── Table candidate detection
  │       ├── Quality scoring
  │       └── Block normalization
  │
  └── Output: ParsedDocument + document_blocks + document_tables
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
```

#### PDF

```text
PdfExtractor
  -> pdf-extract (文本层)
  -> lopdf (布局坐标、字符、线段)
  -> 行合并 -> 段落恢复
  -> 列检测 -> 阅读顺序恢复
  -> 表格候选区域检测
  -> 页眉页脚检测
  -> 输出 heading / paragraph / list_item / table / header_footer
```

#### Markdown

```text
MarkdownExtractor
  -> 词法/语法分析
  -> frontmatter / heading / paragraph / list / code / table / blockquote
  -> 无需版式恢复
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

## 8. Chunker Chain 详细设计

```rust
pub trait Chunker: Send + Sync {
    fn name(&self) -> &str;
    fn supported_formats(&self) -> &[FileFormat];
    fn chunk(&self, ctx: ChunkContext, blocks: Vec<CleanedBlock>) -> Result<Vec<Chunk>, ChunkError>;
}
```

### 8.1 通用 Chunking 阶段

```text
CommonChunker
  -> 结构感知分组（硬边界：H1 / table / slide / code fence）
  -> 子切分兜底（段落 -> 句子 -> token）
  -> Overlap 补全（15%~20%）
  -> 元数据补全（heading_path / page_range / block_ids / table_ids）
```

### 8.2 格式特化 Chunking 阶段

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
Query Rewriting    (指代消解、关键词提取)
  │
  ▼
Embedding          ( dense vector )
  │
  ▼
Hybrid Search      ( vector + BM25 )
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
Answer + Citations + Confidence
```

Agent Kernel 负责整个 Query Pipeline 的编排，详见 `docs/11-agent/technical-framework.md`。

## 10. 存储与索引架构

| 数据 | 存储 | 用途 |
|---|---|---|
| 原始文件 | MinIO / blob | 重新解析、审计、下载 |
| 文档元数据 | PostgreSQL `documents` | 权限、状态、管理 |
| 解析任务 | PostgreSQL `document_parse_jobs` | 版本、重试、质量 |
| 解析快照 | PostgreSQL JSONB / blob | 调试、重跑 |
| 块级结构 | PostgreSQL `document_blocks` | 清洗、chunk、引用 |
| 清洗结果 | PostgreSQL `cleaned_blocks` | 重新清洗、审计 |
| chunk | PostgreSQL `chunks` | 权威元数据、引用链 |
| 表格结构 | PostgreSQL `document_tables` / `document_table_cells` | 精确回表 |
| 向量/全文 | Elasticsearch | 混合检索 |
| 对话/消息 | PostgreSQL | 多轮上下文 |
| trace | PostgreSQL | 可观测、审计 |

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

## 13. 可观测性

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
- [Agent 技术框架](11-agent/technical-framework.md)

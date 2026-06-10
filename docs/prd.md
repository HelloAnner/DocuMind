# DocuMind — 产品需求文档（PRD）

> 企业级文档智能问答系统。上传 Word / PPT / PDF，毫秒级语义检索，精准回答。
> 架构与设计语言对齐 Northline / Corevo。

---

## 1. 产品定位

### 1.1 一句话定位

**让企业员工用自然语言，从海量文档中直接问出答案——带原文出处、带置信度、可追溯。**

### 1.2 解决的问题

- 企业文档散落在各处分发、存储，查找成本极高
- 传统关键词搜索无法理解语义（"上季度销售策略" 找不到 "Q3 Sales Strategy.ppt"）
- 长文档翻阅效率低：一份 80 页 PDF，只为查一个数据口径
- 答案需要可信溯源：不能"看起来对"，必须精确引用原文段落

### 1.3 与 Northline 的关系

| | Northline | DocuMind |
|---|---|---|
| 数据形态 | 结构化数据库（PG/MySQL/CK） | 非结构化文档（Word/PPT/PDF） |
| 核心能力 | NL2SQL → 查表出图 | RAG → 检索文档段落出答案 |
| 用户画像 | 数据分析师、业务管理者 | 全企业员工（知识工作者） |
| 输出形态 | 表格、图表、解释 | 答案段落 + 原文引用 + 来源文档 |

---

## 2. 功能全景

### 2.1 角色体系

| 角色 | 职责 |
|---|---|
| **超级管理员** | 全局配置、租户管理、模型/向量库运维 |
| **知识库管理员** | 上传文档、管理知识库、配置切割策略、查看问答统计 |
| **普通用户** | 提问、查看历史问答、反馈答案质量 |

### 2.2 功能模块

```
DocuMind
├── 问答对话
│   ├── 自然语言提问
│   ├── 流式回答（SSE）
│   ├── 答案溯源（原文引用高亮）
│   ├── 多轮对话（上下文记忆）
│   └── 反馈机制（赞/踩 + 修正）
├── 知识库管理
│   ├── 知识库 CRUD
│   ├── 文档上传（Word / PPT / PDF）
│   ├── 文档解析状态追踪
│   ├── 文档标签与分类
│   └── 文档删除与重处理
├── 管理控制台
│   ├── 系统概览（文档数、切片数、问答量）
│   ├── 切割策略配置
│   ├── 向量化模型配置
│   ├── 检索策略配置（Top-K、阈值）
│   └── 问答日志与统计分析
└── 系统运维
    ├── 向量索引管理（重建、优化）
    ├── LLM Provider 配置
    └── 审计日志
```

### 2.3 关键红线

- **宁愿答不出，绝不瞎编。** 检索不到相关文档时明确告知，不做无依据生成
- 不做通用聊天、写文案、写代码
- 所有回答必须附带原文引用（chunk_id → document_id → 原文段落）
- 全流程留痕、可追溯

---

## 3. RAG 全流程设计

### 3.1 总览：两条核心 Pipeline

```
┌──────────────────────────────────────────────────────────────┐
│                    INGESTION PIPELINE                         │
│                                                               │
│  Word/PPT/PDF → Parser → Cleaner → Chunker → Embedder        │
│                                              │                │
│                                              ▼                │
│                                     Vector Store (PGVector)   │
│                                     + Metadata Store (PG)     │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                     QUERY PIPELINE                            │
│                                                               │
│  用户问题 → Query Rewrite → Embedding → Vector Search        │
│                                          │                    │
│                                          ▼                    │
│                                    Hybrid Merge               │
│                                          │                    │
│                                          ▼                    │
│                                    Reranker                   │
│                                          │                    │
│                                          ▼                    │
│                                    Context Assembly            │
│                                          │                    │
│                                          ▼                    │
│                                    LLM Generation → 答案      │
│                                          │                    │
│                                          ▼                    │
│                                    溯源引用 + 置信度          │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Ingestion Pipeline 详解

#### 3.2.1 阶段 1：文档解析（Parser）

| 组件 | 责任 | 技术选型 |
|---|---|---|
| PDF Parser | 提取文本、表格、页眉页脚过滤 | Rust `pdf-extract` / `lopdf`；表格区用规则保留结构 |
| Word Parser | 解析 .docx（XML 解压）提取段落、标题层级、表格 | Rust `docx-rs` 或直接解析 OpenXML |
| PPT Parser | 解析 .pptx，提取文本框、表格、备注 | Rust OpenXML 解析；按 slide 分组保留结构 |

**输出：标准化文档结构**

```json
{
  "doc_id": "uuid",
  "title": "2025 年度销售策略",
  "sections": [
    {
      "heading": "Q1 目标",
      "level": 2,
      "paragraphs": ["...", "..."],
      "tables": [{"headers": [...], "rows": [[...], ...]}],
      "page": 3
    }
  ]
}
```

#### 3.2.2 阶段 2：文本清洗（Cleaner）

- 去除页眉页脚、页码、水印
- 合并断行（PDF 常见硬换行）
- 规范化空白字符
- 保留表格结构信息（作为结构化上下文注入）

#### 3.2.3 阶段 3：智能切割（Chunker）

**核心问题**：切太碎丢上下文，切太粗检索不准。

**三级切割策略（分层递进）**：

```
Level 1 — 结构感知切分
  按文档原生结构边界切分：标题/小节/表格/slide
  最大 chunk 不超过 1500 tokens

Level 2 — 语义补全（Sliding Window）
  每个 chunk 前后各补 1 个相邻段落作为 overlap
  overlap 长度 = chunk 的 15%~20%（约 200-300 tokens）

Level 3 — 子切分兜底
  若 Level 1 产出 chunk 仍超过 2000 tokens
  递归按段落/句子边界继续切分，保持语义完整性
```

**Chunk 元数据（存入 PG）**：

```yaml
chunk_id: uuid
doc_id: uuid
kb_id: uuid
chunk_index: 0          # 在文档中的顺序
content: "..."          # 纯文本
heading_path: ["Q1 目标", "分地区策略"]  # 层级标题路径
page_range: [3, 4]      # 原文页码范围
token_count: 342
source_type: paragraph  # paragraph / table / slide_note
```

#### 3.2.4 阶段 4：向量化（Embedder）

| 方案 | 适用场景 |
|---|---|
| **本地部署** bge-large-zh-v1.5 (1024d) | 纯中文企业文档，无外网依赖，推荐 |
| **本地部署** multilingual-e5-large (1024d) | 中英混合文档 |
| **API** DashScope text-embedding-v3 (1024d) | 不想维护 GPU，成本可控 |
| **API** OpenAI text-embedding-3-large (3072d) | 多语言、高精度要求 |

**推荐默认**：`bge-large-zh-v1.5` 本地部署（ONNX Runtime + Rust `ort` crate），1024 维，FP16，单卡可吞吐 1000+ docs/min。

**落地**：
- 解析完成 → 入队 MQ → Embedding Worker 消费 → 写入 PGVector
- 支持失败重试、幂等（按 chunk_id 去重）
- embedding 模型可热切换（重建索引）

### 3.3 Query Pipeline 详解

#### 3.3.1 阶段 1：Query Rewrite（查询改写）

**作用**：用户口语化提问 → 规范化检索查询

| 技术 | 说明 |
|---|---|
| **多轮上下文融合** | 结合历史对话，把指代消解（"那份文档呢？"→"Q3 销售报告"） |
| **HyDE** | 假设性文档嵌入：先让 LLM 生成一个假想的答案段落，再拿假想答案做向量检索。提升检索召回率 15~20% |
| **Multi-Query** | 把一个复杂问题拆成 2-3 个子查询分别检索，结果合并去重 |
| **术语规范化** | 企业黑话/缩写 → 正式术语（"那个Q的合同" → "Q3 采购合同"） |

**流程**：
```
用户问题（含多轮上下文）
  │
  ▼
LLM 轻量改写（小模型，~0.3s）
  │  输出:
  │  - rewritten_query: "2025年Q3采购合同中的违约责任条款"
  │  - keywords: ["采购合同", "违约", "Q3", "2025"]
  │  - hypothetical_answer: "..."（HyDE 可选）
  │
  ▼
并行检索: rewritten_query → Vector Search + keywords → BM25
```

#### 3.3.2 阶段 2：混合检索（Hybrid Search）

```
                    用户查询
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    Dense Vector   Sparse BM25   Metadata Filter
    (语义相似)     (关键词匹配)    (时间/标签/知识库)
          │            │            │
          ▼            ▼            ▼
       Top-100       Top-100      精确过滤
          │            │            │
          └────────────┼────────────┘
                       │
                       ▼
              RRF (Reciprocal Rank Fusion)
              融合三路结果，取 Top-20
                       │
                       ▼
                    Reranker
```

**Dense Vector Search**：
- 查询向量 → PGVector `ivfflat` 或 `hnsw` 索引 → cosine 相似度 Top-100
- 距离度量：`cosine`（对文档长度差异鲁棒）

**Sparse BM25 Search**：
- 使用 PostgreSQL 内置 `tsvector` + `tsquery` 做全文检索
- 中文分词：`zhparser`（PG 插件）或 jieba-rs 分词后存 `tsvector`
- 对专业术语、数字、日期等精确匹配场景补偿向量检索的短板

**Metadata Filter**：
- 限定知识库、文档标签、时间范围
- 预过滤（pre-filter）而非后过滤，保证 Top-K 不被无关结果稀释

**RRF 融合**：
```
RRF_score(d) = Σ  1 / (k + rank_i(d))
              i∈{dense,sparse}

k = 60, 取融合后 Top-20 送入 Reranker
```

#### 3.3.3 阶段 3：Reranker（精排）

| 方案 | 说明 |
|---|---|
| **bge-reranker-v2-m3** | 本地部署，cross-encoder，中文场景 SOTA |
| **Cohere Rerank API** | SaaS，多语言，按调用量计费 |

**流程**：
```
Top-20 chunks + 改写后的 query
    │
    ▼
Cross-Encoder Reranker
  对每个 (query, chunk) pair 独立打分
    │
    ▼
按 rerank_score 降序排列 → 取 Top-5
    │
    ▼
阈值过滤: rerank_score < 0.3 的丢弃
  若全部 < 0.3 → 返回"未找到相关文档"
```

#### 3.3.4 阶段 4：Context Assembly（上下文组装）

**组织 Top-5 chunks 为结构化 Prompt**：

```
System: 你是一个企业文档问答助手。仅根据以下文档片段回答。
        如果答案不在片段中，明确说"文档中未找到相关信息"。
        引用原文时使用 [来源: 文档名, 第X页] 格式。

Context:
[1] 文档: 2025销售策略.pptx, 页码: 3-4
    标题: Q1 目标 > 分地区策略
    内容: ...

[2] 文档: 2025销售策略.pptx, 页码: 7
    ...

[3] ...

问题: {用户原始问题 + 多轮上下文}

回答要求:
- 先给出简洁直接的答案
- 再用引用格式逐条列出依据
- 标注置信度（高/中/低）
```

**Token 预算管理**：
- 预留 60% 给 Context（约 2400-3000 tokens）
- 预留 30% 给生成回答（约 1200 tokens）
- 预留 10% 给 System Prompt + 多轮历史
- 动态调整：若有表格数据，压缩段落上下文让位

#### 3.3.5 阶段 5：LLM Generation

- Provider：兼容 OpenAI chat.completions 协议（DashScope / OpenAI / 内网模型）
- 默认：qwen-turbo（性价比）或 deepseek-chat（推理强）
- 流式输出（SSE），前端逐字展示

#### 3.3.6 阶段 6：答案后处理

- **引用格式化**：`[1] 2025销售策略.pptx §3.2 (第7页)` 带锚点链接
- **置信度计算**：`confidence = f(rerank_score, chunk_overlap, keyword_match_rate)`
- **敏感信息脱敏**：正则匹配手机号/身份证号/金额做掩码（可选）

---

## 4. 技术选型

### 4.1 总体架构

```
┌─────────────────────────────────────────────────────┐
│                  Nginx / Caddy                        │
│              (可选边缘入口，TLS 终端)                    │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│             DocuMind Rust Binary (:19099)             │
│                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │  Axum HTTP   │  │  Agent Kernel │  │  Task Runner │ │
│  │  (API+SPA)   │  │  (RAG Graph)  │  │  (MQ Worker) │ │
│  └─────────────┘  └──────────────┘  └─────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Embedding Engine (ONNX Runtime / ort crate)     │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   ┌─────────┐  ┌──────────┐  ┌──────────┐
   │PostgreSQL│  │  Redis 7  │  │ RabbitMQ │
   │+PGVector │  │ (缓存/会话)│  │ (任务队列)│
   └─────────┘  └──────────┘  └──────────┘
```

### 4.2 Rust 技术栈明细

| 层 | 选型 | 理由 |
|---|---|---|
| **Web 框架** | Axum 0.7 + Tokio + Tower | 与 Northline 统一，async 生态成熟 |
| **数据库** | SQLx 0.8 (PostgreSQL + PGVector) | 编译期 SQL 校验，支持 PGVector 扩展 |
| **向量扩展** | PGVector (pgvector 0.7+) | 向量与元数据同库，无需额外集群；ivfflat/hnsw 索引 |
| **全文检索** | PostgreSQL tsvector + zhparser | 利用已有 PG 做 BM25 关键词检索 |
| **缓存/会话** | Redis 7 (redis-rs 0.25) | 会话状态、LLM 请求去重、热点问答缓存 |
| **消息队列** | RabbitMQ (lapin / amqprs) | 文档解析、向量化、索引重建等异步任务 |
| **LLM Adapter** | Rig 0.37 (`rig-core`) | Rust 生态的 LLM 抽象层，兼容 OpenAI 协议 |
| **Embedding** | ONNX Runtime (`ort` crate) | 本地推理 bge-large-zh-v1.5，无外网依赖 |
| **文档解析** | `pdf-extract` + `docx-rs` + OpenXML | 纯 Rust 解析，无 Python 依赖 |
| **中文分词** | jieba-rs | BM25 关键词提取与分词 |
| **前端嵌入** | `rust-embed` 8.x | 静态资源编译进二进制 |
| **可观测** | tracing + tracing-subscriber | 结构化日志、OpenTelemetry 导出 |
| **配置** | dotenvy | .env 文件 → 结构体 |

### 4.3 前端技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 15 (App Router) |
| 样式 | Tailwind CSS + 对齐 DESIGN.md tokens |
| 状态管理 | React Context + SWR (数据请求) |
| 图标 | Lucide React |
| 构建产物 | `next build` → `output: "export"` 静态文件 |
| 嵌入方式 | `rust-embed` 嵌入 → Axum 路由 serve |

### 4.4 单二进制部署

```
DocuMind/
├── apps/web/           # Next.js 前端
│   └── out/            # 静态构建产物 (gitignored)
├── crates/
│   ├── documind/       # 主业务 binary
│   │   └── src/
│   │       ├── main.rs          # 启动入口
│   │       ├── config.rs        # 配置加载
│   │       ├── router.rs        # Axum Router 装配
│   │       ├── api/             # API handlers
│   │       ├── services/        # 业务逻辑
│   │       ├── rag/             # RAG 内核
│   │       ├── models/          # 数据模型
│   │       └── middleware/      # 中间件
│   ├── documind-parser/ # 文档解析 crate
│   └── web-embed/       # 静态资源嵌入
├── Cargo.toml
├── Cargo.lock
├── .env.example
├── DESIGN.md
└── docs/
```

`cargo build --release` → `./target/release/documind` 单二进制启动，内嵌前端 SPA。

---

## 5. 检索逻辑详细设计

### 5.1 检索架构图

```
用户问题
   │
   ▼
Query Understanding
   │
   ├── rewritten_query  ────────────────────────┐
   ├── keywords ────────────────────────┐       │
   └── hypothetical_answer (HyDE) ──────┤       │
                                        │       │
         ┌──────────────────────────────┘       │
         ▼                                      ▼
   ┌──────────┐                         ┌──────────────┐
   │  BM25    │                         │ Vector Search│
   │  PG FTS  │                         │  PGVector    │
   │          │                         │              │
   │ tsquery  │                         │ cosine       │
   │ zhparser │                         │ ivfflat/hnsw │
   │ Top-100  │                         │ Top-100      │
   └────┬─────┘                         └──────┬───────┘
        │                                      │
        │         ┌──────────────────┐         │
        │         │ Metadata Filter  │         │
        │         │ (kb_id,tags,     │◄────────┘
        │         │  time_range)     │
        │         │ pre-filter       │
        │         └────────┬─────────┘
        │                  │
        └──────────┬───────┘
                   │
                   ▼
            ┌──────────────┐
            │ RRF Fusion   │
            │ k=60, Top-20 │
            └──────┬───────┘
                   │
                   ▼
            ┌──────────────┐
            │  Reranker    │
            │  Cross-Enc   │
            │  Top-5       │
            └──────┬───────┘
                   │
                   ▼
            ┌──────────────┐
            │Threshold ≥0.3│
            └──────┬───────┘
                   │
              Yes  │  No → "未找到"
                   ▼
            ┌──────────────┐
            │ LLM Generate │
            └──────────────┘
```

### 5.2 向量索引设计

```sql
-- PGVector 建表
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS zhparser;

CREATE TABLE chunks (
  chunk_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id       UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  kb_id        UUID NOT NULL REFERENCES knowledge_bases(kb_id),
  chunk_index  INTEGER NOT NULL,
  content      TEXT NOT NULL,
  heading_path TEXT[],
  page_range   INT4RANGE,
  token_count  INTEGER,
  source_type  VARCHAR(20),        -- 'paragraph' | 'table' | 'slide_note'
  embedding    VECTOR(1024),       -- bge-large-zh 维度

  -- 全文检索
  content_tsv  TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('chinese_zh', content)
  ) STORED,

  created_at   TIMESTAMPTZ DEFAULT now()
);

-- 向量索引 (HNSW 适合高精度，IVFFlat 适合大容量)
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- 全文检索索引
CREATE INDEX ON chunks USING GIN (content_tsv);
CREATE INDEX ON chunks USING GIN (heading_path);

-- 过滤字段索引
CREATE INDEX ON chunks (kb_id, doc_id);
CREATE INDEX ON chunks USING GIN (content_tsv) WHERE kb_id = $1;
```

### 5.3 查询流程伪代码

```rust
async fn search(query: Query, kb_ids: Vec<Uuid>) -> Result<Vec<Chunk>> {
    // 1. Query Rewrite
    let rewritten = llm.rewrite_query(&query).await?;

    // 2. 并行执行三路检索
    let (dense, sparse) = tokio::join!(
        vector_search(rewritten.embedding, kb_ids, top_k=100),
        bm25_search(rewritten.keywords, kb_ids, top_k=100),
    );

    // 3. RRF 融合
    let fused = rrf_fuse(&dense, &sparse, k=60, top_n=20);

    // 4. Reranker 精排
    let reranked = reranker.rerank(&query.text, fused, top_k=5).await?;

    // 5. 阈值过滤
    let valid: Vec<_> = reranked
        .into_iter()
        .filter(|r| r.score >= 0.3)
        .collect();

    Ok(valid)
}
```

### 5.4 多轮对话检索增强

```
第 N 轮检索时：
1. 取最近 3 轮对话的 QA 对
2. LLM 生成上下文感知的 rewritten_query（消解指代、继承话题）
3. 若当前问题与上一轮高度相关（cosine > 0.85），
   额外附加上一轮检索的 Top-3 chunks 到候选池
4. 若用户引用上一轮答案中的某条引用，
   直接将对应 chunk 加入 Context Assembly
```

### 5.5 空结果与低质量处理

| 场景 | 处理 |
|---|---|
| Reranker 全部 < 0.3 | 返回"未找到相关文档"，建议用户换关键词或指定知识库 |
| Top-5 分数接近（方差 < 0.1） | 说明问题宽泛，请求用户缩小范围 |
| 部分 chunks 来自同一文档同一页 | 去重合并，优先保留更完整的那条 |
| 检索结果跨多个知识库但用户只问一个 | 自动选择命中 chunk 最多的知识库 |

---

## 6. 数据库核心表设计（摘要）

```sql
-- 知识库
knowledge_bases (kb_id, tenant_id, name, description, created_at)

-- 文档
documents (doc_id, kb_id, title, file_type, file_size, parse_status,
           chunk_count, uploaded_at)

-- Chunks（见 §5.2 完整建表）

-- 问答记录
qa_history (qa_id, user_id, kb_id, question, rewritten_query,
            retrieved_chunks, answer, confidence, feedback, created_at)

-- 用户反馈
feedback (feedback_id, qa_id, user_id, rating, correction, created_at)
```

---

## 7. 交付节奏

### Phase 1 — 筑基（Weeks 1–4）

- [x] 项目骨架：Axum + SQLx + PGVector + Redis + MQ 连接
- [ ] 文档上传与解析（PDF / Word / PPT）
- [ ] 切割 Pipeline（三级策略 + 异步 MQ 消费）
- [ ] 向量化 Pipeline（本地 ONNX + bge-large-zh）
- [ ] 基础问答 API（单轮，非流式）
- [ ] 管理后台：知识库 + 文档 CRUD

### Phase 2 — 调优（Weeks 5–8）

- [ ] 混合检索（Dense + BM25 + RRF）
- [ ] Reranker 集成（bge-reranker-v2-m3）
- [ ] Query Rewrite + HyDE
- [ ] 多轮对话上下文
- [ ] 流式 SSE 输出
- [ ] 答案溯源引用

### Phase 3 — 交付（Weeks 9–12）

- [ ] 权限系统（租户隔离 + RBAC）
- [ ] 审计日志
- [ ] 问答统计 Dashboard
- [ ] 单二进制编译 + 部署文档
- [ ] 压测与优化（P95 < 5s）
- [ ] 灰度上线

---

## 8. SLA 指标

| 指标 | 目标 |
|---|---|
| 问答端到端 P95 | ≤ 5s |
| 检索召回率（Recall@5） | ≥ 90% |
| 答案准确率（人工评估） | ≥ 85% |
| 文档解析成功率 | ≥ 98% |
| 单文档向量化时间 | ≤ 30s / MB |
| 并发问答 | 50 QPS（单节点） |

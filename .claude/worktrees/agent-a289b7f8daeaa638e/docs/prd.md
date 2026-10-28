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
├── Agent 智能体
│   ├── 角色人格与对话气质
│   ├── 灵活回答模式（直接回答 / 澄清 / 总结 / 对比 / 引导）
│   ├── Prompt 策略与版本管理
│   ├── 工具调用规划（改写 / 检索 / 精排 / 生成）
│   └── 可信边界与防幻觉约束
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
- 不做无边界通用聊天、写文案、写代码；但允许围绕文档内容进行有温度的解释、追问、总结和引导
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
│                                     Elasticsearch             │
│                                     + Metadata Store (PostgreSQL) │
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
- 解析完成 → 入队 MQ → Embedding Worker 消费 → 写入 Elasticsearch
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
- 查询向量 → Elasticsearch `dense_vector` HNSW 索引 → cosine 相似度 Top-100
- 距离度量：`cosine`（对文档长度差异鲁棒）

**Sparse BM25 Search**：
- 使用 Elasticsearch 原生 BM25 倒排索引做全文检索
- 中文分词：ES `ik_max_word` 分词插件
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
│             DocuMind Rust Binary (:8089)              │
│                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │  Axum HTTP   │  │  Agent Kernel │  │  Task Runner │ │
│  │  (API+SPA)   │  │  (RAG Graph)  │  │ (in-process) │ │
│  └─────────────┘  └──────────────┘  └─────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Embedding Engine (ONNX Runtime / ort crate)     │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────┘
                       │
        ┌──────────────┼──────────────┼──────────────┐
        ▼              ▼              ▼              ▼
   ┌───────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────┐
   │PostgreSQL │ │Elasticsearch │ │  Redis 7  │ │ RabbitMQ │
   │(业务元数据)│ │(向量+检索)   │ │ (缓存/会话)│ │ (任务队列)│
   └───────────┘ └──────────────┘ └──────────┘ └──────────┘
```

### 4.2 Rust 技术栈明细

| 层 | 选型 | 理由 |
|---|---|---|
| **Web 框架** | Axum 0.7 + Tokio + Tower | 与 Northline 统一，async 生态成熟 |
| **业务数据库** | SQLx 0.8 (PostgreSQL) | 编译期 SQL 校验，存储知识库/文档/用户/问答记录 |
| **搜索引擎** | Elasticsearch 8.x | 向量检索 (kNN/HNSW) + BM25 全文检索，内置 hybrid search + RRF |
| **中文分词** | ES ik / jieba 插件 | BM25 关键词检索的中文分词 |
| **缓存/会话** | Redis 7 (redis-rs 0.25) | 会话状态、LLM 请求去重、热点问答缓存 |
| **消息队列** | RabbitMQ（目标态 worker 消费） | 文档解析、向量化、索引重建等异步任务；当前部署已健康检查但未承载完整 worker |
| **LLM Adapter** | Rig (`rig-core`) + OpenAI-compatible adapter | Rust 生态的 LLM 抽象层，兼容 DashScope / OpenAI / 内网模型 |
| **Embedding** | OpenAI-compatible API；目标态可选 ONNX Runtime (`ort` crate) | 当前服务器使用 `text-embedding-v3`；本地 bge/ONNX 是可选部署形态 |
| **文档解析** | `pdf-extract` + `docx-rs` + OpenXML | 纯 Rust 解析，无 Python 依赖 |
| **中文分词** | jieba-rs | BM25 关键词提取与分词 |
| **前端嵌入** | `rust-embed` 8.x | 静态资源编译进二进制 |
| **可观测** | tracing + tracing-subscriber；目标态接 OpenTelemetry | 当前已有结构化日志和健康检查；OpenTelemetry/Prometheus/告警仍待补 |
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
   │  ES      │                         │  ES kNN      │
   │          │                         │              │
   │ BM25     │                         │ cosine       │
   │ ik分词   │                         │ HNSW         │
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

### 5.2 ES 索引设计

```json
// PUT /chunks
{
  "settings": {
    "number_of_shards": 3,
    "number_of_replicas": 1,
    "analysis": {
      "analyzer": {
        "chinese_analyzer": {
          "type": "custom",
          "tokenizer": "ik_max_word",
          "filter": ["lowercase"]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "chunk_id":    { "type": "keyword" },
      "doc_id":      { "type": "keyword" },
      "kb_id":       { "type": "keyword" },
      "chunk_index": { "type": "integer" },
      "content": {
        "type": "text",
        "analyzer": "chinese_analyzer",
        "fields": {
          "keyword": { "type": "keyword", "ignore_above": 256 }
        }
      },
      "heading_path": { "type": "keyword" },
      "page_range":   { "type": "integer_range" },
      "token_count":  { "type": "integer" },
      "source_type":  { "type": "keyword" },
      "embedding": {
        "type": "dense_vector",
        "dims": 1024,
        "index": true,
        "similarity": "cosine",
        "index_options": {
          "type": "hnsw",
          "m": 16,
          "ef_construction": 200
        }
      },
      "created_at": { "type": "date" }
    }
  }
}
```

- **向量字段** `embedding`：dense_vector(1024d)，HNSW 索引，cosine 相似度
- **全文检索字段** `content`：ik_max_word 中文分词，BM25 倒排索引
- **过滤字段**：kb_id / doc_id / source_type 为 keyword，page_range 为 integer_range
- **hybrid search**：一次查询同时跑 kNN + BM25，ES 内置 RRF 融合

### 5.3 查询流程伪代码

```rust
async fn search(query: Query, kb_ids: Vec<Uuid>) -> Result<Vec<Chunk>> {
    // 1. Query Rewrite
    let rewritten = llm.rewrite_query(&query).await?;

    // 2. ES hybrid search（一次查询完成 kNN + BM25 + 元数据过滤 + RRF 融合）
    let result = es_client
        .search(SearchRequest {
            index: "chunks",
            query: HybridQuery {
                knn: KnnClause {
                    field: "embedding",
                    query_vector: rewritten.embedding,
                    k: 100,
                    num_candidates: 200,
                },
                bm25: Bm25Clause {
                    fields: vec!["content"],
                    query: &rewritten.rewritten_query,
                },
                filter: FilterClause {
                    kb_id: kb_ids,
                    // source_type, time_range 等预过滤
                },
                rrf: RrfConfig { k: 60, window_size: 100 },
            },
            size: 20,
        })
        .await?;

    let candidates: Vec<Chunk> = result.hits.into();

    // 3. Reranker 精排
    let reranked = reranker.rerank(&query.text, candidates, top_k=5).await?;

    // 4. 阈值过滤
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

本节保留最初 PRD 的阶段规划。当前真实交付状态以 [文档与代码实现差距总账](implementation-gap-analysis.md) 和 [上线阶段路线图](production-launch-roadmap.md) 为准；截至 2026-06-28，核心上传、解析、混合检索、SSE 问答、引用定位、RBAC、部署和基础后台均已有服务器部署，但 RabbitMQ worker、完整 OpenTelemetry、Office/PDF 精确 bbox、claim 级引用校验仍未达到目标态。

### Phase 1 — 筑基（Weeks 1–4）

- [x] 项目骨架：Axum + SQLx + PostgreSQL + Elasticsearch + Redis + RabbitMQ 健康检查
- [x] 文档上传与解析（PDF / Word / PPT / Markdown / TXT 基础链路）
- [x] 切割 Pipeline（结构化 block/chunk 已落地；异步 MQ 消费未完成）
- [x] 向量化 Pipeline（服务器使用 OpenAI-compatible embedding API；本地 ONNX 仍是目标选项）
- [x] 基础问答 API（SSE 流式已落地）
- [x] 管理后台：知识库 + 文档 CRUD

### Phase 2 — 调优（Weeks 5–8）

- [x] 混合检索（Dense + BM25 + RRF 基础链路）
- [~] Reranker 集成（HTTP reranker 接口存在；未配置时使用 lexical fallback）
- [~] Query Rewrite + HyDE（规则改写已落地；HyDE/LLM 改写仍待增强）
- [x] 多轮对话上下文
- [x] 流式 SSE 输出
- [x] 答案溯源引用（SourceAnchor -> CitationResolver -> FileView 主链路已落地；claim 级强校验待增强）

### Phase 3 — 交付（Weeks 9–12）

- [x] 权限系统（租户隔离 + RBAC 核心链路）
- [~] 审计日志（核心事件已落库；覆盖、筛选、导出和保留策略待补）
- [~] 问答统计 Dashboard（后台只读统计可用；完整告警和运维操作待补）
- [x] 单二进制编译 + 部署文档
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

以上 SLA 是目标指标；当前仓库已有 golden eval、Office/OCR smoke 和浏览器 FileView smoke，尚未完成正式压测、长期趋势记录和发布阻断门禁。

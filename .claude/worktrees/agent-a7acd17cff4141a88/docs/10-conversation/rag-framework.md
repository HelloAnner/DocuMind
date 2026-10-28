# RAG 框架选型 (RAG Framework)

DocuMind 的 RAG 不建议直接绑定某个全家桶框架，而是采用「Rust 原生 Agent Kernel + 可替换组件」的方式实现。这样能保持单二进制部署、权限可控、链路可观测，同时保留替换 LLM、Embedding、Reranker 和检索策略的灵活性。

## 推荐方案

```text
Axum API
  │
  ▼
Conversation Service
  │
  ▼
Agent Kernel
  ├── Query Rewrite
  ├── Retrieval Planning
  ├── Hybrid Search Adapter
  ├── Reranker Adapter
  ├── Context Assembly
  ├── LLM Adapter
  └── Citation Verifier
```

## 核心依赖

| 能力 | 推荐实现 | 说明 |
|---|---|---|
| Web/API | Axum + Tokio | 与 PRD 技术栈一致 |
| LLM Adapter | Rig (`rig-core`) 或自研 OpenAI-compatible client | 兼容 DashScope / OpenAI / 内网模型 |
| Embedding | ONNX Runtime (`ort`) + bge/e5 | 本地推理，降低数据外发 |
| Vector Search | Elasticsearch dense_vector HNSW | 向量检索 + 过滤 |
| Sparse Search | Elasticsearch BM25 + ik/jieba | 关键词补偿 |
| Rerank | bge-reranker-v2-m3 adapter | cross-encoder 精排 |
| Cache | Redis | 热点问答、请求去重 |
| Trace Store | PostgreSQL | 业务记录和链路复盘 |

## 为什么不直接用 LangChain / LlamaIndex 全家桶

| 维度 | 直接使用全家桶 | DocuMind 推荐方式 |
|---|---|---|
| 部署 | 多数生态偏 Python/Node | Rust 单二进制更统一 |
| 权限 | 需要额外包一层企业权限 | scope 从 API 到检索全链路传递 |
| 可观测 | 框架抽象较厚 | trace 表按业务字段设计 |
| 可替换 | 快速试验方便 | 生产链路组件边界更清晰 |
| 数据安全 | 依赖插件质量 | 明确控制外部调用和脱敏 |

可以借鉴 LangChain / LlamaIndex 的概念，例如 retriever、reranker、memory、tool calling，但生产实现保持本地领域模型和 adapter 边界。

## Agent Kernel 接口

```rust
pub struct AgentRequest {
    pub tenant_id: Uuid,
    pub user_id: Uuid,
    pub conversation_id: Uuid,
    pub original_query: String,
    pub effective_kb_ids: Vec<Uuid>,
    pub history: Vec<ConversationTurn>,
    pub options: AgentOptions,
}

pub struct AgentResponse {
    pub answer: String,
    pub citations: Vec<Citation>,
    pub confidence: Confidence,
    pub trace_id: Uuid,
    pub no_answer_reason: Option<NoAnswerReason>,
}
```

## 组件边界

### QueryRewriter

```rust
#[async_trait]
pub trait QueryRewriter {
    async fn rewrite(&self, input: RewriteInput) -> Result<RewriteOutput>;
}
```

输出必须包含 `original_query`、`rewritten_query`、`resolved_refs` 和 `needs_clarification`。

### Retriever

```rust
#[async_trait]
pub trait Retriever {
    async fn retrieve(&self, input: RetrievalInput) -> Result<Vec<RetrievedChunk>>;
}
```

Retriever 必须接收 `tenant_id` 和 `effective_kb_ids`，禁止在检索后才做权限过滤。

### Reranker

```rust
#[async_trait]
pub trait Reranker {
    async fn rerank(&self, query: &str, chunks: Vec<RetrievedChunk>) -> Result<Vec<RerankedChunk>>;
}
```

### AnswerGenerator

```rust
#[async_trait]
pub trait AnswerGenerator {
    async fn stream_answer(&self, input: GenerationInput) -> Result<AnswerStream>;
}
```

生成器只接收 reranked chunks，不直接访问文档库。

## 可配置策略

```yaml
rag:
  rewrite:
    enabled: true
    hyde_enabled: true
    model: qwen-turbo
  retrieval:
    dense_top_k: 100
    bm25_top_k: 100
    rrf_top_k: 20
    effective_top_k: 5
  rerank:
    enabled: true
    model: bge-reranker-v2-m3
    min_score: 0.3
  generation:
    model: deepseek-chat
    temperature: 0.2
    max_output_tokens: 1200
  citation:
    require_citation: true
    verify_claims: true
```

## 灵活性的工程保障

- 所有策略通过配置注入，不写死在 prompt 文本里
- Prompt 模板版本化，message trace 保存版本号
- Retriever、Reranker、LLM 都走 trait / adapter
- 单元测试覆盖无答案、越权、指代不明、引用缺失
- 离线评测集覆盖真实用户问题和人工修正样本

## 真实问题评测集

RAG 质量不能只靠模型自造问题评估。建议沉淀三类样本：

| 样本来源 | 用途 |
|---|---|
| 用户真实问题脱敏 | 衡量真实召回和答非所问比例 |
| 负反馈 + correction | 构建 golden answer |
| 管理员标注问题 | 覆盖关键业务文档和红线场景 |

每条评测样本至少包含：

```json
{
  "question": "Q3采购合同的付款节点是什么？",
  "kb_ids": ["kb_001"],
  "expected_doc_ids": ["doc_001"],
  "expected_chunk_ids": ["chunk_003"],
  "golden_answer": "首付款30%，验收后60%，质保期结束10%。",
  "must_cite": true
}
```

## 与现有模块关系

- Query Rewrite 文档描述改写算法，Agent Kernel 决定何时调用
- Hybrid Search / Reranking 文档描述检索排序，Retriever Adapter 负责接入
- Answer Generation 文档描述 prompt 组装与生成，Agent Prompting 约束角色和红线
- Conversation 数据模型保存全链路 trace，便于回放和评估

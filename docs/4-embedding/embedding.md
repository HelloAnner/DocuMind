# 向量化与向量存储（Embedding）

Embedding 是 Ingest Pipeline 的第四阶段：输入来自 Chunking 的 `chunks`，输出是写入 Elasticsearch 的**带稠密向量（dense vector）的索引文档**。它也是 Query Pipeline 中语义检索（Dense Retrieval）的基础。

## Pipeline 位置

```text
Upload
  -> Document Parsing        (产出 document_blocks / document_tables)
  -> Text Cleaning           (产出 cleaned_blocks)
  -> Chunking                (产出 chunks)
  -> Embedding               (产出 embedding_vector)
  -> Elasticsearch           (可检索文本 + 稠密向量)
  -> PostgreSQL              (权威结构与关系)
```

## 核心职责

1. **加载与管理 Embedding 模型**：本地 ONNX 模型或远程 Embedding API。
2. **批量向量化**：把 `chunks.content` 转成高维稠密向量。
3. **写入 Elasticsearch**：每个 chunk 对应一条 ES 文档，包含文本、元数据、稠密向量。
4. **支持混合检索**：ES 中同时保留 `dense_vector`（语义检索）和 `text` + 中文分词（BM25 关键词检索）。
5. **幂等去重、失败重试、模型热切换**：同一 chunk 同一模型只保留一份向量；失败可重试；模型切换时可重建索引。

## 输入：Chunk 数据形态

Embedding 阶段消费 PostgreSQL `chunks` 表中的权威记录。每条 chunk 至少包含以下字段：

```json
{
  "chunk_id": "chunk_001",
  "doc_id": "doc_001",
  "kb_id": "kb_001",
  "tenant_id": "tenant_001",
  "parse_job_id": "job_001",
  "chunk_index": 0,
  "source_type": "paragraph",
  "content": "标题路径：年度策略 / Q1 目标\n\n华东区 Q1 销售目标为 1200 万元。重点客户包括 A、B、C。",
  "heading_path": ["年度策略", "Q1 目标"],
  "page_range": [3, 3],
  "token_count": 45,
  "metadata": {
    "split_reason": "target_chunk_tokens",
    "overlap_tokens": 0
  }
}
```

> 向量化只关心 `content` 本身；`heading_path`、`page_range`、`source_type` 等字段原样进入 ES 用于过滤和展示。

## 为什么选用 Elasticsearch

DocuMind 把 Elasticsearch 作为统一的检索与向量存储媒介，而不是单独维护一个向量数据库：

| 能力           | Elasticsearch 方案                 | 独立向量库 + 倒排库方案   |
| -------------- | ---------------------------------- | ------------------------- |
| 稠密向量检索   | `dense_vector` + HNSW kNN          | 需额外 Milvus/Pinecone 等 |
| 全文关键词检索 | 原生 BM25 + `ik_max_word` 中文分词 | 需额外 Elasticsearch/Solr |
| 混合检索       | 一次查询同时跑 kNN + BM25 + RRF    | 需在应用层做结果融合      |
| 元数据过滤     | 与检索同索引，pre-filter           | 需跨系统拼接              |
| 运维成本       | 一套集群、一套备份、统一监控       | 多套系统、数据一致性复杂  |
| 成熟度         | ES 8.x 向量检索已生产可用          | 组合方案排错链路长        |

结论：Elasticsearch 一个索引即可承载**语义向量 + 关键词全文 + 元数据过滤 + RRF 融合**，与 DocuMind "混合检索优先" 的架构目标最匹配。

## 向量化模型方案

| 场景              | 推荐模型                        | 维度  | 部署方式          |
| ----------------- | ------------------------------- | ----- | ----------------- |
| 纯中文文档        | `bge-large-zh-v1.5`             | 1024d | 本地 ONNX Runtime |
| 中英混合文档      | `multilingual-e5-large`         | 1024d | 本地 ONNX Runtime |
| 无 GPU / 快速上线 | DashScope `text-embedding-v3`   | 1024d | HTTP API          |
| 多语言、高精度    | OpenAI `text-embedding-3-large` | 3072d | HTTP API          |

**默认推荐**：`bge-large-zh-v1.5`（1024 维，cosine 相似度）。

模型选择由知识库配置 `embedding_model` 决定，可在知识库粒度切换。切换模型时，系统会为该知识库重建 ES 索引并重新向量化所有 chunk。

## Embedding Worker 流程

```text
RabbitMQ 队列: documind.embedding.pending
  │
  ▼
Embedding Worker
  │
  ├── 1. 消费消息 { doc_id, parse_job_id, embedding_model }
  │
  ├── 2. 从 PostgreSQL 加载该 job 下所有未向量化的 chunks
  │
  ├── 3. 按 batch_size 批量调用 Embedding 模型
  │       ├─ 本地 ONNX: ort::Session::run
  │       └─ 远程 API : HTTP POST /embeddings
  │
  ├── 4. 写入 PostgreSQL chunk_embeddings（幂等键：chunk_id + embedding_model）
  │
  ├── 5. 批量写入 Elasticsearch `chunks` 索引
  │
  └── 6. 更新 documents.parse_status = 'indexed'
```

### 批量策略

- **batch_size**：本地 ONNX 建议 32 ~ 128；远程 API 按服务商限制（通常 32 ~ 100）。
- **max_concurrent_batches**：根据 GPU 显存或 API QPS 调整，默认 4。
- **空内容过滤**：`content` 为空或仅 whitespace 的 chunk 不进入向量化，但写入 ES 时 `embedding` 字段可留空或置零向量。

## Elasticsearch 索引设计

### 索引与别名

- **索引名**：`chunks`（单索引多租户，通过 `tenant_id` / `kb_id` 过滤）。
- **别名**：`chunks_search`（用于查询，重建索引时可零停机切换）。

### Settings & Mappings

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
      "chunk_id": { "type": "keyword" },
      "doc_id": { "type": "keyword" },
      "kb_id": { "type": "keyword" },
      "tenant_id": { "type": "keyword" },
      "parse_job_id": { "type": "keyword" },
      "chunk_index": { "type": "integer" },
      "source_type": { "type": "keyword" },
      "content": {
        "type": "text",
        "analyzer": "chinese_analyzer",
        "fields": {
          "keyword": { "type": "keyword", "ignore_above": 32766 }
        }
      },
      "heading_path": { "type": "keyword" },
      "page_range": { "type": "integer_range" },
      "token_count": { "type": "integer" },
      "table_ids": { "type": "keyword" },
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
      "created_at": { "type": "date" },
      "embedded_at": { "type": "date" }
    }
  }
}
```

### 字段说明

| 字段                         | 类型          | 说明                                             |
| ---------------------------- | ------------- | ------------------------------------------------ |
| `chunk_id`                   | keyword       | chunk 主键，也是 ES 文档 `_id`                   |
| `doc_id`                     | keyword       | 所属文档                                         |
| `kb_id`                      | keyword       | 所属知识库，检索范围过滤                         |
| `tenant_id`                  | keyword       | 租户隔离字段，所有查询必须带 `term` filter       |
| `parse_job_id`               | keyword       | 解析版本，用于版本切换和旧索引清理               |
| `chunk_index`                | integer       | 文档内顺序                                       |
| `source_type`                | keyword       | `paragraph` / `table` / `slide_note` / `code` 等 |
| `content`                    | text          | 用于 BM25 全文检索和 LLM 上下文                  |
| `heading_path`               | keyword       | 标题路径，用于过滤和展示                         |
| `page_range`                 | integer_range | 页码/slide 范围                                  |
| `token_count`                | integer       | content token 数                                 |
| `table_ids`                  | keyword       | 关联表格 ID，便于回表取完整表格                  |
| `embedding`                  | dense_vector  | 1024 维稠密向量，HNSW 索引，cosine 相似度        |
| `created_at` / `embedded_at` | date          | 创建与向量化时间                                 |

### HNSW 参数调优

| 参数              | 默认值    | 说明                                             |
| ----------------- | --------- | ------------------------------------------------ |
| `m`               | 16        | 每个节点双向连接数，越大召回越高、内存越大       |
| `ef_construction` | 200       | 构建图时的搜索宽度，越大构建越慢、图质量越高     |
| `ef`（查询时）    | 100 ~ 200 | 查询搜索宽度，通过 `knn.num_candidates` 间接控制 |

## ES 文档示例

写入 ES 后的单条 chunk 文档形态：

```json
{
  "chunk_id": "chunk_002",
  "doc_id": "doc_001",
  "kb_id": "kb_001",
  "tenant_id": "tenant_001",
  "parse_job_id": "job_001",
  "chunk_index": 1,
  "source_type": "table",
  "content": "标题路径：年度策略 / Q2 目标\n表格：区域销售目标\n\n| 区域 | 目标 |\n|---|---|\n| 华东 | 1300 万 |\n| 华南 | 1000 万 |",
  "heading_path": ["年度策略", "Q2 目标"],
  "page_range": { "gte": 1, "lte": 1 },
  "token_count": 28,
  "table_ids": ["tbl_001"],
  "embedding": [0.012, -0.034, 0.089, "... 1024 dims ..."],
  "created_at": "2026-06-23T10:00:00Z",
  "embedded_at": "2026-06-23T10:05:00Z"
}
```

> ES 不是权威存储。`chunks` 表和 `chunk_embeddings` 表保存权威数据，ES 索引可随时从 PostgreSQL 重建。

## 幂等去重

Embedding 阶段必须保证同一 chunk、同一模型只生成一份向量。

- **PostgreSQL 幂等键**：`UNIQUE(chunk_id, embedding_model)`。
- **ES 文档 `_id`**：直接使用 `chunk_id`，`index` 操作天然幂等（重复写入覆盖旧文档）。
- **内容变更检测**：通过 `content_hash = md5(content)` 判断 content 是否变化；无变化时跳过模型调用，直接复用已有向量。

```text
embedding_identity = sha256(chunk_identity + embedding_model + embedding_config)
```

`chunk_identity` 已在 Chunking 阶段计算；任一 embedding 模型或配置变更都会触发下游重新向量化。

## 失败重试

| 失败场景           | 处理策略                                                   |
| ------------------ | ---------------------------------------------------------- |
| Embedding API 超时 | 按指数退避重试 3 次，仍失败则标记 `status = 'failed'`      |
| 模型返回非 200     | 记录 `error_message`，不入 ES                              |
| ES 写入失败        | 重试 3 次；仍失败则保留 PostgreSQL 向量，人工/定时任务补偿 |
| chunk 内容为空     | 跳过向量化，ES 中 `embedding` 置零向量或不写该字段         |

`chunk_embeddings.status` 状态机：

```text
pending -> running -> completed
              |
              └-----> failed (可重试)
```

## 模型热切换与索引重建

当管理员切换知识库 embedding 模型时：

1. 为该 `kb_id` 下的所有 chunk 生成新的 `embedding_identity`。
2. 异步向量化所有 chunk 到新模型，写入新的 ES 文档（因 `_id` 不变，会覆盖旧向量）。
3. 向量化完成后，切换 `knowledge_base.embedding_model` 为新的模型名。
4. 保留最近 2 个旧模型版本的 `chunk_embeddings` 记录，便于回滚；更旧的版本由后台清理任务删除。

## 查询流程

Embedding 阶段的最终产物在 Query Pipeline 中这样使用：

```text
用户问题
  │
  ▼
Query Rewrite (LLM)
  │  输出 rewritten_query + keywords + hypothetical_answer(HyDE 可选)
  ▼
Elasticsearch Hybrid Search
  │  ├─ kNN: query_vector -> embedding 字段 -> cosine Top-100
  │  ├─ BM25: rewritten_query -> content 字段 -> Top-100
  │  └─ pre-filter: tenant_id + kb_id + 其他元数据
  │
  ▼
RRF Fusion (k=60) -> Top-20
  ▼
Reranker (Cross-Encoder) -> Top-5
  ▼
阈值过滤 (score >= 0.3) -> 进入 LLM 生成答案
```

### Hybrid Search 请求示例

```json
// POST /chunks/_search
{
  "size": 20,
  "query": {
    "bool": {
      "must": [
        {
          "multi_match": {
            "query": "2025年 Q3 采购合同 付款节点",
            "fields": ["content"],
            "type": "best_fields"
          }
        }
      ],
      "filter": [
        { "term": { "tenant_id": "tenant_001" } },
        { "terms": { "kb_id": ["kb_001", "kb_002"] } }
      ]
    }
  },
  "knn": {
    "field": "embedding",
    "query_vector": [0.012, -0.034, "... 1024 dims ..."],
    "k": 100,
    "num_candidates": 200,
    "filter": [
      { "term": { "tenant_id": "tenant_001" } },
      { "terms": { "kb_id": ["kb_001", "kb_002"] } }
    ]
  },
  "rank": {
    "rrf": {
      "window_size": 100,
      "rank_constant": 60
    }
  }
}
```

## 配置项

| 环境变量 / 配置键          | 说明                | 默认值 / 示例                   |
| -------------------------- | ------------------- | ------------------------------- |
| `EMBEDDING_PROVIDER`       | 模型来源            | `onnx` / `dashscope` / `openai` |
| `EMBEDDING_MODEL`          | 模型名              | `bge-large-zh-v1.5`             |
| `EMBEDDING_DIM`            | 向量维度            | `1024`                          |
| `EMBEDDING_BATCH_SIZE`     | 单次向量化 chunk 数 | `32`                            |
| `EMBEDDING_MAX_CONCURRENT` | 并发批次数          | `4`                             |
| `EMBEDDING_RETRY_MAX`      | 失败重试次数        | `3`                             |
| `ES_URL`                   | Elasticsearch 地址  | `http://localhost:9200`         |
| `ES_INDEX_CHUNKS`          | chunk 索引名        | `chunks`                        |
| `ES_INDEX_ALIAS`           | 查询别名            | `chunks_search`                 |

## 安全与隔离

- **租户隔离**：所有 ES 查询必须带 `tenant_id` term filter；`kb_id` 作为知识库范围过滤。
- **索引权限**：生产环境 ES 角色应限制只能访问 `chunks` 索引，禁止直接操作 `_cluster` 等管理接口。
- **API Key 安全**：远程 Embedding API Key 只保存在后端 `.env`，不暴露给前端。

## 可观测性

### 关键指标

| 指标                       | 目标     | 说明                   |
| -------------------------- | -------- | ---------------------- |
| `embedding_success_rate`   | >= 99%   | 向量化成功 chunk 占比  |
| `embedding_avg_latency_ms` | 可预期   | 单 batch 平均耗时      |
| `embedding_queue_lag`      | 不堆积   | MQ 中待处理消息数      |
| `es_index_size_mb`         | 可预期   | 索引大小，辅助扩容决策 |
| `es_query_p99_ms`          | <= 200ms | 混合检索 P99 延迟      |

### 结构化日志

```json
{
  "event": "document_embedded",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "embedding_model": "bge-large-zh-v1.5",
  "chunk_count": 47,
  "batch_count": 3,
  "duration_ms": 1234,
  "failed_chunks": 0,
  "version": "documind-embedder@0.1.0"
}
```

## 相关文档

- [Chunking 统一切分策略](../3-chunking/chunking.md)
- [Chunk 输出数据形态](../3-chunking/chunk-output.md)
- [混合检索](../7-hybrid-search/README.md)
- [Reranking](../8-reranking/README.md)
- [知识库管理](../5-knowledge-base/knowledge-base.md)

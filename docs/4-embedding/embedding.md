# 向量化与向量存储（Embedding）

本文描述 DocuMind 当前已经落地的向量化链路。PostgreSQL 是权威数据源，Elasticsearch 是可重建的在线检索副本，RabbitMQ 用于任务通知，`vector_jobs` 用于任务状态持久化。

## 当前数据流

```text
文档解析
  -> PostgreSQL: document_blocks / cleaned_blocks / chunks
  -> PostgreSQL: vector_jobs(pending)
  -> RabbitMQ: documind.embedding.pending（通知）
  -> Vector Worker
       1. 按最新 parse_job 读取 chunks
       2. 构造 embedding input
       3. 调用 OpenAI-compatible /embeddings
       4. PostgreSQL: chunk_embeddings.embedding_values
       5. Elasticsearch: 版本化物理索引
       6. 刷新并核验该文档的 chunk 数
       7. PostgreSQL: documents.parse_status=indexed
```

RabbitMQ 消息只携带 `vector_job_id`，任务内容、重试次数、租约和错误均保存在 PostgreSQL。RabbitMQ 不可用时，Worker 仍会轮询 `vector_jobs`，因此通知丢失或服务重启不会丢任务。当前 Worker 与 API 位于同一个 Rust 二进制中，但任务本身已脱离进程内 `tokio::spawn` 状态，可恢复、可重试、可审计。

## PostgreSQL 中存什么

### `chunks`

保存解析后当前及历史 parse job 的文本切片、标题路径、页码、表格和 source anchor。`documents.latest_parse_job_id` 指向当前有效版本，向量化和重建只消费该版本。

### `chunk_embeddings`

保存可重建 ES 索引所需的权威向量：

| 字段 | 说明 |
|---|---|
| `chunk_id + embedding_model` | 幂等键 |
| `embedding_values REAL[]` | 当前权威向量存储，避免 JSONB 数字带来的额外空间 |
| `embedding_dim` | 维度校验，必须等于数组长度 |
| `content_hash` | embedding input 的 SHA-256；内容未变时复用向量 |
| `status` | 向量生成状态：`running/completed/failed` |
| `index_status` | ES 写入状态：`pending/indexed/failed` |
| `index_name/indexed_at` | 实际写入的物理索引与时间 |

旧字段 `embedding_vector JSONB` 仅为滚动发布兼容而保留，数据写成空数组；不再作为权威向量存储。

### `vector_jobs`

保存 `index_document` 和 `rebuild_index` 两类持久化任务。Worker 通过 `FOR UPDATE SKIP LOCKED` 领取任务并设置租约；进程异常后过期租约会恢复为 `pending`。失败采用指数退避，超过 `EMBED_RETRY_MAX` 后进入 `failed`，同时发布到 `documind.embedding.dead`。

### `vector_index_versions`

记录查询别名、物理索引、模型、维度、schema 版本和 `building/active/retired/failed` 状态，是索引版本的控制面记录。

## Embedding input 与复用

模型输入由以下内容组成：

```text
文档：<document title>
章节：<heading path>
<chunk 正文>
```

用于展示的 `标题路径：`、`页码：`、`Slide：` 和 `【上文】/【下文】` 标记不会重复进入模型输入。系统对最终 input 计算 SHA-256；同一 chunk、模型、维度且 hash 未变化时直接复用 `REAL[]` 向量，只为新增或变化的 chunk 调用模型。

所有返回向量必须满足：数量与请求一致、维度等于 `EMBED_DIM`、元素均为有限数值。HTTP 传输错误、429 和 5xx 会在单次任务内指数退避重试；任务级失败还会由 `vector_jobs` 再次调度。

## 分块策略

默认配置为结构感知切分：目标 800 tokens、最大 1500、最小 200、相邻重叠 200。当前实现还包括：

- PDF 的启发式短标题不再被当作强制 H1 边界，避免大量几十 token 的碎片。
- 长文本按句子和字符硬切，重叠预算预留在最大长度内。
- Markdown 表格按行数和 token 双阈值拆分，每一片重复表头；超长单行继续硬切。
- 兼容的短尾块在不超过最大长度时合并；表格、跨 slide、跨一级标题不合并或重叠。

## Elasticsearch 中存什么

ES 保存在线混合检索副本。物理索引名包含 schema、模型和维度，例如：

```text
chunks-v2-text-embedding-v3-1024
```

查询始终访问别名 `chunks_search`。主要字段包括：

- 身份和隔离：`chunk_id/doc_id/parse_job_id/tenant_id/kb_id`
- 文本和结构：`doc_title/file_type/content/heading_path/heading_text/source_type`
- 引用定位：`anchor_*`、页码、slide、block/table IDs
- 向量：`embedding_model` 与 `dense_vector embedding`

`content`、`doc_title`、`heading_text` 使用 Elasticsearch 内置 `cjk` analyzer，并保留 `content.standard` 子字段；向量使用 cosine HNSW（`m=16`、`ef_construction=200`）。Dense 和 BM25 查询都强制过滤 `tenant_id`、知识库范围和当前 `embedding_model`，结果在应用层用 RRF 融合。

## 一致性与索引重建

索引重建写入一个未挂载查询别名的新物理索引。全部文档完成后，系统比较 PostgreSQL 当前有效 chunk ID 集合与 ES `_id` 集合；只有缺失数和陈旧数都为 0 才原子切换别名并把版本标记为 `active`。切换成功后清理旧物理索引。

系统启动和定时巡检都会执行同样的 ID 级对账，而不只比较总数。发现缺失或陈旧 chunk 时自动创建持久化重建任务。别名已经切换但数据库状态尚未落盘的异常窗口也可以在重试时恢复。

文档删除、排除检索、替换文件和强制重解析都会清理查询别名中的旧 chunk，并取消未完成的文档向量任务。Worker 在最终提交状态时还会再次检查 `latest_parse_job_id` 和排除状态；如果文档已变化，会清理刚写入的 ES 数据，避免竞态产生孤儿。

## 完成语义

`documents.parse_status = indexed` 只表示以下条件已经全部满足：

1. 当前 parse job 的所有 chunk 都有合法的权威向量；
2. 这些 chunk 已写入目标物理索引；
3. ES refresh 后该文档、该 parse job 的数量与 PostgreSQL 一致；
4. 文档仍指向同一个 parse job，且未被排除。

因此“向量已生成”和“检索索引已可用”不再混为同一个状态。

## 运维入口

- `GET /api/system/vector-indexes/reconcile`：返回物理索引、期望/实际、missing/stale 和一致性。
- `POST /api/system/vector-indexes/rebuild`：创建持久化的全量重建任务。
- `GET /api/health`：用低成本计数检查 `vector_index_consistent`；ID 级巡检由后台和 reconcile API 执行。
- `GET /api/metrics`：暴露 vector job 状态、embedding/index 状态以及期望、实际和计数漂移。
- RabbitMQ 队列：`documind.embedding.pending`、`documind.embedding.dead`。

## 配置项

| 配置 | 默认值 | 说明 |
|---|---:|---|
| `EMBED_MODEL` | `text-embedding-v3` | OpenAI-compatible 模型名 |
| `EMBED_DIM` | `1024` | 模型和 ES mapping 的固定维度 |
| `EMBED_BASE_URL` | - | API base URL，客户端调用 `/embeddings` |
| `EMBED_API_KEY` | - | 服务端密钥 |
| `EMBED_BATCH_SIZE` | `10` | 每批 chunk 数，允许 1–100 |
| `EMBED_RETRY_MAX` | `3` | HTTP 与持久化任务最大尝试次数 |
| `EMBED_WORKER_POLL_MS` | `1000` | PostgreSQL 补偿轮询间隔 |
| `EMBED_ENABLED` | `true` | 是否启用真实向量链路 |
| `ES_INDEX_CHUNKS` | `chunks` | 物理索引名前缀 |
| `ES_INDEX_ALIAS` | `chunks_search` | 线上查询别名 |
| `ES_INDEX_SCHEMA_VERSION` | `2` | mapping/schema 版本 |

分块配置使用 `RAG_TARGET_CHUNK_TOKENS`、`RAG_MAX_CHUNK_TOKENS`、`RAG_HARD_SPLIT_TOKENS`、`RAG_MIN_CHUNK_TOKENS`、`RAG_CHUNK_OVERLAP_TOKENS`、`RAG_MAX_TABLE_ROWS_PER_CHUNK` 和 `RAG_MAX_TABLE_TOKEN_PER_CHUNK`。

## 安全边界

- PostgreSQL、ES 查询和索引文档都携带 `tenant_id/kb_id`；检索必须使用授权后的知识库集合。
- Embedding API Key 只保存在服务器 `.env`。
- ES 是派生数据，不能反向覆盖 PostgreSQL；索引丢失时从 `chunks + chunk_embeddings` 重建。

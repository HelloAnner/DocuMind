# 混合检索 (Hybrid Search)

混合检索是 Query Pipeline 的第二阶段，负责把改写后的查询同时送入 **Dense 向量检索**与 **Sparse BM25 关键词检索**，经元数据预过滤和 RRF 融合后，向 Reranker 输出高质量候选池。其核心目标是用语义相似性覆盖同义/近义表达，用 BM25 覆盖术语、数字、日期、条款编号等精确匹配场景。

## 1. 定位与边界

- **做什么**：一次请求内完成 Dense + Sparse + Metadata Filter + RRF 融合，返回 Top-K 候选。
- **不做什么**：不做最终答案生成；不做跨轮历史推理；不做权限判断（权限 filter 由上游传入）。
- **核心红线**：元数据过滤必须是 **pre-filter**，保证 Top-K 不会被无关结果稀释；检索结果必须保留完整引用链（chunk_id → doc_id → 页码/标题路径）。

## 2. 整体架构

```text
RewriteOutput
    │
    ├── rewritten_query ───────┐
    ├── keywords ──────────────┤
    ├── hypothetical_answer ───┤
    └── sub_queries ───────────┤
                             │
    ┌────────────────────────▼────────────────────────┐
    │              Hybrid Search Engine              │
    │  ┌─────────────┐  ┌─────────────┐  ┌─────────┐│
    │  │ Dense kNN   │  │ Sparse BM25 │  │ Metadata││
    │  │ (语义)      │  │ (关键词)    │  │ Pre-filter│
    │  └──────┬──────┘  └──────┬──────┘  └────┬────┘│
    │         └─────────────────┼──────────────┘     │
    │                           ▼                    │
    │                    RRF Fusion                  │
    │                           │                    │
    │                           ▼                    │
    │                      Top-20                    │
    └────────────────────────────────────────────────┘
                             │
                             ▼
                        Reranker
```

## 3. Dense Vector Search

### 3.1 查询向量化

- 对 `rewritten_query` 做 embedding，得到主查询向量 `q_dense`。
- 若启用 HyDE，对 `hypothetical_answer` 做 embedding 得到 `q_hyde`。
- 融合策略：
  - **默认**：仅使用 `q_dense`。
  - **HyDE 开启**：`q_final = normalize(0.7 * q_dense + 0.3 * q_hyde)`。
  - 也可对两路结果独立检索后做 RRF 合并，复杂度更高，默认不开启。

### 3.2 ES kNN 参数

```json
{
  "knn": {
    "field": "embedding",
    "query_vector": [0.012, -0.034, "..."],
    "k": 100,
    "num_candidates": 200,
    "filter": { "terms": { "kb_id": ["kb_001"] } }
  }
}
```

- `k`：最终返回候选数，默认 100。
- `num_candidates`：HNSW 最近邻搜索候选数，默认 200，影响召回/延迟 trade-off。
- `filter`：与元数据预过滤共用，ES 会在 kNN 搜索前应用。
- 相似度：`cosine`（对文档长度差异鲁棒）。

### 3.3 多向量子查询

Multi-Query 产生的每个子查询独立做 kNN，得到各自的 Top-100，最后与 BM25 结果一起做全局 RRF。

## 4. Sparse BM25 Search

### 4.1 查询构造

BM25 查询由 `keywords` 和 `rewritten_query` 共同生成：

- **主查询**：`rewritten_query` 全文匹配 `content` 字段，使用 `ik_max_word` 分词。
- **关键词增强**：`keywords` 中的核心概念以 `must` 或 `should` 短语形式加入，提升术语、数字、日期的精确命中。
- **标题路径匹配**：`heading_path` 字段做 keyword 短语匹配，命中章节标题时加权。

### 4.2 多字段加权

```json
{
  "multi_match": {
    "query": "2025年Q3采购合同 付款节点",
    "fields": ["content^3", "heading_path^2", "content.keyword^1"],
    "type": "best_fields",
    "operator": "or"
  }
}
```

### 4.3 短语与邻近匹配

- 对连续术语（如"付款节点""违约责任"）使用 `match_phrase` 或 `multi_match` with `type=phrase`。
- 对数字/日期/条款编号使用 `term` 精确匹配 `content.keyword`。

### 4.4 同义词扩展

- 同义词扩展在改写阶段完成，BM25 接收扩展后的 `keywords` 列表，不在检索层做额外同义词。
- 避免无限制同义词导致精度下降。

## 5. 元数据预过滤 (Metadata Pre-filter)

### 5.1 过滤字段

| 字段 | 类型 | 用途 |
|---|---|---|
| `tenant_id` | keyword | 租户隔离，必传 |
| `kb_id` | keyword | 知识库范围，必传 |
| `doc_id` | keyword | 单文档限定 |
| `source_type` | keyword | paragraph / table / slide_note |
| `tags` | keyword | 文档标签 |
| `created_at` | date | 上传时间范围 |
| `page_range` | integer_range | 页码范围 |

### 5.2 Pre-filter 语义

- 所有过滤条件在 kNN / BM25 搜索**之前**应用，确保进入 RRF 的结果都在有效候选池内。
- 禁止在检索完成后做后过滤来修正权限或范围，避免 Top-K 被稀释。

```json
{
  "bool": {
    "filter": [
      { "term": { "tenant_id": "t_001" } },
      { "terms": { "kb_id": ["kb_001", "kb_002"] } },
      { "range": { "created_at": { "gte": "2025-01-01" } } }
    ]
  }
}
```

## 6. 关键词与向量检索的对接

### 6.1 查询分发

```text
rewritten_query  ──► Dense Vector (q_dense)
keywords         ──► Sparse BM25 (must/should 短语)
hypothetical_answer ──► Dense Vector (q_hyde, optional)
sub_queries[i]   ──► 独立 Dense + Sparse，结果合并
```

### 6.2 结果合并

- 每个子查询各自产出 Dense Top-K 和 Sparse Top-K。
- 同一 chunk 在不同子查询中重复命中时，取最佳排名参与 RRF。
- 多路结果进入统一 RRF 前，先按 chunk_id 去重，保留最高原始分数与最早来源标记。

## 7. RRF 融合

### 7.1 公式

```text
RRF_score(d) = Σ 1 / (k + rank_i(d))
              i∈{dense, sparse, sub_dense, sub_sparse, ...}

k = 60（默认）
```

- `rank_i(d)`：文档 d 在第 i 路结果中的排名（从 1 开始）。
- 未出现在某一路结果中的文档，该路贡献为 0。

### 7.2 窗口与 Top-K

- 各路检索统一取 Top-100 进入 RRF。
- RRF 后取 Top-20 送入 Reranker。
- `window_size` 与 RRF 的 `rank_window_size` 默认一致，避免远端排名噪声。

### 7.3 ES 内置 RRF

Elasticsearch 8.x 支持在单次请求内执行 `sub_searches` + `rrf`，推荐直接使用：

```json
{
  "sub_searches": [
    {
      "query": {
        "knn": {
          "field": "embedding",
          "query_vector": ["..."],
          "k": 100,
          "num_candidates": 200
        }
      }
    },
    {
      "query": {
        "multi_match": {
          "query": "2025年Q3采购合同 付款节点",
          "fields": ["content^3", "heading_path^2"]
        }
      }
    }
  ],
  "rank": {
    "rrf": {
      "window_size": 100,
      "rank_constant": 60
    }
  },
  "size": 20
}
```

> 注意：ES 内置 RRF 需保证两路查询的 `filter` 一致；Tenant / KB 过滤通过外层 `query.bool.filter` 统一应用。

## 8. 结果后处理

### 8.1 去重与合并

- 同一文档同一页出现多个 chunk 时，优先保留内容最完整、排名最高的 chunk。
- 同一文档相邻页 chunk 可合并为一个证据单元，但保留原始 chunk_id 列表用于引用。

### 8.2 多样性控制

- 若 Top-20 中来自同一文档的 chunk 过多，可适当降低同文档后续 chunk 的 RRF 得分，保证候选多样性。
- 默认单文档占比不超过 60%。

### 8.3 无结果处理

- Dense 与 Sparse 均无可行候选时，Reranker 无输入，Agent 直接返回「未找到相关文档」。
- 仅一路有结果时，RRF 退化为该路排名，仍送 Reranker。

## 9. 性能与调优

| 参数 | 默认值 | 调优方向 |
|---|---|---|
| `dense.k` | 100 | 召回要求高可增大，延迟敏感可减小 |
| `dense.num_candidates` | 200 | 通常设置为 2k |
| `bm25.top_k` | 100 | 与 dense 对齐 |
| `rrf.rank_constant` | 60 | 越小越重视高排名，越大越平滑 |
| `rrf.window_size` | 100 | 与各路 Top-K 一致 |
| `output.top_k` | 20 | 给 Reranker 的候选数 |

## 10. 失败与降级策略

| 场景 | 处理 |
|---|---|
| ES 不可用 | 返回明确错误，不返回空结果误导用户 |
| Dense 失败但 Sparse 可用 | 仅使用 Sparse 结果，标记置信度降级 |
| Sparse 失败但 Dense 可用 | 仅使用 Dense 结果，丢失精确匹配能力 |
| RRF 配置异常 | 退化为按 Dense 排名输出 |
| 元数据过滤后候选池为空 | 立即返回 `NO_RELEVANT_CHUNKS`，不进入 Reranker |

## 11. 评估指标

| 指标 | 说明 |
|---|---|
| `retrieval.recall@5` | Top-5 内包含正确答案的 chunk 比例 |
| `retrieval.recall@20` | Top-20 召回率 |
| `retrieval.dense_vs_sparse_contribution` | Dense / Sparse 各自对最终 RRF 的贡献 |
| `retrieval.empty_rate` | 检索无结果比例 |
| `retrieval.latency_p95` | 检索 P95 延迟 |

## 12. 相关文档

- [查询改写](../6-query-rewriting/query-rewriting.md)
- [精排](../8-reranking/reranking.md)
- [答案生成](../9-answer-generation/answer-generation.md)
- [ES 索引设计](../prd.md#52-es-索引设计)

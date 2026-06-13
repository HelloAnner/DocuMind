# 混合检索 (Hybrid Search)

融合向量语义检索与 BM25 关键词检索，利用 Elasticsearch 原生的 hybrid search 在一次查询中完成两路检索 + RRF 融合。Query Pipeline 的第二阶段。

## 核心职责

- **Dense Vector Search**：查询向量 → ES kNN (HNSW)，cosine 相似度，Top-100
- **Sparse BM25 Search**：将 rewritten_query 和 keywords 分别投入 ES 倒排索引检索，Top-100
- **Metadata Filter**：按知识库、标签、时间范围在 ES query 中做 pre-filter（不稀释候选池）
- **RRF 融合**：ES 内置 RRF（k=60），两路结果融合后直接返回 Top-20

## 设计要点

混合检索从两路并行 + 应用层融合简化为一个 ES hybrid query。预过滤（pre-filter）在 ES 内部完成，保证 Top-K 不被无关结果稀释。BM25 补偿向量检索在术语、数字、日期等精确匹配场景的短板。

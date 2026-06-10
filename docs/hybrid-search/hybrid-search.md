# 混合检索 (Hybrid Search)

融合多路检索结果，取各路线索之长。Query Pipeline 的第二阶段。

## 核心职责

- **Dense Vector Search**：PGVector cosine 相似度，Top-100（语义匹配）
- **Sparse BM25 Search**：PG tsvector + zhparser 中文分词，Top-100（关键词精确匹配）
- **Metadata Filter**：按知识库、标签、时间范围做预过滤
- **RRF 融合**：Reciprocal Rank Fusion（k=60），三路结果融合取 Top-20 送入 Reranker

## 设计要点

预过滤（pre-filter）而非后过滤，确保 Top-K 不被无关结果稀释。BM25 补偿向量检索在术语、数字、日期等精确匹配场景的短板。

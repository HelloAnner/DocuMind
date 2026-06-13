# 向量化 (Embedding)

将文本 chunk 转为高维向量存入 Elasticsearch，是 Ingest Pipeline 的第四阶段，也是 Query Pipeline 的语义检索基础。

## 核心职责

- 加载和管理 Embedding 模型（默认 bge-large-zh-v1.5，ONNX Runtime 本地推理）
- 批量向量化 chunk → 写入 Elasticsearch（dense_vector 字段 + HNSW 索引）
- 支持模型热切换（重建索引），失败重试与幂等去重

## 模型方案

| 场景 | 推荐 |
|---|---|
| 纯中文 | bge-large-zh-v1.5 (1024d) |
| 中英混合 | multilingual-e5-large (1024d) |
| 无 GPU | DashScope / OpenAI API |

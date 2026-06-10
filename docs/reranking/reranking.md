# 精排 (Reranking)

对混合检索返回的 Top-20 候选做精细重排序，Query Pipeline 的第三阶段。粗排靠向量+关键词，精排靠深度语义匹配。

## 核心职责

- 加载 Cross-Encoder Reranker 模型（bge-reranker-v2-m3）
- 对每个 (query, chunk) pair 独立打分
- 按 rerank_score 降序 → Top-5
- 阈值过滤：score < 0.3 的丢弃，全部 < 0.3 返回"未找到相关文档"

## 设计要点

reranker 是检索质量的最后一道防线，宁可答不出也不瞎编。低分结果必须明确拒答。

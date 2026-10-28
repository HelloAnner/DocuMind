# 精排 (Reranking)

精排是 Query Pipeline 的第三阶段，负责对混合检索返回的 Top-20 候选做深度语义匹配重排序。粗排（Dense + BM25 + RRF）解决“召回”，精排解决“准排”。Reranker 是检索质量的最后一道防线：宁可答不出，也不能把低相关 chunk 送进生成阶段。

## 1. 定位与边界

- **做什么**：对 `(query, chunk)` pair 做交叉编码器打分，按相关性重排并过滤低分候选。
- **不做什么**：不改变 chunk 内容；不补充新证据；不替代 Query Rewrite 或 Context Assembly。
- **核心红线**：低于阈值的结果必须丢弃；若全部低于阈值，必须明确返回「未找到相关文档」。

## 2. 模型与部署

### 2.1 默认模型

| 模型 | 类型 | 适用场景 |
|---|---|---|
| **bge-reranker-v2-m3** | Cross-Encoder | 中文企业文档，本地部署，推荐默认 |
| **Cohere Rerank API** | SaaS | 多语言、无本地 GPU 时备选 |

### 2.2 本地部署方式

- **ONNX Runtime（推荐）**：将 `bge-reranker-v2-m3` 导出为 ONNX，Rust 通过 `ort` crate 推理，保持单二进制、无外网依赖。
- **独立推理服务**：若本地推理资源不足，可启动一个轻量 Python/reranker 服务，通过 HTTP 调用；默认不走此路径，避免增加运维复杂度。

### 2.3 输入限制

- 最大序列长度：512 tokens（query + chunk）。
- chunk 超长时，保留前 512 tokens 并截断，避免影响打分。

## 3. 输入输出契约

### 3.1 输入

```json
{
  "query": "2025年Q3采购合同约定的付款节点是什么？",
  "chunks": [
    {
      "chunk_id": "chunk_003",
      "doc_id": "doc_001",
      "content": "合同签署后，甲方应在5个工作日内支付首付款30%……",
      "rrf_rank": 3,
      "source": "rrf"
    }
  ],
  "top_k": 5,
  "min_score": 0.3
}
```

### 3.2 输出

```json
{
  "reranked": [
    {
      "chunk_id": "chunk_003",
      "doc_id": "doc_001",
      "score": 0.87,
      "rank": 1,
      "source": "rerank"
    }
  ],
  "dropped_count": 15,
  "below_threshold_count": 10
}
```

## 4. 打分与归一化

### 4.1 分数来源

Cross-Encoder 输出 logits，经 sigmoid 映射为 `[0, 1]` 的概率型相关性分数：

```text
rerank_score = sigmoid(logit)
```

### 4.2 与 RRF 的关系

- RRF 排名仅用于选择进入精排的候选池。
- 精排分数覆盖 RRF 分数，作为最终排序依据。
- 保留 `rrf_rank` 用于后续 trace 分析，便于对比粗排与精排差异。

### 4.3 阈值过滤

- 默认 `min_score = 0.3`。
- 分数 `< 0.3` 的 chunk 直接丢弃，不计入 Top-K。
- 若全部候选 `< 0.3`，返回 `NO_RELEVANT_CHUNKS`，不再调用 LLM 生成。

## 5. 与 Hybrid Search 的对接

```text
Hybrid Search Top-20
    │
    ▼
Reranker (cross-encoder)
    │
    ├── 全部 < min_score ──► 返回「未找到相关文档」
    │
    └── 有 ≥ min_score ──► 取 Top-5 ──► Context Assembly
```

- Reranker 输入候选数可配置，默认 20；候选越多延迟越高，但召回更稳。
- 对 Multi-Query 结果，进入 Reranker 的候选已经过全局 RRF 合并去重。

## 6. 批处理与性能

### 6.1 批处理策略

- Cross-Encoder 对单个 pair 打分，但可批量并行推理。
- 默认 batch_size = 8，根据本地 GPU/CPU 资源调整。
- 延迟要求：P95 内精排 ≤ 500ms（20 个候选）。

### 6.2 异步与超时

- Reranker 调用设置独立超时（默认 3s）。
- 超时或失败时，退化为使用 RRF 排名直接输出 Top-5，并标记置信度降级。

### 6.3 缓存

- 对高频 `(query_fingerprint, chunk_id)` pair 可缓存精排分数，降低重复开销。
- 缓存 TTL 与文档版本绑定，文档更新后自动失效。

## 7. 动态 Top-K 与阈值

| 场景 | 策略 |
|---|---|
| 分数分布集中且均较高 | 正常取 Top-5 |
| Top-5 之间分差 > 0.4 | 只取前 3，避免低分证据混入 |
| Top-5 方差 < 0.1 | 说明问题宽泛，可能需提示用户缩小范围 |
| 部分 chunk 同文档同页 | 去重合并，保留最完整者 |

## 8. 失败与降级策略

| 场景 | 处理 |
|---|---|
| Reranker 服务不可用 | 退化为 RRF Top-5，置信度降级为 medium/low |
| 模型推理超时 | 已完成的 batch 结果可用，未完成的用 RRF 排名补齐 |
| 输入候选为空 | 直接返回 `NO_RELEVANT_CHUNKS` |
| 全部候选低于阈值 | 返回「未找到相关文档」，建议换关键词或知识库 |

## 9. 评估指标

| 指标 | 说明 |
|---|---|
| `rerank.mrr` | 精排后正确答案的平均倒数排名 |
| `rerank.ndcg@5` | 精排结果排序质量 |
| `rerank.threshold_pass_rate` | 超过阈值的比例 |
| `rerank.latency_p95` | 精排 P95 延迟 |
| `rerank.fallback_rate` | 降级到 RRF 的比例 |

## 10. 相关文档

- [混合检索](../7-hybrid-search/hybrid-search.md)
- [答案生成](../9-answer-generation/answer-generation.md)
- [上下文策略](../10-conversation/context-policy.md)

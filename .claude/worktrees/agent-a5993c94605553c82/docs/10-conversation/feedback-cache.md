# 反馈与缓存 (Feedback & Cache)

反馈和缓存属于 Conversation 域的两个闭环能力：反馈用于提升问答质量和排查问题，缓存用于降低重复问题的延迟和成本。两者都必须保留引用链，不能牺牲可信溯源。

## 用户反馈

反馈入口挂在 assistant message 上，而不是 conversation 上。这样可以精确定位某一次回答的检索、生成和引用问题。

### 反馈类型

| rating | reason | 说明 |
|---|---|---|
| `up` | `helpful` | 答案有帮助 |
| `down` | `wrong_answer` | 答案内容错误 |
| `down` | `missing_source` | 引用缺失或引用不支持结论 |
| `down` | `outdated` | 文档版本或答案过期 |
| `down` | `not_helpful` | 没有解决问题 |
| `down` | `other` | 其他原因 |

### 质量回流

负反馈需要关联完整 trace，形成可分析样本：

```text
feedback
  -> assistant_message
  -> parent user_message
  -> query_trace
  -> retrieval_trace
  -> citations
```

可用于分析：

- Query Rewrite 是否错误补全了指代
- Hybrid Search 是否召回不足
- Reranker 是否把相关 chunk 排低
- Prompt 是否没有约束好引用
- 文档是否需要重新解析、切片或更新

## 人工修正

用户提供 correction 时，系统不直接覆盖原回答，而是保存为修正样本。

```json
{
  "assistant_message_id": "msg_assistant_001",
  "rating": "down",
  "reason": "wrong_answer",
  "correction": "正确答案应为..."
}
```

修正样本的用途：

- 作为离线评测集 golden answer
- 帮助知识库管理员发现文档缺口
- 用于 Prompt 调优和检索策略对比

## 热点问答缓存

缓存命中只适用于「问题稳定、知识库稳定、引用仍有效」的场景。缓存答案必须附带 citations，不能缓存无来源的纯文本回答。

### Cache Key

```text
conversation:answer:v1:{tenant_id}:{kb_scope_hash}:{query_fingerprint}:{doc_version_hash}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `tenant_id` | 租户隔离 |
| `kb_scope_hash` | effective kb_ids 排序后 hash |
| `query_fingerprint` | rewritten query 规范化后 hash |
| `doc_version_hash` | 知识库内文档版本和 chunk version hash |

### 缓存值

```json
{
  "answer": "根据文档...",
  "citations": [
    {
      "doc_id": "doc_001",
      "chunk_id": "chunk_001",
      "page_range": [7],
      "quote": "..."
    }
  ],
  "confidence": "high",
  "created_at": "2026-06-13T10:00:00Z",
  "expires_at": "2026-06-14T10:00:00Z"
}
```

## 缓存命中条件

- 当前 actor 对所有 citation 文档仍有访问权限
- `doc_version_hash` 未变化
- answer 的 citations 非空
- 不是低置信度回答
- 用户问题不包含强时效词，如「最新」「今天」「刚刚上传」

## 缓存失效

| 事件 | 处理 |
|---|---|
| 文档新增、删除、重处理 | 更新知识库 `doc_version_hash`，自然失效 |
| 权限变更 | 权限校验不通过则拒绝命中 |
| 用户负反馈 | 降低该 cache key 权重或直接删除 |
| Prompt 版本升级 | cache key 版本从 `v1` 升级到 `v2` |

## 缓存写入策略

默认只缓存满足以下条件的回答：

- `confidence = high`
- citations 数量大于 0
- 生成成功且无敏感脱敏错误
- 回答长度低于配置阈值
- 近 24 小时内相似 query 出现 2 次以上，或管理员开启强缓存

## 监控指标

- `conversation.cache.hit_rate`
- `conversation.cache.stale_reject_count`
- `conversation.feedback.count`
- `conversation.feedback.negative_rate`
- `conversation.feedback.reason_distribution`
- `conversation.feedback.with_correction_rate`

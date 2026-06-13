# 数据模型 (Conversation Data Model)

Conversation 域的数据模型需要同时支持前端会话体验、RAG 链路追踪、答案溯源、反馈评估和审计排查。

## conversation_sessions

保存一个用户会话的元信息。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | 会话 ID |
| `tenant_id` | uuid | 租户隔离 |
| `user_id` | uuid | 创建者 |
| `title` | text | 会话标题，可由首问自动生成 |
| `kb_ids` | uuid[] | 本会话默认知识库范围 |
| `status` | text | `active` / `archived` / `deleted` |
| `summary` | text | 长会话摘要 |
| `created_at` | timestamptz | 创建时间 |
| `updated_at` | timestamptz | 更新时间 |

## conversation_messages

保存用户消息和助手消息。一次用户提问通常对应一条 user message 和一条 assistant message。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | 消息 ID |
| `conversation_id` | uuid | 所属会话 |
| `tenant_id` | uuid | 租户隔离 |
| `role` | text | `user` / `assistant` |
| `content` | text | 原始问题、partial answer 或最终回答 |
| `status` | text | `created` / `answering` / `completed` / `failed` / `cancelled` |
| `parent_message_id` | uuid | assistant message 指向对应 user message |
| `retry_of_message_id` | uuid | 重试关系 |
| `client_request_id` | text | 前端幂等 ID |
| `confidence` | text | `high` / `medium` / `low` |
| `no_answer_reason` | text | 无答案原因 |
| `error_code` | text | 失败错误码 |
| `error_message` | text | 可展示错误信息 |
| `created_at` | timestamptz | 创建时间 |
| `completed_at` | timestamptz | 完成时间 |

建议唯一约束：

```sql
UNIQUE (tenant_id, user_id, client_request_id)
```

## conversation_query_traces

记录 Query Rewrite 输出和管线配置，便于复盘。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | trace ID |
| `message_id` | uuid | 对应 user message |
| `original_query` | text | 用户原始问题 |
| `rewritten_query` | text | 改写后的检索查询 |
| `keywords` | jsonb | 关键词列表 |
| `hypothetical_answer` | text | HyDE 生成内容，可为空 |
| `resolved_refs` | jsonb | 指代消解详情 |
| `effective_kb_ids` | uuid[] | 本轮实际检索范围 |
| `rewrite_model` | text | 改写模型 |
| `created_at` | timestamptz | 创建时间 |

## conversation_retrieval_traces

记录召回和精排结果。chunk 正文可不重复存储，只保存必要快照和分数。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | trace ID |
| `message_id` | uuid | 对应 user message |
| `chunk_id` | uuid | 召回 chunk |
| `doc_id` | uuid | 文档 ID |
| `source` | text | `dense` / `bm25` / `rrf` / `rerank` |
| `rank` | int | 排名 |
| `score` | double precision | 分数 |
| `heading_path` | jsonb | 标题路径快照 |
| `page_range` | int[] | 页码范围 |
| `content_preview` | text | 片段预览，便于日志排查 |

## conversation_citations

保存最终答案引用。前端引用卡片和原文跳转依赖该表。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | 引用 ID |
| `assistant_message_id` | uuid | 对应助手回答 |
| `index` | int | 回答内引用序号 |
| `chunk_id` | uuid | chunk ID |
| `doc_id` | uuid | 文档 ID |
| `doc_title` | text | 文档标题快照 |
| `page_range` | int[] | 页码范围 |
| `heading_path` | jsonb | 标题路径 |
| `quote` | text | 引用原文摘录 |
| `score` | double precision | 关联 rerank 分数 |

## conversation_feedback

保存用户对助手回答的质量反馈。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | feedback ID |
| `assistant_message_id` | uuid | 被评价回答 |
| `user_id` | uuid | 评价人 |
| `rating` | text | `up` / `down` |
| `reason` | text | `wrong_answer` / `missing_source` / `outdated` / `not_helpful` / `other` |
| `comment` | text | 用户补充说明 |
| `correction` | text | 用户修正答案 |
| `created_at` | timestamptz | 创建时间 |

## 索引建议

```sql
CREATE INDEX idx_conversation_sessions_user
  ON conversation_sessions (tenant_id, user_id, updated_at DESC);

CREATE INDEX idx_conversation_messages_session
  ON conversation_messages (conversation_id, created_at ASC);

CREATE INDEX idx_conversation_citations_message
  ON conversation_citations (assistant_message_id, index ASC);

CREATE INDEX idx_conversation_feedback_message
  ON conversation_feedback (assistant_message_id);
```

## 保留策略

- 普通会话记录默认长期保留，支持用户手动删除
- trace 可按租户配置保留 30 / 90 / 180 天
- content_preview 和 hypothetical_answer 可能包含敏感内容，应随 trace 过期清理
- feedback 和 citation 建议长期保留，用于质量评估和离线数据集构建

# 请求生命周期 (Conversation Lifecycle)

一次对话请求的生命周期覆盖 API 接入、权限范围确认、Query Pipeline 编排、SSE 输出、持久化和异常处理。Conversation 域的重点是「可恢复、可追踪、可解释」。

## 主流程

```
POST /api/conversations/{conversation_id}/messages
  │
  ▼
创建 user message
  │
  ▼
加载 conversation scope
  │  tenant_id / user_id / kb_ids / conversation history
  ▼
创建 assistant message 占位
  │
  ▼
Query Rewrite
  │
  ▼
Hybrid Search + Reranker
  │
  ├── 无有效 chunk -> 生成无结果回答
  │
  ▼
Context Assembly + LLM Generation
  │
  ▼
SSE token streaming
  │
  ▼
后处理 citations / confidence
  │
  ▼
更新 assistant message 为 completed
```

## 阶段职责

| 阶段 | 输入 | 输出 | 落库 |
|---|---|---|---|
| 请求接入 | 用户问题、知识库范围、会话 ID | user message | `conversation_messages` |
| 上下文加载 | conversation_id、actor | 最近 N 轮有效历史 | 不单独落库 |
| 查询改写 | 原始问题、历史摘要、scope | rewritten query、keywords、HyDE | `conversation_query_traces` |
| 检索精排 | rewritten query、kb_ids | Top chunks + scores | `conversation_retrieval_traces` |
| 答案生成 | chunks、问题、history | token stream、raw answer | assistant message partial |
| 后处理 | raw answer、chunks、scores | citations、confidence | `conversation_citations` |
| 完成 | assistant message | completed 状态 | message status / metrics |

## SSE 事件

SSE 接口只承载本次 assistant message 的生成过程。前端刷新或断线后，通过 message 查询接口恢复最终状态。

```text
event: message.created
data: {"message_id":"...","conversation_id":"..."}

event: answer.delta
data: {"message_id":"...","text":"根据文档..."}

event: citation.delta
data: {"message_id":"...","citation":{"index":1,"doc_id":"...","chunk_id":"..."}}

event: answer.completed
data: {"message_id":"...","confidence":"high","usage":{"input_tokens":1234,"output_tokens":256}}

event: answer.failed
data: {"message_id":"...","code":"LLM_TIMEOUT","message":"生成超时，请稍后重试"}
```

## 无结果回答

当 reranker 结果全部低于阈值，Conversation 不调用通用知识生成，而是返回固定结构：

```json
{
  "answer": "文档中未找到与该问题直接相关的信息。",
  "citations": [],
  "confidence": "low",
  "no_answer_reason": "NO_RELEVANT_CHUNKS"
}
```

## 中断与恢复

- 用户点击停止生成：将 assistant message 标记为 `cancelled`，保留 partial answer 和已发现 citations
- 浏览器断线：后端继续生成；前端重连后查询 message 状态
- 后端超时：记录 `failed` 状态、错误码、pipeline trace；用户可基于同一 user message 发起 retry
- retry 不覆盖原 assistant message，而是创建新的 assistant message，并用 `retry_of_message_id` 关联

## 幂等策略

| 场景 | 策略 |
|---|---|
| 用户重复点击发送 | 前端传 `client_request_id`，后端唯一约束去重 |
| SSE 连接重试 | 使用 message_id 恢复，不重复创建 message |
| LLM 生成失败后重试 | 新建 assistant message，保留失败记录 |
| 缓存命中 | 仍创建本次消息记录，但 answer 来源标记为 `cache` |

## 关键指标

- `conversation.request.count`
- `conversation.answer.latency_ms`
- `conversation.first_token.latency_ms`
- `conversation.no_answer.rate`
- `conversation.error.rate`
- `conversation.cache.hit_rate`
- `conversation.feedback.negative_rate`

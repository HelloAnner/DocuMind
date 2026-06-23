# API 契约 (Conversation API)

Conversation API 面向前端问答页，覆盖会话列表、消息发送、SSE 流式回答、历史恢复、反馈提交和停止生成。

## 创建会话

```http
POST /api/conversations
Content-Type: application/json
```

```json
{
  "kb_ids": ["kb_001", "kb_002"],
  "title": "采购合同问答"
}
```

响应：

```json
{
  "conversation_id": "conv_001",
  "title": "采购合同问答",
  "kb_ids": ["kb_001", "kb_002"],
  "created_at": "2026-06-13T10:00:00Z"
}
```

## 获取会话列表

```http
GET /api/conversations?limit=20&cursor=...
```

响应：

```json
{
  "items": [
    {
      "conversation_id": "conv_001",
      "title": "采购合同问答",
      "last_message_preview": "违约责任是什么？",
      "updated_at": "2026-06-13T10:05:00Z"
    }
  ],
  "next_cursor": null
}
```

## 获取会话消息

```http
GET /api/conversations/{conversation_id}/messages
```

响应：

```json
{
  "conversation_id": "conv_001",
  "messages": [
    {
      "message_id": "msg_user_001",
      "role": "user",
      "content": "Q3采购合同的违约责任是什么？",
      "status": "completed",
      "created_at": "2026-06-13T10:01:00Z"
    },
    {
      "message_id": "msg_assistant_001",
      "role": "assistant",
      "content": "根据合同，违约责任包括...",
      "status": "completed",
      "confidence": "high",
      "citations": [
        {
          "index": 1,
          "doc_id": "doc_001",
          "chunk_id": "chunk_001",
          "doc_title": "2025年Q3采购合同.pdf",
          "page_range": [7],
          "quote": "任何一方未按约定履行..."
        }
      ],
      "created_at": "2026-06-13T10:01:01Z",
      "completed_at": "2026-06-13T10:01:08Z"
    }
  ]
}
```

## 发送消息并流式回答

```http
POST /api/conversations/{conversation_id}/messages
Content-Type: application/json
```

```json
{
  "content": "那付款节点呢？",
  "kb_ids": ["kb_001"],
  "client_request_id": "req_20260613_001",
  "stream": true
}
```

响应可返回 SSE 连接信息，或直接以 `text/event-stream` 输出。推荐直接输出 SSE，减少一次握手。

```text
event: message.created
data: {"user_message_id":"msg_user_002","assistant_message_id":"msg_assistant_002"}

event: answer.delta
data: {"text":"付款节点分为..."}

event: citation.delta
data: {"citation":{"index":1,"doc_id":"doc_001","chunk_id":"chunk_003","page_range":[5]}}

event: answer.completed
data: {"message_id":"msg_assistant_002","confidence":"medium"}
```

## 停止生成

```http
POST /api/conversations/{conversation_id}/messages/{message_id}/cancel
```

响应：

```json
{
  "message_id": "msg_assistant_002",
  "status": "cancelled"
}
```

## 重试回答

```http
POST /api/conversations/{conversation_id}/messages/{message_id}/retry
Content-Type: application/json
```

```json
{
  "stream": true
}
```

说明：

- `message_id` 指失败或取消的 assistant message
- 后端复用其 parent user message 创建新的 assistant message
- 原失败消息保留，不被覆盖

## 提交反馈

```http
POST /api/conversations/{conversation_id}/messages/{message_id}/feedback
Content-Type: application/json
```

```json
{
  "rating": "down",
  "reason": "missing_source",
  "comment": "答案提到了付款比例，但引用没有覆盖这一条。",
  "correction": "第 5 页写明首付款 30%，验收后支付 60%，质保期结束支付 10%。"
}
```

响应：

```json
{
  "feedback_id": "fb_001",
  "message_id": "msg_assistant_002",
  "created_at": "2026-06-13T10:10:00Z"
}
```

## 错误码

| code | HTTP | 说明 |
|---|---:|---|
| `CONVERSATION_NOT_FOUND` | 404 | 会话不存在或无权限 |
| `KB_SCOPE_DENIED` | 403 | 请求知识库超出用户权限 |
| `MESSAGE_NOT_FOUND` | 404 | 消息不存在或无权限 |
| `PIPELINE_TIMEOUT` | 504 | RAG 管线超时 |
| `LLM_TIMEOUT` | 504 | LLM 生成超时 |
| `CLIENT_REQUEST_CONFLICT` | 409 | 幂等 ID 冲突 |
| `INVALID_MESSAGE_STATE` | 409 | 当前状态不允许取消或重试 |

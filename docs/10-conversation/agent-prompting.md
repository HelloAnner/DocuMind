# 会话 Agent Prompt 与事件

会话层只负责构造权限安全的 `AgentRequest`、输出事件和持久化结果。它不再通过多个 JSON Prompt 分别完成 mode、rewrite、plan 和 generate。

## 请求上下文

```text
tenant/user/conversation
+ current user message
+ recent completed turns
+ session effective_kb_ids
+ AgentOptions
```

已有会话默认沿用创建会话时保存的知识库范围。前端发送普通消息时不重复提交“当前全部知识库”，避免后来新增的知识库在无意中扩大旧会话范围。API 客户端仍可显式提交 scope，但后端始终与当前用户权限取交集。

## Prompt 组合

会话把结构化消息交给 `AgentModel`：

```text
system: identity + conversation + tool + grounding + response + security
assistant/user: bounded completed history
user: current message
```

当前消息必须是最后一条 `user` message。历史用于理解意图，不是证据。Tool observation 只存在于本次 ReAct 运行，不伪装成 user message。

## 原生工具轮次

```text
assistant(tool_calls)
  -> tool(tool_call_id, observation)
  -> assistant(tool_calls or final content)
```

工具调用使用 provider 原生字段，不要求模型把 action 包在正文 JSON 中。这样 provider 能校验 schema，Kernel 也能准确关联并行 tool call。

## SSE 与 Atom 事件

前端既保留旧的阶段事件，又可消费细粒度运行事件：

| 事件 | 含义 |
|---|---|
| `status.updated` | understanding/retrieving/reranking/generating |
| `rewrite.completed` | 当前有效的自包含检索问题 |
| `retrieval.completed` | 召回数与 warnings |
| `rerank.completed` | 精排后的 chunk IDs |
| `answer.delta` | 回答正文 |
| `citation.delta` | 解析后的真实引用 |
| `answer.completed` | confidence 和 usage |
| `tool.call.started` | 工具名和参数 |
| `tool.call.completed` | 工具公开结果 |
| `tool.call.failed` | 结构化工具错误 |

`rewrite.completed` 现在是兼容性事件：直答时等于当前原始消息；执行 search 后更新为工具的 `rerank_query`。它不代表额外调用了一个 rewrite 模型。

## 性能语义

调用次数按实际任务决定：

- 普通问候：1 次 AgentModel；
- 文档问答：1 次 AgentModel tool selection + 1 次/多次工具观察后的 AgentModel + 1 次 verifier；
- 澄清：1 次 AgentModel + 终止型 clarification tool；
- verifier 修正：不再触发新的 answer generation，只接受一次结构有效的 verifier correction。

因此简单请求不会为固定阶段付费，复杂请求仍可根据证据多步执行。

## Trace

每个 assistant message 保存：

- Prompt 四层版本；
- AgentModel、search/rerank、verifier 组件；
- mode、stop reason 和 usage；
- ReAct steps；
- retrieval/query traces；
- cache key。

前端展示不是唯一事实源；后端和 DocuMind CLI 应以持久化 Trace 判断工具、耗时、引用和权限。

# 对话管理 (Conversation)

对话域负责把一次用户提问从「请求进入」推进到「答案生成、引用溯源、记录沉淀、反馈闭环」。它不直接实现文档解析或检索算法，而是编排 Query Pipeline，管理多轮上下文，并为前端提供可追溯、可中断、可恢复的会话体验。

## 文档索引

- [请求生命周期](./lifecycle.md)：一次问答从 API 到 SSE 输出、落库、失败处理的完整链路
- [上下文策略](./context-policy.md)：多轮会话、指代消解、历史裁剪和安全边界
- [数据模型](./data-model.md)：conversation、message、trace、citation、feedback 等核心表结构
- [API 契约](./api-contract.md)：前端对话页需要的 REST / SSE 接口
- [反馈与缓存](./feedback-cache.md)：赞踩、修正文本、热点问答缓存和质量回流
- [Agent 提示词设计](./agent-prompting.md)：Agent 角色、提示词模板、工具调用和防幻觉约束
- [问题保真与灵活性](./question-fidelity.md)：如何保留用户真实意图，同时支持追问、改写和澄清
- [RAG 框架选型](./rag-framework.md)：DocuMind RAG Agent 的工程框架、组件边界和可替换策略

更完整的 Agent 产品人格、角色灵活度和行为边界见 [Agent 域](../11-agent/agent.md)。Conversation 域负责会话生命周期与交互细节，Agent 域负责“它应该如何思考、如何回应、如何有温度但不越界”。

## 1. 核心职责

- 会话与消息持久化：记录原始问题、改写查询、检索结果、答案、置信度、延迟和错误。
- Query Pipeline 编排：串联 Query Rewrite、Hybrid Search、Reranker、Context Assembly、LLM Generation。
- Agent 提示词与策略编排：控制改写、检索、生成、引用和澄清行为。
- SSE 流式回答：向前端推送 token、引用、置信度、完成态与错误态。
- 多轮上下文管理：选择最近有效历史，提供给查询改写和答案生成。
- 答案溯源：维护 `chunk_id -> doc_id -> source span` 的引用链。
- 用户反馈闭环：采集赞踩、问题类型和人工修正答案。
- 热点问答缓存：对稳定、可复用的问题命中 Redis，降低 LLM 与检索成本。

## 2. 领域边界

| 边界 | Conversation 负责 | 其他领域负责 |
|---|---|---|
| 权限 | 接收 actor scope，并在查询时传递 `tenant_id` / `kb_ids` | Access Control 决定用户能访问哪些知识库 |
| 检索 | 保存检索 trace，选择是否复用缓存 | Hybrid Search / Reranker 计算召回和排序 |
| Agent | 传递用户问题、历史和上下文 | Agent 决定角色模式、澄清策略、工具规划和表达方式 |
| 生成 | 组织请求、保存回答和引用 | Answer Generation 组装 prompt、调用 LLM、后处理 |
| 文档 | 只引用 chunk / document 元数据 | Knowledge Base 管理文档、chunk、解析状态 |
| 运维 | 暴露问答日志和统计指标 | System Ops 统一采集、告警、索引运维 |

## 3. 核心对象

```text
Conversation
  ├── Message(user)
  │     └── QueryTrace
  │           ├── rewritten_query
  │           ├── retrieved_chunks
  │           ├── reranked_chunks
  │           └── generation_config
  ├── Message(assistant)
  │     ├── answer
  │     ├── citations
  │     └── confidence
  └── Feedback
        ├── rating
        ├── reason
        └── correction
```

## 4. 会话状态机

```text
created
  │
  ▼
answering
  │
  ├── completed
  │     └── feedback_collected
  │
  ├── failed
  │
  └── cancelled
```

| 状态 | 说明 |
|---|---|
| `created` | 用户问题已接收，消息已创建 |
| `answering` | 正在执行改写、检索、生成或流式输出 |
| `completed` | 回答完成，引用和置信度已落库 |
| `feedback_collected` | 用户提交赞踩或修正文本 |
| `failed` | 管线异常，保存错误码和可展示错误信息 |
| `cancelled` | 用户主动停止生成，保留已输出 partial answer |

## 5. 对话交互细节设计

### 5.1 用户输入阶段

| 前端状态 | 说明 | 交互细节 |
|---|---|---|
| `idle` | 等待用户输入 | 输入框可用，显示知识库选择器 |
| `composing` | 用户正在输入 | 支持 @知识库、换行、粘贴；显示 token 预估（可选） |
| `sending` | 用户点击发送 | 按钮进入 loading，禁用重复提交，前端生成 `client_request_id` |

- **防重复提交**：前端生成 `client_request_id`，后端唯一约束 `(tenant_id, user_id, client_request_id)`。
- **空输入拦截**：前端与后端均校验，空消息不创建。
- **知识库切换**：发送前若用户切换 `kb_ids`，提示“切换后历史上下文可能失效”。

### 5.2 回答中阶段

回答进入 `answering` 后，前端展示一个** thinking / 检索中**的过渡态：

```text
[搜索相关文档...]
[整理答案...]
```

过渡态文案根据后端 SSE 事件动态切换：

| SSE 事件 | 前端展示 |
|---|---|
| `rewrite.completed` | 已理解问题 |
| `retrieval.completed` | 已找到相关文档 |
| `rerank.completed` | 已筛选关键依据 |
| `answer.delta` | 逐字输出答案 |

### 5.3 流式渲染

- 答案文本按 token 增量追加渲染，支持 Markdown（代码块、列表、表格）。
- citation 占位符（如 `[1]`）在收到 `citation.delta` 后变为可点击引用卡片。
- 表格生成时，等表格 Markdown 完整后再一次性渲染，避免闪烁。

### 5.4 引用交互

- **悬停**：显示引用卡片（文档名、页码、原文摘录、置信度）。
- **点击**：右侧/抽屉打开原文预览，高亮对应段落。
- **批量引用**：若一句话引用多个来源，显示 `[1][2]`，分别可点击。

### 5.5 答案完成态

回答完成后，前端展示：

- 最终答案
- 引用列表（按 index 排列）
- 置信度标签（高 / 中 / 低）
- 操作栏：复制、点赞、点踩、修正、重新生成
- 可选的「下一步建议」（由 Agent 提供，不超过 2 条）

### 5.6 中断与恢复

| 用户操作 | 后端处理 | 前端处理 |
|---|---|---|
| 点击停止 | 取消 LLM 流，assistant message 标记 `cancelled` | 保留已输出内容，显示“已停止生成” |
| 浏览器断线 | 后端继续生成；前端重连后查询 message 状态 | 恢复最终答案或继续等待 |
| 刷新页面 | 通过 `GET /conversations/{id}/messages` 恢复历史 | 恢复会话上下文与滚动位置 |
| retry | 基于同一 user message 创建新的 assistant message | 保留原失败消息，展示新回答 |

### 5.7 错误与空状态

| 场景 | 前端展示 |
|---|---|
| 检索无结果 | “文档中未找到相关信息。你可以尝试换关键词或扩大知识库范围。” |
| LLM 超时 | “生成超时，请稍后重试。” |
| 知识库无权限 | “你无权访问该知识库。” |
| 网络中断 | “连接已断开，正在恢复…” |

### 5.8 多轮上下文加载

- 默认加载最近 5 轮完成态 QA，排除 `failed` 和空回答。
- 用户切换 `kb_ids` 后，只保留与当前 `kb_ids` 交集非空的历史轮次。
- 追问命中明显指代词时，提高上一轮 user/assistant message 权重。

## 6. SSE 事件详细设计

SSE 接口只承载本次 assistant message 的生成过程。前端刷新或断线后，通过 message 查询接口恢复最终状态。

### 6.1 事件列表

```text
event: message.created
data: {"message_id":"...","conversation_id":"...","user_message_id":"..."}

event: status.updated
data: {"message_id":"...","status":"rewriting"}

event: rewrite.completed
data: {"message_id":"...","rewritten_query":"...","keywords":["..."]}

event: retrieval.completed
data: {"message_id":"...","chunk_count":12}

event: rerank.completed
data: {"message_id":"...","top_chunk_ids":["chunk_003","chunk_007"]}

event: answer.delta
data: {"message_id":"...","text":"根据文档..."}

event: citation.delta
data: {"message_id":"...","citation":{"index":1,"doc_id":"...","chunk_id":"..."}}

event: answer.completed
data: {"message_id":"...","confidence":"high","usage":{"input_tokens":1234,"output_tokens":256}}

event: answer.failed
data: {"message_id":"...","code":"LLM_TIMEOUT","message":"生成超时，请稍后重试"}
```

### 6.2 状态事件映射

| 后端阶段 | SSE 状态事件 | 前端 UI 状态 |
|---|---|---|
| 改写中 | `status: rewriting` | 显示“理解问题中…” |
| 检索中 | `status: retrieving` | 显示“搜索相关文档…” |
| 精排中 | `status: reranking` | 显示“筛选关键依据…” |
| 生成中 | `answer.delta` | 逐字输出 |
| 完成 | `answer.completed` | 展示引用与置信度 |
| 失败 | `answer.failed` | 展示错误与重试按钮 |

## 7. 答案溯源与引用链

- 每条 citation 必须保存 `chunk_id -> doc_id -> page_range -> heading_path -> quote`。
- 引用链用于：前端跳转、管理员审计、反馈分析、离线评测。
- 无 citation 的回答必须标注 `no_answer_reason`。

## 8. 反馈闭环

- 反馈入口挂在 assistant message 上，而不是 conversation 上。
- 用户可点赞、点踩、填写原因、提交修正文本。
- 负反馈关联完整 trace，形成可分析样本：

```text
feedback
  -> assistant_message
  -> parent user_message
  -> query_trace
  -> retrieval_trace
  -> citations
```

## 9. 缓存策略

- 缓存 key：`conversation:answer:v1:{tenant_id}:{kb_scope_hash}:{query_fingerprint}:{doc_version_hash}`。
- 缓存命中条件：权限未变、文档版本未变、citations 非空、非低置信、非强时效问题。
- 缓存命中后仍创建本次消息记录，但 answer 来源标记为 `cache`。

## 10. 成功标准

- 每条助手回答都能追溯到引用 chunk；没有依据时明确返回「未找到相关信息」。
- 一次问答可以复盘完整链路：原始问题、改写结果、检索 Top-K、精排分数、LLM 配置、最终答案。
- 多轮问题不会越权引用用户无权限的历史知识库或文档。
- SSE 中断不会丢失已生成内容，前端刷新后能看到当前会话状态。
- 反馈数据可用于后续评估检索质量、Prompt 质量和人工修订样本。

## 11. 关键指标

| 指标 | 说明 |
|---|---|
| `conversation.request.count` | 问答请求量 |
| `conversation.answer.latency_ms` | 端到端回答延迟 |
| `conversation.first_token.latency_ms` | 首 token 延迟 |
| `conversation.no_answer.rate` | 无结果比例 |
| `conversation.error.rate` | 错误率 |
| `conversation.cache.hit_rate` | 缓存命中率 |
| `conversation.feedback.negative_rate` | 负反馈率 |

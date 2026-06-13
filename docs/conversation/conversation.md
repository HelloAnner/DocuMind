# 对话管理 (Conversation)

对话域负责承接用户自然语言提问，并把一次问答从「请求进入」推进到「答案生成、引用溯源、记录沉淀、反馈闭环」。它不直接承担文档解析、检索算法或 LLM 推理实现，而是编排 Query Pipeline，并为前端提供可追溯的会话体验。

## 文档索引

- [请求生命周期](./lifecycle.md)：一次问答从 API 到 SSE 输出、落库、失败处理的完整链路
- [上下文策略](./context-policy.md)：多轮会话、指代消解、历史裁剪和安全边界
- [数据模型](./data-model.md)：conversation、message、trace、citation、feedback 等核心表结构
- [API 契约](./api-contract.md)：前端对话页需要的 REST / SSE 接口
- [反馈与缓存](./feedback-cache.md)：赞踩、修正文本、热点问答缓存和质量回流
- [Agent 提示词设计](./agent-prompting.md)：Agent 角色、提示词模板、工具调用和防幻觉约束
- [问题保真与灵活性](./question-fidelity.md)：如何保留用户真实意图，同时支持追问、改写和澄清
- [RAG 框架选型](./rag-framework.md)：DocuMind RAG Agent 的工程框架、组件边界和可替换策略

更完整的 Agent 产品人格、角色灵活度和行为边界见 [Agent 域](../agent/agent.md)。Conversation 域只负责会话生命周期，Agent 域负责“它应该如何思考、如何回应、如何有温度但不越界”。

## 核心职责

- 会话与消息持久化：记录原始问题、改写查询、检索结果、答案、置信度、延迟和错误
- Query Pipeline 编排：串联 Query Rewrite、Hybrid Search、Reranker、Context Assembly、LLM Generation
- Agent 提示词与策略编排：控制改写、检索、生成、引用和澄清行为
- SSE 流式回答：向前端推送 token、引用、置信度、完成态与错误态
- 多轮上下文管理：选择最近有效历史，提供给查询改写和答案生成
- 答案溯源：维护 `chunk_id -> doc_id -> source span` 的引用链
- 用户反馈闭环：采集赞踩、问题类型和人工修正答案
- 热点问答缓存：对稳定、可复用的问题命中 Redis，降低 LLM 与检索成本

## 领域边界

| 边界 | Conversation 负责 | 其他领域负责 |
|---|---|---|
| 权限 | 接收 actor scope，并在查询时传递 `tenant_id` / `kb_ids` | Access Control 决定用户能访问哪些知识库 |
| 检索 | 保存检索 trace，选择是否复用缓存 | Hybrid Search / Reranker 计算召回和排序 |
| Agent | 传递用户问题、历史和上下文 | Agent 决定角色模式、澄清策略、工具规划和表达方式 |
| 生成 | 组织请求、保存回答和引用 | Answer Generation 组装 prompt、调用 LLM、后处理 |
| 文档 | 只引用 chunk / document 元数据 | Knowledge Base 管理文档、chunk、解析状态 |
| 运维 | 暴露问答日志和统计指标 | System Ops 统一采集、告警、索引运维 |

## 核心对象

```
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

## 状态机

```
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

### 状态说明

| 状态 | 说明 |
|---|---|
| `created` | 用户问题已接收，消息已创建 |
| `answering` | 正在执行改写、检索、生成或流式输出 |
| `completed` | 回答完成，引用和置信度已落库 |
| `feedback_collected` | 用户提交赞踩或修正文本 |
| `failed` | 管线异常，保存错误码和可展示错误信息 |
| `cancelled` | 用户主动停止生成，保留已输出 partial answer |

## 成功标准

- 每条助手回答都能追溯到引用 chunk；没有依据时明确返回「未找到相关信息」
- 一次问答可以复盘完整链路：原始问题、改写结果、检索 Top-K、精排分数、LLM 配置、最终答案
- 多轮问题不会越权引用用户无权限的历史知识库或文档
- SSE 中断不会丢失已生成内容，前端刷新后能看到当前会话状态
- 反馈数据可用于后续评估检索质量、Prompt 质量和人工修订样本

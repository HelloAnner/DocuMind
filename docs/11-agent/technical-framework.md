# Agent 技术框架

DocuMind 在 Rust 服务内实现可观测的模型原生 ReAct Kernel。它对标 Moss 的核心语义：模型每一轮可以直接回答，也可以发出标准 `tool_calls`；“没有工具调用”本身就是完成回答的明确协议，不再经过固定的 rewrite → retrieve → generate 流水线。

## 运行架构

```text
AgentRequest
  │
  ├── effective_kb_ids（服务端权限交集）
  ├── bounded conversation history
  └── AgentOptions
  ▼
PromptRegistry
  │  identity + conversation + tool policy + grounding + response + security
  ▼
AgentModel.complete(messages, tool definitions)
  │
  ├── content，无 tool_calls ───────────────► 直接回答或证据回答
  │
  └── native tool_calls
         │
         ▼
     AgentToolRegistry
         ├── knowledge_search
         └── ask_clarification
         │
         └── tool observations 回填 messages，进入下一轮
```

## 关键选择

| 层 | 实现 | 责任 |
|---|---|---|
| HTTP / SSE | Axum + Tokio | 认证、会话、事件流与持久化 |
| ReAct Kernel | `agent/kernel.rs` | 迭代、预算、重复调用保护、终止语义 |
| 模型协议 | `AgentModel` | OpenAI-compatible `content + tool_calls` |
| Tool Registry | `AgentToolRegistry` | 工具定义、注册不变量、执行与错误观测 |
| Prompt | `PromptRegistry` | 模块化组合与版本追踪 |
| RAG | Retriever + Reranker + ContextAssembler | 授权范围内的混合检索、精排和证据组装 |
| 可信收口 | `GroundedAnswerFinalizer` | 一次 claim verification、引用解析、置信度 |
| 审计 | Agent / Query / Retrieval Trace + Atom events | 完整记录决策、工具调用与证据链 |

## AgentModel 契约

```rust
pub trait AgentModel: Send + Sync {
    async fn complete(&self, request: AgentModelRequest)
        -> Result<AgentModelResponse>;
    fn component_name(&self) -> String;
}

pub struct AgentModelResponse {
    pub content: Option<String>,
    pub tool_calls: Vec<AgentToolCall>,
    pub usage: Option<Usage>,
    pub finish_reason: Option<String>,
}
```

协议语义：

- `tool_calls` 非空：Kernel 逐个执行已注册工具，并把带 `tool_call_id` 的 observation 交回模型。
- `tool_calls` 为空且 `content` 非空：结束 ReAct。
- 两者都为空：Kernel 允许一次明确重试；再次为空则返回错误。
- 模型请求未注册工具：返回结构化 tool error，不执行未知能力。

## Tool 契约

```rust
pub trait AgentTool: Send + Sync {
    fn definition(&self) -> AgentToolDefinition;
    async fn execute(
        &self,
        call: &AgentToolCall,
        context: &ToolExecutionContext<'_>,
    ) -> Result<ToolExecution>;
    fn component_name(&self) -> String;
}
```

工具执行分为三类 effect：

- `KnowledgeSearch`：合并证据、检索 Trace、查询计划、mode 和指代记录。
- `Terminal`：例如 `ask_clarification`，直接结束当前轮并等待用户。
- `None`：只返回 observation，不改变 Agent 领域状态。

Registry 在启动时拒绝重名工具；Kernel 在启动时要求 `knowledge_search` 必须存在。工具参数由 JSON Schema 约束，运行时仍执行权限和策略校验。

## knowledge_search

模型一次调用可以提交：

- 1 到 `max_queries_per_step` 个自包含语义查询；
- `rerank_query`；
- 可选 HyDE 假想答案；
- 可选 response mode；
- 可选 keywords 和已明确消解的历史引用；
- 简短的操作目的。

工具内部复用现有功能：

```text
authorized KB scope
  -> dense + BM25
  -> per-query RRF
  -> merge / deduplicate
  -> rerank
  -> stable evidence ids
```

证据编号在整个 ReAct 轮次中稳定：后续搜索只追加新证据，不会重排已有 `[1]`、`[2]`。HyDE 只影响召回，不作为证据。`allow_analyst_mode=false` 时，执行层拒绝 analyst mode，不依赖模型自觉。

## 终止与可信边界

### 无工具直接回答

问候、闲聊、写作帮助和不依赖企业语料的普通问题可以一次模型调用直接完成，不检索、不验证文档引用，置信度为 `medium`。

### 有证据回答

只要本轮积累了文档证据，模型正文必须使用稳定的 `[n]`。随后：

1. ContextAssembler 按预算组装实际证据；
2. ClaimVerifier 只调用一次；
3. 候选答案通过则直接采用；
4. 候选不通过时，可采用 verifier 返回且引用结构有效的一次纠正；
5. 否则返回标准证据不足回答。

旧实现的多轮“生成 → 验证 → 修复 → 再验证”已移除，避免一个简单问题触发多次串行 LLM 调用。

### 检索无结果

一旦调用过 `knowledge_search` 但没有积累证据，最终回答强制为 `low`，并写入 `NO_RELEVANT_CHUNKS`。它不会被误判成普通直接回答；伪造的 `[n]` 会被移除为明确的无证据说明。

### 澄清

只有存在会导致不同检索路径的真实意图歧义时才调用 `ask_clarification`。弱召回或缺文档不是歧义。

## 运行时护栏

- ReAct 有显式最大步数；
- 完全相同的工具名和参数只允许执行一次；
- 工具错误作为 observation 返回，模型可换查询或说明限制；
- 模型不能扩大 `effective_kb_ids`；
- 每轮记录 tool started/completed/failed Atom event；
- Trace 保存 queries、rerank query、HyDE、retrieved/accepted chunk IDs、warnings；
- 历史只用于意图，不作为本轮文档事实；
- 当前消息始终是最后一条 user message，不会被历史问题覆盖；
- answer cache 包含历史指纹、UTC 日期、知识库范围、文档版本和运行时版本。

## 组件版本

当前 Prompt 版本：

```yaml
persona: persona-v4
guardrail: adaptive-grounding-v20
mode: semantic-mode-autonomous-v20
task: native-tool-react-v20
cache_protocol: v3
```

版本随 Agent Trace 持久化，用于回放、灰度和评估。

## 测试基线

必须覆盖：

- `你好`：一次模型调用、零 tool call、零 retrieval；
- 文档事实：tool call、引用、verifier 和 Trace 完整；
- 多次不同搜索：证据编号稳定；
- 重复工具调用：第二次被拒绝；
- 检索无结果：low + `NO_RELEVANT_CHUNKS`；
- 指代不明：澄清且不检索；
- 文档问答后的 `你好`：仍按当前消息直接回答；
- 会话知识库范围：已有会话沿用服务端 session scope。

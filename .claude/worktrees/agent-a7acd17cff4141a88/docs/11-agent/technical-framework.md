# Agent 技术框架

DocuMind 的对话内核使用 pi core（`@earendil-works/pi-agent-core`）：一个进程内的 TS Agent 库，负责多轮迭代、工具调用、流式事件与会话上下文。模型每一轮可以直接回答，也可以发出标准 `tool_calls`；“没有工具调用”本身就是完成回答的明确协议，不再经过固定的 rewrite → retrieve → generate 流水线。

内核之外的 DocuMind 能力（Prompt、RAG、引用收口、验证、Trace、持久化）保持不变。

## 运行架构

```text
AgentRequest
  │
  ├── effective_kb_ids（服务端权限交集）
  ├── bounded conversation history
  └── AgentOptions
  ▼
PromptRegistry.compose() ──► systemPrompt
  │  identity + conversation + tool policy + grounding + response + security
  ▼
pi core Agent（src/agent/pi/kernel.ts）
  │  streamFn = pi-ai openai-completions（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）
  │  selector = CHAT_MODELS；未选择时回退 LLM_MODEL
  │  tools    = [knowledge_search, ask_clarification]
  │
  ├── 模型只给 content ──────────────────► 结束循环
  │
  └── 模型给 tool_calls
         │
         ▼
     AgentTool.execute()  →  领域 effect 应用到 RunState
         │                    （证据合并、检索 Trace、mode、指代）
         └── tool result 回填 messages，进入下一轮
  ▼
agent_end ──► 取最后一条 assistant 正文
  ▼
ContextAssembler → GroundedAnswerFinalizer → CitationResolver
  ▼
AnswerStream ──► conversations_pipeline.ts ──► SSE + PostgreSQL
```

## 关键选择

| 层 | 实现 | 责任 |
|---|---|---|
| HTTP / SSE | Hono + Bun | 认证、会话、事件流与持久化 |
| 对话循环 | `pi core Agent` | 迭代、工具调度、上下文、预算、终止语义 |
| 模型传输 | `pi-ai openai-completions` | OpenAI-compatible `content + tool_calls` |
| 工具 | `AgentTool`（typebox schema） | 工具定义、参数校验、执行与错误观测 |
| Prompt | `PromptRegistry` | 模块化组合与版本追踪 |
| RAG | Retriever + Reranker + ContextAssembler | 授权范围内的混合检索、精排和证据组装 |
| 可信收口 | `GroundedAnswerFinalizer` | 一次 claim verification、引用解析、置信度 |
| 审计 | Agent / Query / Retrieval Trace + Atom events | 完整记录决策、工具调用与证据链 |

内核代码在 `apps/api-bun/src/agent/pi/`：

```text
kernel.ts    PiAgentKernel：组装 Agent、事件映射、收口
model.ts     PiModelSettings → pi-ai Model / streamFn
tools.ts     knowledge_search / ask_clarification
support.ts   证据合并、工具 effect、React 步骤 Trace
events.ts    AgentEvent / AgentMessage → DocuMind 领域值
```

## 模型契约

`pi core` 通过 `streamFn` 抽象模型传输；DocuMind 注入 pi-ai 的 `openai-completions`：

```ts
const model: Model<'openai-completions'> = {
  id: LLM_MODEL, api: 'openai-completions', baseUrl: LLM_BASE_URL,
  contextWindow: LLM_CONTEXT_WINDOW, maxTokens: LLM_MAX_OUTPUT_TOKENS, ...
};
streamFn = (_model, context, options) =>
  streamSimple(model, context, { ...options, apiKey: LLM_API_KEY,
    temperature: LLM_TEMPERATURE, maxTokens: LLM_MAX_OUTPUT_TOKENS });
```

对话页与 CLI 可以逐请求选择 `CHAT_MODELS` 中的模型；凭据、Base URL 和
默认模型仍由 ENV 控制。DeepSeek / Qwen 的深度思考可切换，GLM 始终开启。
可切换模型不传 `thinking_enabled` 时按目录里的 `thinking_default` 取值（当前为关闭），
Web 的“自动”就是这个默认值；解析出的布尔值会作为 `enable_thinking` 显式发给生成端点，
若省略该参数，端点默认开启推理，首字前会先产出不可见的 reasoning
（实测同一 Office 修改任务首 token 从 1.3s 变为 14.9s）。
开启后，`thinking.delta` 只在生成期间以灰色临时文字展示；第一个正文增量
到达后立即清除，且不写入最终消息正文。

协议语义：

- `tool_calls` 非空：pi core 逐个执行已注册工具，并把带 `toolCallId` 的 observation 交回模型。
- `tool_calls` 为空且 `content` 非空：结束循环。
- 模型请求未注册工具：工具校验阶段返回结构化 tool error，不执行未知能力。

## Tool 契约

```ts
AgentTool = {
  name, label, description,
  parameters: typebox schema,
  execute(toolCallId, params, signal, onUpdate) → AgentToolResult,
}
```

工具执行产生三类领域 effect：

- `knowledge_search`：合并证据、检索 Trace、查询计划、mode 和指代记录。
- `terminal`：例如 `ask_clarification`，直接结束当前轮并等待用户。
- `none`：只返回 observation，不改变 Agent 领域状态。

工具在每次请求内构建，闭包持有该请求的 tenant / KB scope / progress，模型无法扩大范围。

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

证据编号在整个对话轮次中稳定：后续搜索只追加新证据，不会重排已有 `[1]`、`[2]`。HyDE 只影响召回，不作为证据。`allow_analyst_mode=false` 时，执行层拒绝 analyst mode，不依赖模型自觉。

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

多轮“生成 → 验证 → 修复 → 再验证”不在此实现，避免一个简单问题触发多次串行 LLM 调用。

### 检索无结果

一旦调用过 `knowledge_search` 但没有积累证据，最终回答强制为 `low`，并写入 `NO_RELEVANT_CHUNKS`。它不会被误判成普通直接回答；伪造的 `[n]` 会被移除为明确的无证据说明。

### 澄清

只有存在会导致不同检索路径的真实意图歧义时才调用 `ask_clarification`。弱召回或缺文档不是歧义。该工具通过 `afterToolCall → { terminate: true }` 结束本轮。

## 运行时护栏

- 显式最大步数：`shouldStopAfterTurn` 在达到 `max_react_steps` 时结束；
- 完全相同的工具名和参数只允许执行一次：`beforeToolCall` 返回 `{ block: true }`；
- 无证据却带 `[n]` 的正文被拒绝：`shouldStopAfterTurn` 发 `response_reset`、注入纠正 user 消息后重问一次；
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
task: native-tool-react-v21
cache_protocol: v3
```

版本随 Agent Trace 持久化，用于回放、灰度和评估。

## 测试基线

`apps/api-bun/src/agent/pi/kernel.test.ts` 必须覆盖：

- `你好`：一次模型调用、零 tool call、零 retrieval；
- 文档事实：tool call、引用、verifier 和 Trace 完整；
- 多次不同搜索：证据编号稳定；
- 重复工具调用：第二次被拒绝；
- 检索无结果：low + `NO_RELEVANT_CHUNKS`；
- 指代不明：澄清且不检索；
- 文档问答后的 `你好`：仍按当前消息直接回答；
- 会话知识库范围：已有会话沿用服务端 session scope。

测试使用 pi-ai 的 faux provider 脚本化模型响应，不需要真实 LLM 端点。

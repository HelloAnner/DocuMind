# 技术框架选型 (Technical Framework)

Agent 域需要明确技术落点：DocuMind 不采用 Python/Node 的 Agent 全家桶作为核心运行时，而是在现有 Rust 单体服务内实现一个可观测、可替换、可测试的 Agent Kernel。

## 最终选择

| 层 | 选择 | 说明 |
|---|---|---|
| HTTP / API | `axum` + `tokio` | 仓库已采用，负责 REST、SSE、路由、中间件 |
| Agent 编排 | 自研 `documind-agent` Rust crate | 用强类型状态机和 trait adapter 实现可控流程 |
| LLM 抽象 | `rig-core` 优先，必要时补 `async-openai` adapter | Rig 负责 LLM 应用抽象；OpenAI-compatible client 兜底流式和私有模型兼容 |
| Prompt 管理 | 自研 `PromptRegistry` | 版本化、租户配置、模式 prompt 组合 |
| RAG 工具 | 自研 trait + adapter | 检索、精排、引用校验、缓存都走本地接口 |
| 持久化 | PostgreSQL + SQLx | 保存 message、trace、prompt version、agent mode |
| 缓存 | Redis | 热点问答、请求去重、短期状态 |

一句话：**Axum/Tokio 做服务运行时，自研 Rust Agent Kernel 做决策编排，Rig/OpenAI-compatible adapter 做模型接入。**

## 为什么这样选

### 不选 LangChain / LlamaIndex 作为核心

- 主要生态偏 Python/Node，和 DocuMind 当前 Rust 单体部署方向不一致
- 企业权限、trace、引用校验需要强业务定制，框架抽象反而会遮住关键细节
- DocuMind 的核心竞争力不是“能调用工具”，而是“可信地调用 RAG 工具并完整留痕”
- 自研 Kernel 可以把权限、证据、引用、Prompt 版本和评估样本做成一等公民

### 选择 Rig 的位置

Rig 适合承担 LLM 应用层抽象，例如 model provider、completion、embedding、tool 调用等。但 DocuMind 不把业务编排完全交给 Rig，而是把 Rig 包在 `LlmClient` / `ToolClient` adapter 后面。

```text
Agent Kernel
  │
  └── LlmClient trait
        ├── RigLlmClient
        └── OpenAiCompatClient
```

这样后续即使替换 Rig，也不会影响 Agent 的领域流程。

## 代码结构建议

```text
apps/api-rs/
  src/
    api/
      conversations.rs
      agent.rs
    state.rs

crates/
  documind-agent/
    src/
      lib.rs
      kernel.rs
      mode.rs
      planner.rs
      prompt.rs
      tools.rs
      policy.rs
      verification.rs
      trace.rs
      error.rs

  documind-rag/
    src/
      retriever.rs
      reranker.rs
      context.rs
      citation.rs

  documind-llm/
    src/
      client.rs
      rig_client.rs
      openai_compat.rs
      stream.rs
```

## Agent Kernel 主流程

```text
AgentRequest
  │
  ▼
load_policy
  │  租户语气、知识库策略、引用要求
  ▼
select_mode
  │  answerer / clarifier / summarizer / comparer / analyst ...
  ▼
rewrite_or_clarify
  │  保真改写，指代不明则澄清
  ▼
plan_retrieval
  │  single query / multi query
  ▼
retrieve_and_rerank
  │  hybrid search + reranker
  ▼
assemble_evidence
  │  token budget、引用元数据、证据片段
  ▼
compose_prompt
  │  persona + guardrail + mode + task
  ▼
stream_answer
  │  SSE token delta
  ▼
verify_claims
  │  citation coverage、无依据结论移除或降置信度
  ▼
persist_trace
```

## 核心 Rust 接口

### AgentKernel

```rust
pub struct AgentKernel<M, R, P, V> {
    pub mode_selector: M,
    pub rag: R,
    pub prompt_registry: P,
    pub verifier: V,
}

impl<M, R, P, V> AgentKernel<M, R, P, V> {
    pub async fn run(&self, req: AgentRequest) -> Result<AgentRun>;
}
```

### AgentRequest

```rust
pub struct AgentRequest {
    pub tenant_id: Uuid,
    pub user_id: Uuid,
    pub conversation_id: Uuid,
    pub user_message_id: Uuid,
    pub original_query: String,
    pub effective_kb_ids: Vec<Uuid>,
    pub history: Vec<ConversationTurn>,
    pub options: AgentOptions,
}
```

### AgentRun

```rust
pub struct AgentRun {
    pub assistant_message_id: Uuid,
    pub mode: AgentMode,
    pub rewritten_query: Option<String>,
    pub retrieval_plan: RetrievalPlan,
    pub answer_stream: AnswerStream,
    pub trace: AgentTrace,
}
```

### LLM Client

```rust
#[async_trait::async_trait]
pub trait LlmClient: Send + Sync {
    async fn complete_json<T>(&self, prompt: Prompt) -> Result<T>
    where
        T: serde::de::DeserializeOwned;

    async fn stream_text(&self, prompt: Prompt) -> Result<LlmTextStream>;
}
```

### RAG Tool

```rust
#[async_trait::async_trait]
pub trait RagTool: Send + Sync {
    async fn retrieve(&self, input: RetrievalInput) -> Result<Vec<RetrievedChunk>>;
    async fn rerank(&self, input: RerankInput) -> Result<Vec<RerankedChunk>>;
    async fn assemble_context(&self, input: ContextInput) -> Result<EvidencePack>;
}
```

## 这些功能怎么实现

### 1. 灵魂和温度

实现方式不是写死一条大 prompt，而是 `PromptRegistry` 组合多层 prompt：

```text
persona_prompt
+ guardrail_prompt
+ mode_prompt(agent_mode)
+ tenant_policy_prompt
+ task_prompt
```

技术要求：

- prompt 模板有版本号
- prompt 变量结构化传入，不拼接散乱字符串
- 每次回答保存 prompt version
- 租户只能配置语气和输出偏好，不能关闭证据红线

### 2. 角色灵活度

用 `ModeSelector` 先做轻量分类：

```rust
pub enum AgentMode {
    Answerer,
    Clarifier,
    Summarizer,
    Comparer,
    Analyst,
    Navigator,
    Reviewer,
}
```

实现策略：

- 简单规则优先：包含“对比”“总结”“在哪页”等明显意图时直接判定
- 规则不确定时调用小模型输出 JSON
- mode 结果落库，便于后续评估
- mode 只影响 prompt 和工具规划，不改变证据边界

### 3. 真实问题保真

`QueryRewriter` 输出结构化 diff：

```rust
pub struct RewriteOutput {
    pub rewritten_query: String,
    pub resolved_refs: Vec<ResolvedRef>,
    pub added_constraints: Vec<String>,
    pub removed_constraints: Vec<String>,
    pub needs_clarification: bool,
    pub clarification_question: Option<String>,
}
```

实现策略：

- original query 永久保存
- rewritten query 不覆盖 original query
- 如果 `added_constraints` 没有历史证据，拒绝改写或触发澄清
- 高风险问题默认降低自动补全力度

### 4. 工具调用规划

不用自由 ReAct 循环作为默认模式，而用有限状态图：

```text
mode -> rewrite -> plan -> retrieve -> rerank -> generate -> verify
```

只有在以下场景允许多步工具调用：

- 多文档对比
- 总结整份文档
- 用户要求检查遗漏
- 第一次检索无结果，需要换同义词再试一次

默认最多 2 轮检索，避免成本和不可控行为。

### 5. 有引用的流式回答

Axum 使用 SSE 输出 token。生成前先完成检索和证据组装，因此回答过程中可以随 token 一起发送引用占位，完成后发送最终 citations。

```text
event: answer.delta
event: citation.delta
event: answer.completed
event: answer.failed
```

技术实现：

- `tokio::sync::mpsc` 连接 LLM stream 和 SSE response
- 每个 delta 同时写入 partial buffer
- 断线不取消后台任务，除非用户显式 cancel
- completed 后统一落库 answer、citations、usage、trace

### 6. 防幻觉和可信边界

`ClaimVerifier` 在生成后做轻量校验：

```rust
pub trait ClaimVerifier {
    fn verify(&self, answer: &str, evidence: &EvidencePack) -> VerificationReport;
}
```

第一阶段用规则实现：

- 数字、日期、金额、条款编号必须在 evidence 中出现
- 每个列表要点至少有一个 citation
- 没有 citation 的风险判断降置信度
- 无证据句子改写为“当前文档未找到明确说明”

第二阶段可接入小模型做 claim-to-evidence 对齐。

## Axum 接入方式

```rust
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/agent/run", post(run_agent))
        .route("/api/conversations/:id/messages", post(send_message))
        .with_state(state)
}
```

Conversation API 调用 Agent：

```rust
async fn send_message(
    State(state): State<AppState>,
    Json(req): Json<SendMessageRequest>,
) -> Result<SseResponse> {
    let agent_req = AgentRequest::from_conversation(req, state.actor_scope()).await?;
    let run = state.agent_kernel.run(agent_req).await?;
    Ok(SseResponse::from(run.answer_stream))
}
```

## 分阶段落地

### Phase 1：可控 RAG Agent

- `AgentKernel`
- `ModeSelector` 规则版
- `PromptRegistry`
- `RagTool` adapter
- SSE stream
- trace 落库

### Phase 2：灵活模式

- 小模型 mode selection
- multi-query planning
- clarification flow
- summarizer / comparer / analyst mode prompts

### Phase 3：可信增强

- claim verifier
- prompt A/B
- 真实问题评测集
- feedback-driven regression tests

### Phase 4：高级工具

- 文档版本冲突检测
- 表格证据结构化
- 长文档 map-reduce summary
- 管理员可配置 Agent policy

## 依赖建议

以下依赖分两类：`axum`、`tokio`、`tower-http` 与当前仓库 workspace 版本保持一致；`rig-core`、`async-openai` 为 2026-06-13 通过 `cargo search --registry crates-io` 校验到的当前可用版本。正式落地时仍以 `cargo check`、兼容性测试和锁文件为准。

```toml
[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
tokio-stream = "0.1"
tower-http = { version = "0.5", features = ["cors", "trace"] }
async-trait = "0.1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
futures = "0.3"
sqlx = { version = "0.8", features = ["runtime-tokio", "postgres", "uuid", "chrono", "json"] }
redis = { version = "0.25", features = ["tokio-comp"] }
rig-core = "0.38.2"
async-openai = "0.41.0"
```

核心设计不依赖某一个三方 Agent 框架的内部类型。`rig-core` 和 `async-openai` 都必须被包在 `documind-llm` 的 adapter 后面，不能让外部库类型扩散到 Conversation、Agent 或 RAG 的领域模型中。

## 技术结论

DocuMind Agent 的技术路线是：

```text
Rust 单体服务
  + Axum/Tokio HTTP/SSE
  + 自研 Agent Kernel 状态机
  + Rig/OpenAI-compatible LLM Adapter
  + 自研 RAG Tool Adapter
  + PostgreSQL Trace
  + Redis Cache
```

这套方案能同时满足三件事：

- 有灵魂：Persona、Mode、Interaction Policy 都能配置和版本化
- 有灵活度：不同角色模式和有限工具规划支持复杂问题
- 可信：权限、证据、引用、trace 和评估都在 Rust 领域模型里显式表达

# Router 路由机制

Router 是 Agent Kernel 的调度中枢，负责把用户问题映射到合适的**角色模式**、**检索策略**和**工具链**。它是 Agent “灵魂”落地的关键工程组件：既要快（避免每次都走 LLM），又要准（复杂问题不能选错模式），还要可解释（每次路由决策可审计）。

## 1. 为什么需要 Router

Agent 不是单一路径的问答脚本。同一用户会话中，问题可能是：

- 明确的事实查询 → 直接回答
- 指代不明的追问 → 澄清
- 跨文档比较 → 多路检索 + 对比模板
- 风险判断 → 分析模式 + 证据边界

如果没有显式 Router，这些决策会散落在 prompt 和 handler 中，导致不可预测、难以调试、难以评估。

## 2. Router 三层架构

```text
User Request
    │
    ▼
┌─────────────┐
│ Mode Router │  决定角色模式：answerer / clarifier / summarizer / comparer / analyst / navigator / reviewer
└──────┬──────┘
       │
       ▼
┌────────────────┐
│ Retrieval Router │  决定检索策略：single / multi-query / hyde / clarification-only
└───────┬────────┘
        │
        ▼
┌──────────────┐
│ Tool Router  │  决定工具链：rewrite → retrieve → rerank → generate → verify
└──────────────┘
```

## 3. Mode Router（角色路由）

### 3.1 输入

```json
{
  "original_query": "帮我对比一下 A 合同和 B 合同的付款节点",
  "history": [...],
  "effective_kb_ids": ["kb_001"],
  "resolved_refs": [...]
}
```

### 3.2 路由表

| 模式 | 规则匹配（优先级高） | LLM 判断（规则不确定时） |
|---|---|---|
| `clarifier` | 指代词存在且 unresolved；多个候选对象；用户说“这个”“那个”但无明确引用 | 规则命中即可，不走 LLM |
| `summarizer` | 包含“总结”“概要”“讲了什么”“主要内容” | 确认意图后切换 |
| `comparer` | 包含“对比”“比较”“区别”“差异”“A 和 B” | 确认比较对象后切换 |
| `analyst` | 包含“风险”“是否合理”“是否合规”“能不能签”“建议” | 确认是文档内分析而非通用建议 |
| `navigator` | 包含“在哪一页”“哪里提到”“第几页” | 规则命中即可 |
| `reviewer` | 包含“检查”“遗漏”“完整吗”“有没有问题” | 确认检查范围 |
| `answerer` | 默认兜底 | 明确事实查询 |

### 3.3 分类器实现

```text
ModeSelector
  │
  ├── Rule-based fast path
  │     ├── 关键词 / 正则 / 历史状态匹配
  │     └── 命中则直接返回 mode
  │
  └── LLM-based classifier
        ├── 输入：original_query + 最近 2 轮历史
        ├── 输出：{ "mode": "comparer", "reason": "..." }
        └── 仅当规则不确定时调用
```

### 3.4 输出

```json
{
  "mode": "comparer",
  "reason": "user explicitly asked to compare A and B",
  "confidence": "high",
  "requires_citation": true
}
```

## 4. Retrieval Router（检索策略路由）

### 4.1 决策输入

- 当前 `mode`
- `original_query` 长度与复杂度
- 是否包含多实体、多条件、比较结构
- 历史上下文是否完整
- 配置开关：`hyde_enabled`、`multi_query_enabled`

### 4.2 策略表

| 模式 | 默认检索策略 | 说明 |
|---|---|---|
| `answerer` | single query + HyDE | 直接回答，优先准排 |
| `clarifier` | no retrieval | 只生成澄清问题 |
| `summarizer` | single query + 文档范围扩展 | 检索文档关键章节 |
| `comparer` | multi-query（每个对象一个子查询） | 分别检索 A/B |
| `analyst` | single query + 可选 multi-query | 检索相关风险/条款 |
| `navigator` | single query + BM25 增强 | 精确定位位置 |
| `reviewer` | multi-query（检查清单逐项检索） | 逐项核对 |

### 4.3 输出

```json
{
  "strategy": "multi_query",
  "sub_queries": [
    { "query": "A合同付款节点", "target": "A" },
    { "query": "B合同付款节点", "target": "B" }
  ],
  "hyde_enabled": false,
  "reason": "comparer mode requires separate retrieval for each object"
}
```

## 5. Tool Router（工具链路由）

### 5.1 默认工具链

```text
mode -> rewrite -> plan -> retrieve -> rerank -> generate -> verify
```

### 5.2 各模式工具链

| 模式 | 工具链 | 特殊说明 |
|---|---|---|
| `answerer` | rewrite → retrieve → rerank → generate → verify | 标准链路 |
| `clarifier` | rewrite → ask_clarification | 不检索、不生成答案 |
| `summarizer` | rewrite → retrieve → rerank → generate → verify | retrieve 时扩大 Top-K |
| `comparer` | rewrite → plan(multi-query) → retrieve × N → merge → rerank → generate → verify | 多路结果合并 |
| `analyst` | rewrite → retrieve → rerank → generate → verify | 生成时加入风险边界 |
| `navigator` | rewrite → retrieve → rerank → generate → verify | 输出格式侧重位置 |
| `reviewer` | rewrite → plan(checklist) → retrieve × N → merge → rerank → generate → verify | 输出检查清单 |

### 5.3 动态重试

以下场景允许在 Tool Router 内触发一次重试：

- 第一次检索无结果，可换同义词再试一次。
- Multi-Query 某子查询无结果，其他子查询仍继续。

默认最多 2 轮检索，避免成本和不可控行为。

## 6. Router 与 Agent Kernel 集成

```text
AgentRequest
  │
  ▼
load_policy
  │
  ▼
ModeRouter.select_mode(req) ──► AgentMode
  │
  ▼
RetrievalRouter.plan(req, mode) ──► RetrievalPlan
  │
  ▼
ToolRouter.execute(plan) ──► AgentRun
  │
  ▼
verify_claims + persist_trace
```

## 7. Router 接口设计

```rust
pub trait ModeRouter: Send + Sync {
    async fn select_mode(&self, input: ModeRouterInput) -> Result<ModeDecision>;
}

pub trait RetrievalRouter: Send + Sync {
    async fn plan(&self, mode: AgentMode, input: RetrievalRouterInput) -> Result<RetrievalPlan>;
}

pub trait ToolRouter: Send + Sync {
    async fn execute(&self, plan: RetrievalPlan, ctx: AgentContext) -> Result<AgentRun>;
}
```

## 8. 路由决策记录

每条 assistant message 保存完整路由决策，便于复盘：

```json
{
  "message_id": "msg_001",
  "router_decisions": {
    "mode": { "selected": "comparer", "reason": "...", "classifier": "rule" },
    "retrieval": { "strategy": "multi_query", "sub_queries": 2 },
    "tool_chain": ["rewrite", "plan", "retrieve", "rerank", "generate", "verify"]
  }
}
```

## 9. Fallback 与重路由

| 场景 | 处理 |
|---|---|
| Mode 分类器超时 | 回退到 `answerer` |
| Retrieval plan 生成失败 | 回退到 single query |
| 某模式检索无结果 | 可重路由到 `clarifier` 或返回无结果 |
| LLM 输出无法解析 | 记录错误，回退到默认链路 |

## 10. 评估指标

| 指标 | 说明 |
|---|---|
| `router.mode_accuracy` | 模式选择准确率（对比人工标注） |
| `router.rule_hit_rate` | 规则快速路径命中率 |
| `router.llm_classifier_calls` | LLM 分类器调用次数 |
| `router.retrieval_plan_success_rate` | 检索规划成功率 |
| `router.reroute_count` | 重路由次数 |

## 11. 相关文档

- [角色灵活度](./role-flexibility.md)
- [技术框架](./technical-framework.md)
- [Agent 智能体](./agent.md)

# 查询改写 (Query Rewriting)

查询改写是 Query Pipeline 的第一阶段，目标是把用户自然语言提问转换成**适合检索、保留原意、可被下游验证**的结构化查询。改写质量直接决定 Dense / Sparse 两路检索的召回上限，也决定了 Agent 是否真正理解用户。

## 1. 定位与边界

- **做什么**：指代消解、意图显化、关键词抽取、同义词扩展、复杂问题拆解、HyDE 生成。
- **不做什么**：不替用户补充未经历史确认的事实；不把模糊问题强行改写成确定问题；不修改用户原始问题原文。
- **核心红线**：改写后的查询必须能从「原始问题 + 历史消息」中解释出来；任何新增实体、时间、数值、判断标准都需标注来源，否则回退或触发澄清。

## 2. 输入输出契约

### 2.1 输入

```json
{
  "original_query": "那它什么时候付款？",
  "conversation_id": "conv_001",
  "history": [
    {
      "role": "user",
      "content": "Q3采购合同的违约责任是什么？"
    },
    {
      "role": "assistant",
      "content": "根据《2025年Q3采购合同》……",
      "citations": [
        { "doc_title": "2025年Q3采购合同.pdf", "chunk_id": "chunk_003" }
      ]
    }
  ],
  "effective_kb_ids": ["kb_001"],
  "options": {
    "hyde_enabled": true,
    "multi_query_enabled": true,
    "max_sub_queries": 3
  }
}
```

### 2.2 输出

```json
{
  "original_query": "那它什么时候付款？",
  "rewritten_query": "2025年Q3采购合同约定的付款节点是什么？",
  "keywords": ["2025年Q3采购合同", "付款节点", "付款时间", "验收后付款"],
  "hypothetical_answer": "合同约定签署后支付首付款30%，验收通过后支付60%，质保期结束后支付10%。",
  "sub_queries": [],
  "resolved_refs": [
    {
      "text": "它",
      "resolved_to": "2025年Q3采购合同",
      "source_message_id": "msg_assistant_001",
      "confidence": "high"
    }
  ],
  "added_constraints": [],
  "removed_constraints": [],
  "needs_clarification": false,
  "clarification_question": null
}
```

### 2.3 字段说明

| 字段 | 说明 |
|---|---|
| `rewritten_query` | 给 Dense Vector Search 的主查询，保留完整语义 |
| `keywords` | 给 BM25 的关键词/短语集合，可包含同义词 |
| `hypothetical_answer` | HyDE 生成的假想答案，作为备用 Dense 查询向量（可选） |
| `sub_queries` | Multi-Query 拆解后的子查询，每个子查询独立检索后合并 |
| `resolved_refs` | 指代消解记录，用于后续保真校验和引用链 |
| `added_constraints` | 改写时新增的约束，必须有历史或上下文来源 |
| `needs_clarification` | 无法可靠改写时返回 true，下游不再检索 |

## 3. 核心改写策略

### 3.1 多轮上下文融合与指代消解

- 默认取最近 **3-5 轮**完成态 QA 作为上下文。
- 只把历史用于**理解意图**，不把历史答案作为事实来源。
- 消解目标必须显式化：`resolved_refs` 记录原文片段、解析来源 message、置信度。
- 当候选指代对象多于一个且无法区分时，返回 `needs_clarification=true`。

### 3.2 HyDE（Hypothetical Document Embedding）

- 触发条件：`hyde_enabled=true` 且问题适合用段落回答（非导航、非澄清）。
- 流程：用轻量 LLM 生成假想答案段落 → 对假想答案做 embedding → 作为 Dense 查询向量。
- 与 `rewritten_query` 的向量做**加权融合**或**独立检索后合并**，默认权重：`rewritten_query=0.7`，`hypothetical_answer=0.3`。
- HyDE 失败或生成无关内容时，自动回退到 `rewritten_query` 向量。

### 3.3 Multi-Query 扩展

- 触发条件：问题包含多实体、多条件、比较、总分结构，且 `multi_query_enabled=true`。
- 每个子查询必须是完整独立检索单元，子查询数量 ≤ `max_sub_queries`（默认 3）。
- 子查询必须能逐条映射回原始问题，禁止为拆分而拆分。
- 下游检索对每个子查询并行执行，结果按 RRF 合并去重。

### 3.4 术语规范化与企业黑话映射

- 优先使用租户级术语表 / 同义词表做规则映射，降低 LLM 猜测。
- 对不在术语表中的新缩写，LLM 可尝试展开，但需在 `added_constraints` 中标注，供保真校验审查。
- 严禁把口语中的模糊数量词（“大概”“可能”）改写成精确数字。

### 3.5 查询解析（面向 BM25）

- `keywords` 从 `rewritten_query` 中抽取，保留名词短语、专有名词、数字、日期、条款编号。
- 可自动扩展同义词（如“付款节点”↔“付款时间”↔“付款条件”），扩展范围受术语表约束。
- 对必须同时出现的关键概念，生成 `must` 短语；对可选近义词，生成 `should` 短语。

## 4. 改写流水线

```text
原始问题 + 历史 + scope
    │
    ▼
[Step 1] 意图识别
    │  判断：澄清 / 直接回答 / 总结 / 对比 / 分析 / 导航
    ▼
[Step 2] 上下文融合
    │  消解指代、继承话题、补全省略条件
    ▼
[Step 3] 术语映射
    │  术语表 + 同义词表
    ▼
[Step 4] 生成改写
    │  rewritten_query / keywords / hypothetical_answer / sub_queries
    ▼
[Step 5] 保真校验
    │  检查 added_constraints 是否有来源
    ├── 通过 → 输出
    └── 不通过 → 回退原始问题 或 触发澄清
```

## 5. Prompt 设计

### 5.1 System Prompt 骨架

```text
你是 DocuMind 查询改写助手。任务是把用户问题改写成适合企业文档检索的查询。

规则：
1. 保留用户真实意图，不添加历史中没有出现过的新实体、时间、数值或判断标准。
2. 可以结合最近对话历史消解指代词（“它”“那份文档”“这个指标”）。
3. 无法判断指代对象时，输出 needs_clarification=true 并给出简短澄清问题。
4. 复杂问题可拆分为 2-3 个子查询，每个子查询必须能回溯到原问题。
5. 输出严格的 JSON，不要解释。
```

### 5.2 Few-shot 示例

示例必须覆盖：直接改写、指代消解、需要澄清、Multi-Query、术语规范化。

## 6. 与下游对接

```text
RewriteOutput
    │
    ├── rewritten_query ──────────────┐
    ├── keywords ───────────────┐    │
    ├── hypothetical_answer ─────┤    │
    └── sub_queries ──────────────┤    │
                                │    │
    ┌───────────────────────────┘    │
    ▼                                ▼
BM25 Sparse Query              Dense Vector Query
    │                                │
    ▼                                ▼
ES multi-match / ik_max_word   ES kNN (HNSW, cosine)
```

- `rewritten_query` 同时作为 LLM 生成用的问题主干；`keywords` 专供 BM25。
- 存在 `sub_queries` 时，每个子查询独立产出 `rewritten_query` + `keywords`，并行检索后合并。
- `hypothetical_answer` 作为 Dense 向量的辅助输入，失败时回退。

## 7. 失败与降级策略

| 场景 | 处理 |
|---|---|
| LLM 改写超时/失败 | 回退到原始问题，keywords 用 jieba 分词兜底 |
| 输出 JSON 解析失败 | 记录日志，回退到原始问题 |
| 保真校验不通过 | 若新增约束无来源，触发澄清或回退 |
| HyDE 生成无关内容 | 丢弃 hypothetical_answer，仅用 rewritten_query |
| 子查询拆分失败 | 退化为单查询 |

## 8. 评估指标

| 指标 | 说明 |
|---|---|
| `rewrite.clarification_rate` | 澄清率，过高说明系统爱猜，过低说明可能硬答 |
| `rewrite.added_constraint_rate` | 新增约束比例，用于监控偏离原意 |
| `rewrite.resolution_accuracy` | 指代消解准确率 |
| `rewrite.json_valid_rate` | 输出 JSON 可用率 |
| `retrieval.recall@k` | 改写后检索召回率 |

## 9. 相关文档

- [混合检索](../7-hybrid-search/hybrid-search.md)
- [精排](../8-reranking/reranking.md)
- [答案生成](../9-answer-generation/answer-generation.md)
- [上下文策略](../10-conversation/context-policy.md)
- [问题保真](../10-conversation/question-fidelity.md)

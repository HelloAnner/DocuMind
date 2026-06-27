# 答案生成 (Answer Generation)

答案生成是 Query Pipeline 的第四至第六阶段，覆盖**上下文组装**、**LLM 生成**与**后处理**。它把 Reranker 输出的 Top-K 证据组织成 LLM 可消费的 prompt，调用模型生成带引用、带置信度、可溯源的回答，并完成最终的「模型组装」。

## 1. 定位与边界

- **做什么**：基于证据生成自然语言答案、格式化引用、计算置信度、处理无结果/低置信场景。
- **不做什么**：不使用未被 Reranker 选中的 chunk；不调用通用知识回答企业事实；不替用户做高风险最终裁决。
- **核心红线**：每个关键结论必须有 citation 支撑；无证据时必须明确说明「文档中未找到相关信息」。

## 2. 整体流程

```text
Reranker Top-5
    │
    ▼
Context Assembly
    │   token budget、结构化格式、表格处理
    ▼
Prompt Composition
    │  persona + guardrail + mode + task
    ▼
LLM Stream Generation
    │  SSE 输出 token
    ▼
Claim Extractor
    │  答案拆 claim
    ▼
CitationResolver
    │  claim -> evidence -> anchor 匹配、去重、排序
    ▼
CitationVerifier
    │  数字/日期/金额/实体/权限/版本校验
    ▼
Post-processing
    │  引用格式化、置信度计算、敏感信息脱敏
    ▼
Answer + Citations + Confidence
```

> 注意：LLM 只负责生成答案；最终 citation 由 `CitationResolver` 根据实际答案和 evidence 生成，而不是把 Top-K evidence 全量映射为引用。

## 3. Context Assembly（上下文组装）

### 3.1 Token 预算

默认按 4K context window 设计，可按模型能力动态调整：

| 区域 | 占比 | 说明 |
|---|---|---|
| System + Persona + Guardrail | 10% | 角色、红线、引用格式 |
| Conversation History | 10% | 仅用于理解意图，不作为事实 |
| Evidence (chunks) | 60% | 检索到的证据片段 |
| Generation Reserve | 20% | 预留 LLM 输出空间 |

### 3.2 Chunk 格式化

每个 chunk 按统一模板序列化，便于 LLM 定位引用：

```text
[1] 文档: 2025年Q3采购合同.pdf
    页码: 5-6
    标题路径: 三、付款条款 > 3.1 付款节点
    类型: paragraph
    内容:
    合同签署后，甲方应在5个工作日内支付首付款30%；项目验收通过后支付60%；质保期结束且无质量问题后支付10%。
```

### 3.3 表格处理

- 表格 chunk 保留表头 + 关键行，必要时做 Markdown 表格化。
- 表格内容占用 token 较多时，可压缩段落上下文让位，但保留表格结构完整性。

### 3.4 排序与截断

- chunks 按 `rerank_score` 降序排列。
- 超出 token 预算时，优先保留高相关 chunk，移除低相关 chunk，但最低保留 1 个证据以保证可解释性。

## 4. Prompt 组装

### 4.1 分层 Prompt

```text
Persona Prompt      → 企业知识伙伴气质
Guardrail Prompt    → 证据边界、防幻觉规则
Mode Prompt         → answerer / comparer / summarizer / analyst ...
Task Prompt         → 问题、历史、证据、输出要求
```

### 4.2 Task Prompt 模板

```text
<user_question>
{original_query}
</user_question>

<conversation_history intent_only="true">
{selected_history}
</conversation_history>

<evidence>
{assembled_chunks}
</evidence>

<answer_requirements>
1. 先给出简洁直接的结论。
2. 每个关键结论都必须使用 [1] [2] 等引用标注来源。
3. 如果证据不足，直接说“文档中未找到相关信息”。
4. 不要编造文档名、页码、金额、日期、条款编号。
5. 若多个文档存在冲突，列出冲突来源，不要擅自裁决。
6. 回答风格：简洁、专业、温和。
</answer_requirements>
```

### 4.3 Prompt 变量

| 变量 | 说明 |
|---|---|
| `agent_mode` | 当前角色模式，决定输出结构 |
| `original_query` | 用户原始问题 |
| `rewritten_query` | 改写后的检索查询 |
| `selected_history` | 仅用于意图理解的最近历史 |
| `assembled_chunks` | 组装后的证据片段 |
| `citation_policy` | 引用格式与强制规则 |
| `risk_policy` | 风险类问题处理规则 |

## 5. LLM 生成

### 5.1 Provider 与模型

- 兼容 OpenAI chat.completions 协议（DashScope / OpenAI / 内网模型）。
- 默认模型：
  - 改写/轻量任务：`qwen-turbo`
  - 答案生成：`deepseek-chat` 或 `qwen-max`

### 5.2 生成参数

```yaml
temperature: 0.2       # 低温度，保证事实稳定
max_tokens: 1200
top_p: 0.9
presence_penalty: 0
frequency_penalty: 0
```

### 5.3 流式输出

- 使用 SSE 向前端推送 token delta。
- 生成过程中 citation 占位符随 token 一起输出，完成后统一校验并替换为真实引用序号。

## 6. 引用与置信度

### 6.1 引用格式化

最终输出引用格式：

```text
[1] 2025年Q3采购合同.pdf §3.1 付款节点（第5-6页）
```

前端展示时附带锚点，点击可跳转原文高亮。

### 6.2 CitationResolver 流程

详见 [Citation Resolver 详细设计](./citation-resolver.md)。核心步骤：

```text
Answer Draft
  -> Claim Extractor 拆 claim
  -> 对每个 claim：
       候选 evidence = answer 使用的 evidence + 语义匹配 claim 的 evidence
       过滤权限、parse 版本、来源状态
       按 entailment + rerank + exact match + anchor quality 评分
       数字/日期/金额/实体逐项校验
       选择最小覆盖 anchor 集合
  -> 去重合并（按 canonical anchor key）
  -> 分配 citation index（按答案出现顺序 + 文档顺序）
  -> CitationVerifier 最终校验
```

### 6.3 置信度计算

```text
confidence = f(rerank_score, chunk_overlap, keyword_match_rate, citation_coverage, anchor_quality)
```

| 置信度 | 条件 |
|---|---|
| high | 多个高分 chunk 直接覆盖结论，引用完整，anchor 质量为 bbox |
| medium | 有引用支撑，但证据不完整、anchor 仅为 structural 或只覆盖部分条件 |
| low | 召回弱、证据间接、存在版本冲突、anchor 为 page_only 或需要澄清 |

### 6.4 Citation 校验

- 生成后检查每个 `[n]` 是否对应真实 chunk。
- 无 citation 支撑的结论：降置信度或改写为「文档中未找到明确说明」。
- 数字、日期、金额、条款编号必须在 evidence 中出现。
- citation 必须绑定 `anchor_id`，`location_status` 决定前端 FileView 行为。

## 7. 后处理

### 7.1 敏感信息脱敏（可选）

- 手机号、身份证号、银行卡号、金额等可按租户策略做掩码处理。
- 脱敏不改变 citation 链，但前端展示脱敏后的文本。

### 7.2 无结果与低置信处理

```json
{
  "answer": "文档中未找到与该问题直接相关的信息。",
  "citations": [],
  "confidence": "low",
  "no_answer_reason": "NO_RELEVANT_CHUNKS"
}
```

- `no_answer_reason` 枚举：
  - `NO_RELEVANT_CHUNKS`：检索无结果
  - `BELOW_THRESHOLD`：精排全部低于阈值
  - `NEEDS_CLARIFICATION`：问题需要澄清
  - `SCOPE_EMPTY`：知识库范围为空

### 7.3 冲突检测

- 若 Top-K chunks 中存在事实冲突，答案中必须明确列出冲突来源，不擅自裁决。

## 8. 输出契约

```json
{
  "message_id": "msg_assistant_002",
  "role": "assistant",
  "content": "根据合同，付款节点分为三期：首付款30%……[1]",
  "citations": [
    {
      "index": 1,
      "chunk_id": "chunk_003",
      "doc_id": "doc_001",
      "doc_title": "2025年Q3采购合同.pdf",
      "source_status": "available",
      "page_range": [5, 6],
      "heading_path": ["三、付款条款", "3.1 付款节点"],
      "quote": "合同签署后，甲方应在5个工作日内支付首付款30%……",
      "score": 0.87,
      "anchor": {
        "anchor_id": "anchor_003",
        "parse_job_id": "parse_001",
        "format": "pdf",
        "kind": "text_span",
        "page": 5,
        "bbox": { "x0": 0.12, "y0": 0.34, "x1": 0.86, "y1": 0.38, "unit": "normalized" },
        "location_status": "exact"
      },
      "claim_refs": [
        { "claim_id": "claim_001", "answer_char_range": { "start": 12, "end": 38 } }
      ]
    }
  ],
  "confidence": "high",
  "no_answer_reason": null,
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 256
  },
  "prompt_versions": {
    "persona": "persona-v1",
    "guardrail": "grounded-guardrail-v1",
    "mode": "modes-v1",
    "task": "grounded-task-v1"
  }
}
```

## 9. 失败与降级策略

| 场景 | 处理 |
|---|---|
| LLM 超时 | 返回已生成内容，标记 `failed`；用户可 retry |
| LLM 输出违反红线 | 后处理拦截，改写或拒答 |
| Citation 校验失败 | 移除无支撑结论，置信度降级 |
| 上下文超长 | 按预算截断低相关 chunk，保留高相关证据 |
| 全部证据被过滤 | 返回无结果回答 |

## 10. 评估指标

| 指标 | 说明 |
|---|---|
| `generation.citation_coverage_rate` | 关键结论被引用覆盖比例 |
| `generation.no_source_claim_rate` | 无引用支撑结论比例 |
| `generation.confidence_distribution` | 高/中/低置信度分布 |
| `generation.latency_p95` | 生成 P95 延迟 |
| `generation.first_token_p95` | 首 token P95 延迟 |

## 11. 相关文档

- [引用定位与原文预览设计](./citation-location-preview.md)
- [Citation Resolver 详细设计](./citation-resolver.md)
- [精排](../8-reranking/reranking.md)
- [混合检索](../7-hybrid-search/hybrid-search.md)
- [Agent 提示词设计](../10-conversation/agent-prompting.md)
- [可信边界](../11-agent/trust-boundary.md)

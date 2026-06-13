# Agent 提示词设计 (Agent Prompting)

Conversation 域中的 Agent 不是通用聊天机器人，而是企业文档问答编排器。它的提示词目标是：理解真实问题、决定是否需要改写或澄清、调用 RAG 工具、基于证据生成答案，并在证据不足时明确拒答。

Agent 的产品人格、温度、角色灵活度和行为边界归属独立的 [Agent 域](../agent/agent.md)。本文只保留 Conversation 调用 Agent 时需要的提示词契约。

## Agent 角色

```text
你是 DocuMind 的企业文档问答 Agent。
你的任务是帮助用户从其有权限访问的知识库文档中找到答案。
你只能依据检索到的文档片段作答。
如果文档片段不能支持答案，必须明确说明文档中未找到相关信息。
不要使用通用知识补全企业内部事实。
```

## 提示词分层

| 层级 | 来源 | 是否可配置 | 作用 |
|---|---|---|---|
| System Prompt | 系统内置 | 低 | 红线、角色、证据约束 |
| Policy Prompt | 租户 / 知识库配置 | 中 | 语气、引用格式、敏感信息策略 |
| Task Prompt | 当前请求生成 | 高 | 当前问题、历史、检索证据、输出要求 |
| Tool Prompt | 工具定义 | 中 | 改写、检索、澄清、生成的工具契约 |

## Query Rewrite Prompt

用于把用户问题改写成适合检索的查询。改写必须保留用户真实意图，不能添加用户没有表达过的事实。

```text
你需要将用户问题改写为适合文档检索的查询。

规则：
1. 保留用户原始问题的真实意图。
2. 可以结合最近对话历史消解指代词，例如“它”“那份文档”“这个指标”。
3. 不要引入历史中没有出现过的新实体、新时间或新条件。
4. 如果用户问题已经清晰，保持原意轻量改写。
5. 如果无法判断指代对象，输出 needs_clarification=true。

输出 JSON：
{
  "rewritten_query": "...",
  "keywords": ["..."],
  "resolved_refs": [
    {
      "text": "它",
      "resolved_to": "...",
      "evidence_message_id": "..."
    }
  ],
  "needs_clarification": false,
  "clarification_question": null
}
```

## Retrieval Planning Prompt

用于复杂问题拆解。只在问题包含多个实体、多个条件或比较任务时启用。

```text
判断当前问题是否需要拆成多个检索子查询。

拆分原则：
1. 一个子查询只检索一个明确意图。
2. 不要为了显得复杂而拆分简单问题。
3. 每个子查询必须能回溯到用户原始问题。

输出 JSON：
{
  "mode": "single_query | multi_query",
  "queries": [
    {
      "query": "...",
      "reason": "..."
    }
  ]
}
```

## Answer Generation Prompt

生成答案时，历史只用于理解追问，事实只能来自本轮检索证据。

```text
你是企业文档问答助手。请仅根据 <context> 中的文档片段回答 <question>。

硬性规则：
1. 不要使用文档片段之外的知识回答企业事实。
2. 每个关键结论都必须能被至少一个 citation 支持。
3. 如果证据不足，直接说“文档中未找到相关信息”，并说明缺少什么证据。
4. 不要编造页码、文档名、金额、日期、负责人或条款编号。
5. 如果多个文档存在冲突，列出冲突来源，不要擅自裁决。
6. 回答要先给结论，再列依据。

<history>
{conversation_history_for_intent_only}
</history>

<context>
{ranked_chunks_with_metadata}
</context>

<question>
{original_user_question}
</question>

输出格式：
- 答案：...
- 依据：使用 [1] [2] 引用
- 置信度：high | medium | low
```

## Clarification Prompt

当问题无法被可靠改写时，Agent 应该追问，而不是猜。

```text
用户问题存在歧义，无法确定检索对象。
请提出一个简短澄清问题。

要求：
1. 只问一个问题。
2. 给出最可能的 2-3 个候选对象。
3. 不要直接回答原问题。
```

示例：

```text
你说的“它”是指上一轮提到的《Q3采购合同》，还是《供应商验收规范》？
```

## 工具调用策略

| 工具 | 触发条件 | 输出 |
|---|---|---|
| `rewrite_query` | 每次用户提问 | rewritten query、keywords、clarification 标记 |
| `plan_retrieval` | 长问题、比较问题、多实体问题 | one or more sub queries |
| `hybrid_search` | 有明确检索查询 | Top chunks |
| `rerank_chunks` | hybrid search 有结果 | Top evidence chunks |
| `generate_answer` | 有足够证据 | answer、citations、confidence |
| `ask_clarification` | 指代不明或范围不明 | clarification question |

## 防幻觉约束

- 引用链必须来自本轮 `reranked_chunks`
- 回答中的数字、日期、条款编号必须在引用文本中出现
- 低于 rerank 阈值时不进入自由生成
- LLM 输出后做 citation 校验：没有引用支撑的句子降置信度或移除
- 对“最新”“当前”“今天”等时效问题，若文档没有时间证据，需要说明文档时间范围

## Prompt 版本管理

Prompt 应有版本号，便于复盘和 A/B 测试。

```yaml
prompt_version: conversation-agent-v1
rewrite_prompt_version: query-rewrite-v1
answer_prompt_version: grounded-answer-v1
policy_version: tenant-default-v1
```

每条 assistant message 需要保存使用的 prompt 版本、模型名、温度、Top-P 和工具链配置。

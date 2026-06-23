# 上下文策略 (Context Policy)

上下文策略决定多轮对话中哪些历史会被带入 Query Rewrite 和 Answer Generation。目标是在保持追问体验的同时，避免 token 膨胀、权限越界和错误引用扩散。

## 上下文分层

| 层级 | 内容 | 用途 |
|---|---|---|
| 当前问题 | 用户最新输入 | 检索和生成的主输入 |
| 短期历史 | 最近 3-5 轮 QA | 指代消解、补全省略条件 |
| 会话摘要 | 超出窗口的历史摘要 | 长会话主题保持 |
| 检索证据 | 本轮 Top chunks | 答案生成唯一事实依据 |

## 历史选择规则

- 默认取最近 5 轮完成态 QA，排除 `failed` 和空回答
- 如果上一轮回答无引用，本轮不把上一轮答案作为事实依据
- 用户切换知识库范围后，只保留与当前 `kb_ids` 交集非空的历史
- 用户追问命中明显指代词时，提高上一轮 user/assistant message 权重
- 超过 token 预算时，优先保留用户问题，其次保留引用摘要，再丢弃长答案正文

## 指代消解

Query Rewrite 使用历史做问题补全，但输出必须显式化：

```json
{
  "original_query": "那它的违约责任是什么？",
  "rewritten_query": "2025年Q3采购合同中的违约责任条款是什么？",
  "resolved_refs": [
    {
      "text": "它",
      "resolved_to": "2025年Q3采购合同",
      "source_message_id": "msg_prev_assistant"
    }
  ]
}
```

## 安全边界

上下文不是权限来源。每次请求都必须重新基于 actor 计算 scope：

```text
actor -> Access Control -> allowed_kb_ids
request.kb_ids ∩ allowed_kb_ids -> effective_kb_ids
```

即使历史对话曾引用某个文档，如果当前用户或当前知识库范围无权访问，也不能继续携带该文档内容或引用。

## 事实来源规则

- Answer Generation 只能依据本轮检索 chunks 作答
- 历史 answer 只能用于理解用户意图，不能作为事实证据
- citations 只允许来自本轮 retrieved/reranked chunks
- 无 citations 的缓存答案不能直接复用，必须重新校验引用链

## Token 预算

| 区域 | 建议占比 | 内容 |
|---|---|---|
| System | 10% | 角色、红线、引用格式 |
| History | 10% | 最近多轮问题和必要答案摘要 |
| Context | 60% | 本轮 chunks 和元数据 |
| Generation | 20% | 预留输出空间 |

当上下文超限时，裁剪顺序为：

1. 删除低相关历史轮次
2. 压缩历史答案为摘要
3. 缩短 chunk 内容但保留标题、页码和表格关键行
4. 降低 Top-K，但不得低于可解释引用所需的最小证据

## 会话摘要

长会话可以异步生成摘要，保存为 conversation 级元数据：

```json
{
  "summary": "用户主要围绕 Q3 采购合同询问付款节点、违约责任和验收标准。",
  "entities": ["Q3采购合同", "付款节点", "违约责任", "验收标准"],
  "last_message_id": "msg_012"
}
```

摘要只参与意图理解，不作为答案事实依据。

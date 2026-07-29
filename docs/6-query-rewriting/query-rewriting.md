# 查询改写与检索规划

查询改写不再是每轮必跑的独立 LLM JSON 阶段，而是 `knowledge_search` 的显式参数。只有模型判断当前问题需要企业文档时，才在工具调用中形成自包含查询、Multi-Query、HyDE、关键词和指代记录。

## 为什么合并进工具

旧固定改写有两个问题：

- 即使用户只说“你好”，也会读取历史并生成 rewritten query；
- 分类、改写和生成分属多次调用，延迟和错误传播都很高。

现在当前消息首先由 AgentModel 语义判断。直接回答时完全没有 rewrite；需要文档时，改写结果和工具意图处在同一个结构化调用里。

## knowledge_search 输入

```json
{
  "queries": [
    "2025年Q3采购合同的付款节点",
    "2025年Q3采购合同的验收付款条件"
  ],
  "rerank_query": "2025年Q3采购合同的付款与验收节点",
  "hypothetical_answer": null,
  "response_mode": "comparer",
  "keywords": ["2025年Q3采购合同", "付款", "验收"],
  "resolved_references": [
    {
      "text": "它",
      "resolved_to": "2025年Q3采购合同"
    }
  ],
  "reason": "分别检索付款和验收条款"
}
```

## 保真规则

- 当前消息是主任务；
- 完整的新消息不得被上一轮问题覆盖；
- 只补全明确、唯一的指代或省略；
- query 必须自包含；
- 不增加历史中不存在的实体、日期、数值或约束；
- 存在两种会导致不同搜索的解释时调用 `ask_clarification`；
- 历史答案不得直接作为本轮证据。

## Multi-Query

`queries` 中每项都独立执行 dense + BM25，并分别参与 RRF。工具会限制数量到 `max_queries_per_step`，然后合并去重并统一 rerank。

适合：

- 多对象比较；
- 多条件问题；
- reviewer 检查清单；
- 一个问题中相互独立的多个事实。

依赖前一次结果的查询应在下一轮 tool call 提交。

## HyDE

`hypothetical_answer` 是可选召回辅助。只有 `hyde_enabled=true` 时才传入 Retriever。它永远不进入 evidence，不允许产生 citation，也不能覆盖实际文档内容。

## 关键词和指代 Trace

`keywords` 与 `resolved_references` 不参与权限判断，但会进入 Query Trace，支持：

- 检查模型是否引入新约束；
- 评估多轮指代准确率；
- 对比原始问题、rerank query 与最终召回；
- 复盘错误检索。

## 失败语义

没有隐式 fallback：

- 参数不是合法 JSON：返回 tool execution error；
- query 为空：明确拒绝；
- analyst 被禁用：明确拒绝；
- provider/retriever/reranker 失败：作为 observation 返回模型；
- 无召回：返回 `no_relevant_evidence`；
- 相同调用重复：Kernel 拒绝第二次执行。

模型可根据 observation 改变查询或说明限制。达到步数上限则以 low confidence 终止。

## 评估

- 直答 tool-call rate；
- greeting after document turn 的误检索率；
- rewrite drift rate；
- resolved-reference accuracy；
- retrieval recall@k；
- duplicate tool-call rejection rate；
- no-evidence classification accuracy；
- 端到端首字节与完成耗时。

# 模型原生路由

DocuMind 不再使用规则 Mode Router、Retrieval Router 和固定 Tool Router 串接每个请求。路由由同一次模型对话通过原生 `content + tool_calls` 完成，Kernel 负责确定性执行和安全约束。

## 路由协议

```text
model response
  ├── content only
  │     ├── no evidence: direct response
  │     └── evidence exists: grounded finalization
  └── tool_calls
        ├── knowledge_search
        └── ask_clarification
```

这避免“你好”也依次经过分类、改写、检索、生成和多轮验证，同时保留复杂问题多步检索的能力。

## 语义决策表

| 用户意图 | 模型行为 | Runtime 结果 |
|---|---|---|
| 问候、闲聊、确认 | 直接 content | 一次调用完成 |
| 通用写作/解释 | 直接 content | 不进入企业检索 |
| 企业文档事实 | `knowledge_search` | hybrid retrieval + rerank |
| 多对象比较 | 一次多 query 或多轮 search | 证据稳定合并 |
| 后续依赖前文的文档问题 | 自包含 search query | 重新获取当前证据 |
| 真正的指代歧义 | `ask_clarification` | 等待用户，不检索 |
| 首次检索弱 | 换查询再 search 或说明无结果 | 不允许相同调用循环 |

## response mode

Mode 由显式请求配置或 `knowledge_search.response_mode` 产生。它决定最终表达结构，不改变权限与证据边界。默认是 `answerer`。

模型可选择：

- `answerer`
- `summarizer`
- `comparer`
- `analyst`
- `navigator`
- `reviewer`

`clarifier` 只由终止型澄清工具产生。`allow_analyst_mode=false` 时工具执行会返回明确错误。

## 多步行为

- 同一模型轮次可以发出多个独立 tool call；
- 依赖上一次 observation 的搜索放到下一轮；
- 每个搜索可包含多个自包含 query；
- evidence ID 在整个 ReAct 过程中只追加不重排；
- 最大步数由 `max_react_steps` 控制；
- 完全相同调用通过指纹去重。

## 可审计性

路由不等于黑盒。Agent Trace 记录：

- 模型和 Prompt 版本；
- 每步 action 和时间；
- search queries、rerank query、HyDE；
- retrieved / accepted chunk IDs；
- keywords、resolved refs 和 warnings；
- mode、stop reason、usage；
- tool started/completed/failed Atom events。

因此可以直接从 CLI 判断某次 `你好` 是否错误调用了检索，也可以复盘复杂问题每一轮为什么拿到这些证据。

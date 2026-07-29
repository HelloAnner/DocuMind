# 回答生成与可信收口

回答生成是模型原生 ReAct 的终止分支，而不是每个请求都要经过的固定阶段。

## 两种回答路径

### 直接回答

当 AgentModel 返回 `content` 且本轮没有积累文档 evidence：

- 直接输出普通 Markdown；
- 不创建 citation；
- 不调用文档 ClaimVerifier；
- 默认 confidence 为 `medium`；
- stop reason 为 `direct_response`。

适用于问候、闲聊、写作帮助和不依赖企业知识库的普通问题。

如果此前调用过 `knowledge_search` 但仍没有 evidence，则不能走普通直答语义：confidence 强制为 `low`，写入 `NO_RELEVANT_CHUNKS`，stop reason 为 `no_relevant_evidence_response`。

### 文档证据回答

```text
accumulated stable evidence
  -> ContextAssembler
  -> candidate content from AgentModel
  -> ClaimVerifier（一次）
  -> CitationResolver
  -> answer + citations + confidence
```

文档证据由工具 observation 以稳定 `[n]` 交给模型。多轮搜索只追加 evidence ID，不改变已有编号。

## Context Assembly

- 只组装当前用户权限范围内实际召回并精排的 chunks；
- 按 `max_context_chars` 限制上下文；
- 重复 chunk 只保留更高分版本；
- 文档标题、heading path、page range 和正文一起进入 evidence；
- 历史回答和 HyDE 不进入 evidence。

## 一次验证

`GroundedAnswerFinalizer` 只调用 ClaimVerifier 一次：

1. verifier 支持候选，且 `[n]` 全部指向真实 evidence：采用候选及 verifier confidence；
2. verifier 不支持，但允许 correction 且返回的 corrected answer 引用结构有效：采用 correction，confidence 为 `medium`；
3. 其他情况：返回“现有文档证据不足以生成经过验证的可靠答案”，confidence 为 `low`。

`AGENT_MAX_REPAIR_ATTEMPTS` 现在只表示是否允许一次 verifier correction：

- `0`：禁用；
- `1`：允许；
- 大于 1 的旧配置在加载时收敛为 1。

系统不再循环调用 answer generator 和 verifier。

## CitationResolver

最终 citation 以后端实际答案中的 `[n]` 为输入：

- 只解析存在的 evidence ID；
- 不把所有 Top-K 自动变成引用；
- 按 canonical anchor 去重；
- 保留 chunk/doc/title/page/quote/score；
- 优先结构化 anchor，并保存 snapshot；
- 越界引用不映射到其他 chunk。

普通直接回答即使没有 citation 也不算错误；文档 grounded 回答由 `require_citation` 决定是否强制至少一个引用。

## 输出事件

```text
answer.delta
citation.delta × N
answer.completed
```

当前 OpenAI-compatible AgentModel 返回的是完整 assistant turn，Kernel 再通过现有 SSE 契约输出正文和引用。接口保持兼容，后续可在 provider 支持稳定的 streaming tool protocol 后扩展 token 级直出。

## 缓存

只有 high confidence 且带真实 citation 的文档答案写入 answer cache。缓存 key v3 包含：

- tenant 与 effective KB scope；
- 原始问题；
- 有界历史 + UTC 日期的 context fingerprint；
- 文档版本 hash；
- 模型、Prompt、检索和运行时配置 fingerprint。

这样不会把旧会话语义、昨天的时间问题或旧文档答案复用到当前请求。

## 不变量

- 无权限 evidence 永远不能进入模型上下文；
- 无 evidence 的检索结果不能伪装成 medium 直答；
- `[n]` 必须绑定真实 evidence；
- verifier correction 不触发第二轮生成；
- 失败不静默 fallback；
- Trace 与消息持久化结果一致。

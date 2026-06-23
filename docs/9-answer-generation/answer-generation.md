# 答案生成 (Answer Generation)

将检索到的 Top-5 chunks 组装为 prompt，调用 LLM 生成答案并做后处理。覆盖 Query Pipeline 的第四至第六阶段。

## 核心职责

### 上下文组装 (Context Assembly)

- 组织 chunks 为结构化 System + Context Prompt
- Token 预算管理：60% Context / 30% 生成 / 10% System + 历史
- 动态调整：有表格数据时压缩段落上下文让位

### LLM 生成

- 兼容 OpenAI chat.completions 协议（DashScope / OpenAI / 内网模型）
- 默认 qwen-turbo 或 deepseek-chat
- SSE 流式输出，前端逐字展示
- System Prompt 约束：仅根据文档片段回答，找不到明确告知

### 后处理

- 引用格式化：`[1] 文档名 §3.2 (第7页)` 带锚点链接
- 置信度计算：综合 rerank_score、chunk_overlap、keyword_match_rate
- 敏感信息脱敏（可选）

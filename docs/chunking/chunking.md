# 智能切割 (Chunking)

将清洗后的文档按语义边界切分为可检索的片段（chunk），是 Ingest Pipeline 的第三阶段。核心矛盾是切太碎丢上下文、切太粗检索不准。

## 三级切割策略

1. **结构感知切分**：按标题/小节/表格/slide 原生结构边界切分，单 chunk ≤ 1500 tokens
2. **语义补全（Sliding Window）**：前后各补 1 个相邻段落作为 overlap（15%~20%）
3. **子切分兜底**：超长段落递归按段落/句子边界继续切分

## Chunk 元数据

每个 chunk 记录：chunk_id、doc_id、kb_id、顺序索引、纯文本内容、标题路径、页码范围、token 数、来源类型（paragraph / table / slide_note）。

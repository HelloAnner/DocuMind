# Citation Resolver 详细设计

本文档定义 DocuMind 答案生成后的引用解析模块：如何把 LLM 答案拆成 claim，如何从证据中选择真正支撑 claim 的 `SourceAnchor`，如何去重、排序、校验，并输出给前端 FileView 使用的 `CitationOutput`。

## 1. 定位与边界

### 1.1 解决什么问题

当前很多 RAG 系统的问题是：**模型说了什么，就把 Top-K chunk 全挂成引用**。这会导致：

- 引用很多但不可信。
- 同一段原文被多个 chunk 命中，展示成多条重复引用。
- 数字、日期、金额类答案没有严格校验。
- 前端用 `quote` 做 `indexOf` 定位，漂移、错配、无法处理表格和 Office。

Citation Resolver 的目标：**每个 citation 都精确支撑答案中的某个 claim，并且能回到原文的某个 anchor。**

### 1.2 输入输出

**输入**：

```json
{
  "answer": "根据合同，付款节点分为三期：首付款30%……",
  "claims": ["claim_001", "claim_002"],
  "evidence": [
    {
      "chunk_id": "chunk_003",
      "score": 0.82,
      "content": "合同签署后，甲方应在5个工作日内支付首付款30%……",
      "anchor_refs": ["anchor_003", "anchor_004"],
      "primary_anchor": { "...": "..." }
    }
  ],
  "user_context": {
    "tenant_id": "tenant_001",
    "kb_ids": ["kb_001"],
    "user_id": "user_001"
  }
}
```

**输出**：`Vec<CitationOutput>`

```json
[
  {
    "index": 1,
    "doc_id": "doc_001",
    "doc_title": "2025年Q3采购合同.pdf",
    "source_status": "available",
    "quote": "合同签署后 5 个工作日内支付首付款 30%。",
    "score": 0.91,
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
]
```

## 2. 整体流程

```text
Reranked Evidence
  -> Context Assembly
  -> LLM Answer Draft
  -> Claim Extractor
  -> Citation Resolver
       ├── Permission Filter
       ├── Source Status Filter
       ├── Evidence Scorer
       ├── Numeric/Date/Entity Verifier
       ├── Anchor Selector
       └── Deduplication & Merge
  -> Citation Verifier
  -> Final Answer + Citations
```

## 3. Claim Extractor

把答案文本拆成独立的 claim。每个 claim 是答案中需要证据支撑的“事实断言”。

### 3.1 Claim 类型

| 类型 | 是否必须引用 | 示例 |
|---|---:|---|
| 文档事实 | 是 | “沙箱方案是在隔离环境中执行代码。” |
| 数字、日期、金额、条款、页码 | 是 | “首付款为 30%。” |
| 对多个文档的比较结论 | 是 | “A 方案比 B 方案多了审批步骤。” |
| 基于证据的建议 | 建议引用事实前提 | “建议优先采用 A，因为合同要求 5 个工作日内付款。” |
| 解释性连接语 | 否 | “这意味着实施时要注意权限控制。” |
| 寒暄、操作说明 | 否 | “我可以继续帮你查配置细节。” |

### 3.2 输出结构

```json
{
  "claim_id": "claim_001",
  "text": "首付款为 30%",
  "char_range": { "start": 12, "end": 22 },
  "claim_type": "numeric_fact",
  "entities": ["首付款", "30%"],
  "numbers": ["30%"],
  "requires_citation": true
}
```

### 3.3 实现方式

第一版可用规则 + 轻量模型：

1. 按句子切分。
2. 正则提取数字、日期、金额、百分比、条款编号。
3. 用轻量 LLM 判断 `requires_citation`。

后续可升级为专用 entailment/NLP 模型。

## 4. Citation Resolver

### 4.1 过滤层

#### Permission Filter

- 用户必须对 `doc_id` / `kb_id` 有读取权限。
- 无权限 evidence 不进入候选，且不向用户暴露其存在。

#### Source Status Filter

- `parse_job_id` 必须仍有效（未被删除或覆盖）。
- 文档未被删除。
- anchor 对应的 `source_status` 为 `available`。

### 4.2 评分层

每个 (claim, evidence, anchor) 三元组打分：

```text
citation_score =
  0.35 * entailment_score
+ 0.25 * rerank_score
+ 0.20 * exact_match_score
+ 0.15 * anchor_quality_score
+ 0.05 * freshness_score
```

| 分数 | 说明 |
|---|---|
| `entailment_score` | claim 是否被 evidence 语义支撑 |
| `rerank_score` | 检索精排分 |
| `exact_match_score` | 实体、数字、日期、专有名词匹配情况 |
| `anchor_quality_score` | `bbox` > `structural` > `page_only` |
| `freshness_score` | 是否来自最新 parse_job 和未删除文件 |

### 4.3 数值/日期/实体校验

数值类 claim 采用更严格规则：

```text
答案里出现 30%
原文里必须出现 30% 或等价表达
否则不能引用该 anchor
```

校验项：

- 数字、百分比、金额、数量单位。
- 日期、时间段、相对时间（如“5个工作日内”）。
- 条款编号、合同编号、项目代号。
- 专有名词、人名、地名、产品名。

### 4.4 Anchor 选择

对每个 claim：

```text
candidates = filter permission & status
score each candidate
reject if numeric/date/entity checks fail
selected = minimal anchors that cover claim
```

选择策略：

1. 优先选择 `primary_anchor`。
2. 若一个 anchor 已完整覆盖 claim，不选多个。
3. 若 claim 跨多个段落/表格 cell，选择多个相邻 anchor 并合并。
4. 无可用 anchor 时，该 claim 不挂 citation，置信度降级或改写。

## 5. 去重与合并

### 5.1 Canonical Key

引用去重按原文锚点去重：

```text
canonical_key =
  doc_id
  + parse_job_id
  + format
  + kind
  + page_or_slide
  + block_id/table_id/shape_id
  + normalized_cell_range
  + rounded_bbox
```

bbox 坐标按页面尺寸归一化后保留 3 位小数，避免同一位置因浮点误差产生多个引用。

### 5.2 合并规则

| 场景 | 处理 |
|---|---|
| 同一 anchor 被多个 claim 使用 | 复用同一个 citation index |
| 相邻 block 在同一页且距离小于阈值 | 合并为一个 citation，quote 展示连续摘要 |
| 表格多个单元格在同一区域 | 合并为 `table_cell_range` |
| chunk overlap 命中同一段原文 | 删除 overlap 产生的重复引用 |
| 同一文档同一页多个相距很远位置 | 保留多条 citation |
| 不同文档内容完全相同 | 不合并，保留不同来源 |

### 5.3 展示数量控制

- 默认每条答案最多展示 6 条 citation。
- 每个 claim 最多展示 2 条 citation。
- 如果一个 claim 被多个相邻 anchor 覆盖，优先合并为 1 条。
- 多余 citation 不丢弃，可放入 `supporting_citations`，默认折叠。

## 6. Citation Verifier

Resolver 之后再加一层 verifier，确保最终输出可信：

1. **数字一致性**：答案中的数字/日期/金额必须在对应 anchor 文本中出现。
2. **权限一致性**：用户有权限访问 citation 的 `doc_id`。
3. **版本一致性**：`parse_job_id` 未被删除或覆盖。
4. **Anchor 文本校验**：anchor 文本 hash 与保存的 `text_hash` 一致；不一致时降级为 `structural_only` 或 `page_only`。
5. **Location Status 标准化**：

| 状态 | 含义 | 前端行为 |
|---|---|---|
| `exact` | 有 bbox / quads / shape / cell | 跳转并高亮 |
| `structural_only` | 有段落/表格/shape，无 bbox | 滚动到结构块并框选 |
| `page_only` | 只有页码 | 跳页，提示只能定位到页 |
| `slide_only` | 只有 slide | 跳 slide，提示只能定位到页 |
| `unavailable` | 删除、无权限、版本失效 | 禁止打开或脱敏展示 |

## 7. 输出契约

```json
{
  "index": 1,
  "doc_id": "doc_001",
  "chunk_id": "chunk_003",
  "doc_title": "2025年Q3采购合同.pdf",
  "source_status": "available",
  "page_range": [5, 6],
  "quote": "合同签署后 5 个工作日内支付首付款 30%。",
  "score": 0.91,
  "anchor": {
    "anchor_id": "anchor_003",
    "parse_job_id": "parse_001",
    "format": "pdf",
    "kind": "text_span",
    "page": 5,
    "slide": null,
    "bbox": { "x0": 0.12, "y0": 0.34, "x1": 0.86, "y1": 0.38, "unit": "normalized", "rotation": 0 },
    "block_id": "block_003",
    "table_id": null,
    "cell_range": null,
    "char_range": { "start": 0, "end": 24 },
    "location_status": "exact"
  },
  "claim_refs": [
    { "claim_id": "claim_001", "answer_char_range": { "start": 12, "end": 38 } }
  ],
  "supporting_citations": []
}
```

## 8. 降级策略

| 问题 | 降级 |
|---|---|
| claim 无 evidence 支撑 | 降置信度；若为核心事实，改写为「文档中未找到明确说明」 |
| 数值/日期校验失败 | 移除该 citation，claim 不引用或改写 |
| 原文件存在但 FileView 预览未生成 | 返回 `structural_only`，右侧显示结构化块高亮 |
| 只有页码没有 bbox | 返回 `page_only`，跳页并提示只能定位到页 |
| 文档已删除 | citation 保留，`source_status = deleted`，不可打开 |
| 文档无权限 | 不返回 quote，显示“无权限查看来源” |
| parse_job 失效 | 尝试用最新 parse_job 通过 block/table/source_ref 迁移 anchor；失败则 `unavailable` |
| anchor 文本与原文件校验不一致 | 不做精确高亮，记录 `anchor_mismatch`，降级为 `structural_only` |

## 9. 模块划分

| 模块 | 职责 |
|---|---|
| `document/source_anchor` | 解析阶段生成和保存原文锚点 |
| `rag/evidence` | 检索结果携带 `anchor_refs` |
| `agent/claim_extractor` | 将答案拆为 claim |
| `agent/citation_resolver` | 引用筛选、校验、去重、排序 |
| `agent/citation_verifier` | 数字/日期/实体/权限/版本校验 |
| `api/file_preview` | 为 FileView 提供原文件或转换预览 URL |

## 10. 评估指标

| 指标 | 说明 |
|---|---|
| `citation_coverage` | 关键结论被引用覆盖比例 |
| `citation_precision` | citation 中真正支撑 claim 的比例 |
| `numeric_citation_accuracy` | 数字/日期/金额类 citation 校验通过率 |
| `duplicate_citation_rate` | 重复引用比例 |
| `page_only_rate` | 只能定位到页的比例 |
| `click_to_exact_highlight_rate` | 点击 citation 后精准高亮率 |

## 11. 相关文档

- [引用定位与原文预览设计](./citation-location-preview.md)
- [答案生成](./answer-generation.md)
- [精排](../8-reranking/reranking.md)
- [混合检索](../7-hybrid-search/hybrid-search.md)
- [解析数据存储模型](../1-document-parsing/storage-model.md)

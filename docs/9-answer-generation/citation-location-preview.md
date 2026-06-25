# 引用定位与原文预览设计

本文档定义 DocuMind 问答中的引用算法：如何判断一条答案需要引用、如何选择引用、如何去重、如何精准回到 PDF / Word / PPT / Markdown / TXT 原文位置，以及右侧预览如何使用 File View 组件展示原文并高亮命中区域。

当前问题的根因是：引用只保存 `chunk_id + page_range + quote`，前端再用 `quote` 去解析文本里做 `indexOf`。这会导致三类错误：

- 引用列表重复：多个检索 chunk 来自同一原文位置，却被展示成多条来源。
- 位置不准：清洗文本、chunk overlap、标题拼接、页眉页脚会改变原文文本顺序，`quote` 无法稳定映射到原文。
- 预览不是真原文：右侧展示的是解析后的文本片段，不是文件本身，PDF / Word / PPT 的版式、页码、坐标、表格区域都会丢失。

目标状态：引用必须绑定到解析阶段生成的原文锚点，右侧预览必须由 File View 组件打开原文件，并根据锚点高亮原文位置。

## 1. 设计原则

1. **引用是后端事实，不是前端猜测**  
   前端不负责用字符串搜索定位引用。后端必须返回可执行的 `source_anchor`，前端只负责把 anchor 交给 File View 渲染。

2. **chunk 不是最终引用单位**  
   chunk 用于检索和生成上下文；最终引用单位应是 block、table cell、slide shape、PDF text span 等可回到原文的位置。

3. **引用必须支撑答案中的具体 claim**  
   不是 Top-K 检索结果都展示为引用。只有被答案实际使用、并能支撑某个关键结论的证据才进入 citation。

4. **同一原文位置只展示一次**  
   同一个文件、同一页/slide、同一段落/表格区域，即使由多个 chunk 命中，也复用同一个 citation index。

5. **quote 是展示摘要，不是定位依据**  
   `quote` 可以用于卡片摘要和无 File View 时的降级展示，但不能作为高亮定位的主键。

## 2. 端到端流程

```text
Document Parsing
  -> 生成 source_anchor：原文件位置、页码/slide、bbox、结构节点、字符范围
Text Cleaning / Chunking
  -> chunk 保留 block_ids / table_ids / anchor_refs，不改写定位信息
Retrieval / Reranking
  -> 返回候选 evidence，每个 evidence 带 anchor_refs
Answer Generation
  -> 生成答案，并标记使用了哪些 evidence
Citation Resolver
  -> claim 校验、引用筛选、锚点合并、去重、排序
API / SSE
  -> 输出 answer + citations(anchor + quote + score)
Frontend
  -> 点击 citation，File View 打开原文件并高亮 anchor
```

## 3. 原文锚点模型

新增统一的 `SourceAnchor` 概念。它是引用定位的权威数据结构，应由解析阶段产生，并在 chunk、检索结果和 citation 中传递。

```json
{
  "anchor_id": "uuid",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "format": "pdf",
  "kind": "text_span",
  "page": 3,
  "slide": null,
  "block_id": "uuid",
  "table_id": null,
  "cell_range": null,
  "char_range": { "start": 128, "end": 196 },
  "bbox": {
    "page": 3,
    "x0": 72.1,
    "y0": 120.4,
    "x1": 520.2,
    "y1": 168.9,
    "unit": "pt",
    "rotation": 0
  },
  "source_ref": {
    "format": "pdf",
    "page": 3,
    "text_run_ids": ["run_0031", "run_0032"]
  },
  "text": "Python/TypeScript/JS 沙箱代码执行，让 Agent 动态执行代码安全无忧"
}
```

### 3.1 字段说明

| 字段 | 说明 |
|---|---|
| `anchor_id` | 原文锚点 ID，稳定绑定到一次解析版本 |
| `doc_id` / `parse_job_id` | 文件与解析版本，避免文档重新解析后坐标错配 |
| `format` | `pdf` / `docx` / `pptx` / `md` / `txt` |
| `kind` | `text_span` / `paragraph` / `table_cell_range` / `table_region` / `slide_shape` / `image_caption` |
| `page` | PDF 页码或转换后页面编号，从 1 开始 |
| `slide` | PPT slide 编号，从 1 开始 |
| `block_id` / `table_id` | 与结构化解析结果关联 |
| `cell_range` | 表格引用范围，包含 row/col 起止 |
| `char_range` | 在 block 原始文本中的字符范围，用于二次校验和文本级高亮 |
| `bbox` | File View 高亮用坐标，PDF/PPT 优先；Word 可由转换布局层补齐 |
| `source_ref` | 格式专属回溯信息，如 PDF text run、DOCX XPath、PPT shape id |
| `text` | anchor 覆盖的原文文本，仅用于校验和摘要 |

## 4. 各格式定位策略

### 4.1 PDF

PDF 必须以页面坐标作为主定位方式。

- 解析阶段按 page 提取 text runs，保存每个 run 的 `text + bbox + rotation + font`。
- block 由连续 runs 聚合而来，block 保存覆盖 bbox；更细粒度的 anchor 保存 run 范围和多个 bbox。
- 表格区域保存 table bbox；表格单元格保存 cell bbox。
- File View 打开原始 PDF，跳转到 `page`，按 bbox 或 quad boxes 画高亮层。

PDF 引用定位优先级：

1. `anchor.bbox` 或多个 quad boxes。
2. `anchor.source_ref.text_run_ids` 重新计算 bbox。
3. `page + char_range` 在同页文本层模糊校验后定位。
4. 只跳页不高亮，标记 `location_status = page_only`。

### 4.2 Word / DOCX

Word 原文件没有稳定页码坐标，必须同时保留结构节点和渲染布局锚点。

- 解析阶段保留 OpenXML 节点路径：段落 `w:p` index、表格 `w:tbl` index、单元格 row/col。
- 后台生成 File View 可用的预览布局，例如 DOCX -> PDF/HTML page view，并建立 OpenXML 节点到页面 bbox 的映射。
- 若转换布局可用，File View 按 `page + bbox` 高亮。
- 若转换布局暂不可用，File View 滚动到段落或表格节点，并使用结构节点高亮，不用纯文本搜索。

Word 引用定位优先级：

1. `rendered_page + bbox`，即转换后页面坐标。
2. `source_ref.xpath + paragraph/table/cell index`，结构节点高亮。
3. `block_id + char_range`，在对应 block 内高亮。
4. 只打开文件并定位到段落附近，标记 `location_status = structural_only`。

### 4.3 PowerPoint / PPTX

PPT 以 slide 和 shape 为主定位方式。

- slide 编号是必填定位字段。
- 文本框、标题、表格、备注都保存 shape id 或 notes 节点。
- shape 保存原始 PPT 坐标，File View 按 slide 尺寸比例换算到预览 canvas。
- 表格引用应能定位到 cell range，不只定位整张 slide。

PPT 引用定位优先级：

1. `slide + shape_id + bbox`。
2. `slide + table_id + cell_range`。
3. `slide + notes_node`。
4. 只跳转 slide，标记 `location_status = slide_only`。

### 4.4 Markdown / TXT

Markdown / TXT 可用字符偏移作为主定位方式。

- 解析阶段记录 block 在原文件中的 byte/char offset。
- heading、paragraph、table row 都保存 `char_range`。
- File View 以代码/文本查看器打开原文件，滚动到 offset 并高亮字符范围。

## 5. 如何判断需要引用

答案生成后进入 Citation Resolver，先把答案拆成 claim，再判断每个 claim 是否需要引用。

### 5.1 Claim 类型

| 类型 | 是否必须引用 | 示例 |
|---|---:|---|
| 文档事实 | 是 | “沙箱方案是在隔离环境中执行代码。” |
| 数字、日期、金额、条款、页码 | 是 | “首付款为 30%。” |
| 对多个文档的比较结论 | 是 | “A 方案比 B 方案多了审批步骤。” |
| 基于证据的建议 | 建议引用事实前提 | “建议优先采用 A，因为合同要求 5 个工作日内付款。” |
| 解释性连接语 | 否 | “这意味着实施时要注意权限控制。” |
| 寒暄、操作说明 | 否 | “我可以继续帮你查配置细节。” |

### 5.2 引用成立条件

一个 citation 必须同时满足：

1. claim 与 evidence 语义相关，rerank 或 entailment 分数达到阈值。
2. claim 中的关键实体、数字、日期、术语能在 evidence 或同一 anchor 邻近上下文中找到。
3. evidence 的 `source_anchor` 可用，至少能定位到 page / slide / block。
4. evidence 没有被权限过滤、文档删除或解析版本失效。

数值类 claim 采用更严格规则：数字、单位、比较符号必须逐项匹配；匹配失败时不得引用该证据支撑该 claim。

### 5.3 不允许的引用

- 只因检索 Top-K 命中就展示，但答案没有使用。
- 只引用 chunk overlap 中的重复上下文。
- 只引用标题路径或拼接提示词，无法回到原文。
- 引用已删除、无权限或 parse_job 已失效的来源，除非明确展示为不可用历史引用。

## 6. 引用选择算法

Citation Resolver 输入：

```json
{
  "answer": "最终答案文本",
  "claims": ["claim_1", "claim_2"],
  "evidence": [
    {
      "chunk_id": "uuid",
      "score": 0.82,
      "content": "检索上下文",
      "anchor_refs": ["anchor_1", "anchor_2"]
    }
  ]
}
```

处理流程：

```text
for each claim:
  candidates = evidence chunks used by answer or semantically matching claim
  candidates = filter by permission, parse version, source status
  candidates = score by entailment + rerank + exact token match + anchor quality
  candidates = reject if numeric/date/entity checks fail
  selected = minimal anchors that cover claim
  attach selected anchors to claim

all_selected = flatten claim anchors
deduped = merge_duplicate_anchors(all_selected)
ordered = assign index by first answer appearance, then document order
return citations
```

### 6.1 评分公式

```text
citation_score =
  0.40 * entailment_score
  + 0.25 * rerank_score
  + 0.20 * exact_match_score
  + 0.10 * anchor_quality_score
  + 0.05 * freshness_score
```

| 分数 | 说明 |
|---|---|
| `entailment_score` | claim 是否被 evidence 支撑 |
| `rerank_score` | 检索精排分 |
| `exact_match_score` | 实体、数字、日期、专有名词匹配情况 |
| `anchor_quality_score` | bbox > structural anchor > page only |
| `freshness_score` | 是否来自最新 parse_job 和未删除文件 |

默认阈值：

| 场景 | 阈值 |
|---|---:|
| 普通事实 | `citation_score >= 0.55` |
| 数值/日期/金额 | `citation_score >= 0.70` 且 exact match 必须通过 |
| 比较结论 | 每个被比较对象至少 1 条 citation |
| 总结型回答 | 每个主题段至少 1 条 citation |

## 7. 去重与合并

### 7.1 Canonical Key

引用去重不应按 `quote` 去重，而应按原文锚点去重：

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

其中 bbox 坐标按页面尺寸归一化后保留 3 位小数，避免同一位置因浮点误差产生多个引用。

### 7.2 合并规则

| 场景 | 处理 |
|---|---|
| 同一 anchor 被多个 claim 使用 | 复用同一个 citation index |
| 相邻 block 在同一页且距离小于阈值 | 合并为一个 citation，quote 展示连续摘要 |
| 表格多个单元格在同一区域 | 合并为 `table_cell_range` |
| chunk overlap 命中同一段原文 | 删除 overlap 产生的重复引用 |
| 同一文档同一页多个相距很远位置 | 保留多条 citation |
| 不同文档内容完全相同 | 不合并，保留不同来源 |

### 7.3 展示数量控制

- 默认每条答案最多展示 6 条 citation。
- 每个 claim 最多展示 2 条 citation。
- 如果一个 claim 被多个相邻 anchor 覆盖，优先合并为 1 条。
- 多余 citation 不丢弃，可放入 `supporting_citations`，默认折叠。

## 8. API 输出契约

现有 `CitationOutput` 需要从只含 `quote/page_range` 扩展为带定位锚点：

```json
{
  "index": 1,
  "doc_id": "uuid",
  "chunk_id": "uuid",
  "doc_title": "Amazon Bedrock AgentCore FCD.pdf",
  "source_status": "available",
  "page_range": [1],
  "quote": "Python/TypeScript/JS 沙箱代码执行，让 Agent 动态执行代码安全无忧",
  "score": 0.86,
  "anchor": {
    "anchor_id": "uuid",
    "parse_job_id": "uuid",
    "format": "pdf",
    "kind": "text_span",
    "page": 1,
    "slide": null,
    "bbox": { "x0": 84, "y0": 320, "x1": 515, "y1": 348, "unit": "pt", "rotation": 0 },
    "block_id": "uuid",
    "table_id": null,
    "cell_range": null,
    "char_range": { "start": 0, "end": 54 },
    "location_status": "exact"
  },
  "claim_refs": [
    {
      "claim_id": "claim_1",
      "answer_char_range": { "start": 4, "end": 42 }
    }
  ]
}
```

### 8.1 location_status

| 值 | 含义 | 前端行为 |
|---|---|---|
| `exact` | 有精确 bbox 或结构节点 | File View 跳转并高亮 |
| `structural_only` | 有段落/表格/shape 节点，无视觉 bbox | File View 跳转节点并框选整块 |
| `page_only` | 只有页码 | File View 跳页，显示“只能定位到页” |
| `slide_only` | 只有 slide | File View 跳 slide，显示“只能定位到页” |
| `unavailable` | 原文删除、无权限或解析版本失效 | 不打开 File View，展示不可用状态 |

## 9. 前端 File View 预览契约

右侧预览不再使用解析文本拼接组件。点击 citation 后：

```text
CitationCard click
  -> set active citation
  -> FileView.open({
       docId,
       fileName,
       storageUrl or previewUrl,
       format,
       initialLocation: anchor,
       highlights: [anchor]
     })
```

File View 必须负责：

- 打开原始文件或由原始文件转换出的等价预览，不显示 chunk 文本。
- 根据 `format` 选择 PDF viewer、Office preview、PPT slide viewer 或 text viewer。
- 跳转到 `page` / `slide` / `block`。
- 用 `bbox`、shape、cell range 或 char range 高亮命中位置。
- 高亮失败时返回错误状态，不在前端自行搜索 quote。

### 9.1 右侧栏展示规则

- 标题显示文件名和当前页/slide。
- 引用卡片中的 `[n]` 与右侧高亮一一对应。
- 多条 citation 指向同一文件时，File View 不重新加载文件，只更新 active highlight。
- 高亮区域必须在首屏可见；打开后自动滚动到高亮中心。
- 删除或无权限文档显示不可用说明，不展示过期解析文本。

## 10. 数据库建议

新增表或等价 JSONB 存储 `document_source_anchors`：

```sql
CREATE TABLE document_source_anchors (
  anchor_id UUID PRIMARY KEY,
  doc_id UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  parse_job_id UUID NOT NULL REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
  format TEXT NOT NULL,
  kind TEXT NOT NULL,
  page INT,
  slide INT,
  block_id UUID,
  table_id UUID,
  cell_range JSONB,
  char_range JSONB,
  bbox JSONB,
  source_ref JSONB NOT NULL DEFAULT '{}',
  text TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_source_anchors_doc_parse
  ON document_source_anchors(doc_id, parse_job_id);

CREATE INDEX idx_source_anchors_block
  ON document_source_anchors(block_id);
```

chunk 侧新增：

- `anchor_ids UUID[]`：chunk 覆盖的原文锚点。
- `primary_anchor_id UUID`：默认引用锚点。
- `metadata.overlap_anchor_ids`：overlap 区域单独标记，去重时降低优先级。

conversation citation 侧新增：

- `anchor JSONB NOT NULL`：保存回答时使用的定位快照。
- `claim_refs JSONB NOT NULL DEFAULT '[]'`。
- `location_status TEXT NOT NULL`。

保存 anchor 快照是必要的：即使文档之后重新解析，历史回答仍能知道当时引用的解析版本；若该版本不可用，再显示不可用状态。

## 11. 后端模块划分

建议按职责拆分：

| 模块 | 职责 |
|---|---|
| `document/source_anchor` | 解析阶段生成和保存原文锚点 |
| `rag/evidence` | 检索结果携带 anchor_refs |
| `agent/claim_extractor` | 将答案拆为 claim，可先用规则，后续接 LLM |
| `agent/citation_resolver` | 引用筛选、校验、去重、排序 |
| `agent/citation_verifier` | 数字/日期/实体/权限/版本校验 |
| `api/file_preview` | 为 File View 提供原文件或转换预览 URL |

`llm/generator` 不应直接把 Top-K evidence 全部转 citation。它只负责生成答案；citation 应由 `citation_resolver` 根据实际答案和 evidence 生成。

## 12. 回答生成 Prompt 约束

Prompt 中可以继续要求模型输出 `[1]`、`[2]`，但这些编号只是“候选 evidence id”，不是最终引用。

后处理必须校验：

- 模型输出的 `[n]` 是否存在于 evidence。
- `[n]` 对应 evidence 是否真的支撑附近 claim。
- 未被模型标注但明显使用了 evidence 的 claim，Resolver 可以自动补 citation。
- 模型标注错误时以后端 Resolver 为准，必要时重写或删除该 citation 标记。

## 13. 降级策略

| 问题 | 降级 |
|---|---|
| 原文件存在但 File View 预览未生成 | 返回 `structural_only`，右侧显示结构化块高亮 |
| 只有页码没有 bbox | 返回 `page_only`，跳页并提示只能定位到页 |
| 文档已删除 | citation 保留，`source_status = deleted`，不可打开 |
| 文档无权限 | 不返回 quote，显示“无权限查看来源” |
| parse_job 失效 | 尝试用最新 parse_job 通过 block/table/source_ref 迁移 anchor；失败则 `unavailable` |
| anchor 文本与原文件校验不一致 | 不做精确高亮，记录 `anchor_mismatch` |

## 14. 验收标准

### 14.1 引用准确性

- 同一段原文被多个 chunk 命中时，答案只展示 1 条 citation。
- 每条 citation 都能追溯到 `doc_id + parse_job_id + anchor_id`。
- 数字、日期、金额类答案的 citation 原文必须包含对应值。
- 无证据 claim 不允许挂引用。

### 14.2 位置准确性

- PDF：点击 citation 后打开原 PDF 对应页，高亮 bbox 覆盖命中文本，允许误差不超过 6pt。
- Word：点击 citation 后打开 Word 原文预览，定位到对应段落/表格；有转换布局时高亮区域覆盖对应文本。
- PPT：点击 citation 后打开对应 slide，并高亮文本框、表格单元格或备注区域。
- Markdown/TXT：点击 citation 后滚动到原文件字符范围，高亮准确文本。

### 14.3 预览体验

- 右侧预览不得显示 chunk 拼接文本作为主视图。
- File View 高亮失败必须显式显示定位状态，不允许静默展示错误片段。
- 切换 citation 时，右侧高亮同步更新。
- 引用卡片的页码/slide 与 File View 当前页一致。

## 15. 与现有实现的差距

| 当前实现 | 目标实现 |
|---|---|
| `CitationOutput.quote = chunk.content` | `quote = selected anchor 摘要` |
| citation 来自 Top-K evidence 全量映射 | citation 来自 claim-resolved evidence |
| 前端 `indexOf(quote)` 高亮 | File View 使用 `anchor` 高亮 |
| 只有 `page_range` | 有 `anchor_id + bbox / structure / char_range` |
| 重复 chunk 重复展示 | canonical anchor 去重 |
| 右侧展示解析文本 | 右侧展示原始文件视图 |

## 16. 推荐实施顺序

1. 扩展解析输出：为 PDF / DOCX / PPTX / MD / TXT 生成 `SourceAnchor`。
2. 扩展 chunk：保存 `anchor_ids` 和 `primary_anchor_id`。
3. 扩展检索返回：`RetrievedChunk` 携带 anchor refs。
4. 新增 `CitationResolver`：从答案 claim 和 evidence 生成 citation，完成去重。
5. 扩展 API/SSE citation contract：返回 `anchor`、`location_status`、`claim_refs`。
6. 替换右侧预览：接入 File View，不再使用解析文本 `indexOf`。
7. 增加验收用例：PDF bbox、Word 段落、PPT shape、表格 cell、chunk overlap 去重。

## 17. 相关文档

- [解析框架与流程](../1-document-parsing/parser-framework.md)
- [文档解析](../1-document-parsing/document-parsing.md)
- [Chunk 输出数据形态](../3-chunking/chunk-output.md)
- [切片策略](../3-chunking/chunking.md)
- [混合检索](../7-hybrid-search/hybrid-search.md)
- [答案生成](./answer-generation.md)

# 工业落地注意事项

文档解析在 Demo 阶段通常只验证“能不能抽出文本”。真正进入企业生产环境后，核心问题会变成：是否安全、稳定、可追溯、可重跑、可观测，以及在坏文档、大文档、脏格式和版本迁移下是否还能保持系统可用。

## 生产目标

| 目标 | 要求 |
|---|---|
| 安全 | 上传文件不能影响主服务、不能越权读写、不能执行嵌入内容 |
| 稳定 | 单个坏文档不能拖垮 worker 或队列 |
| 可追溯 | 任意 chunk 能回到原文件、页码、表格、解析版本 |
| 可重跑 | parser 升级、清洗策略变化、embedding 模型变化后可批量重建 |
| 可观测 | 能定位慢任务、失败原因、低质量解析和异常文件类型 |
| 可扩展 | 支持后续 OCR、图片 caption、附件解析、增量索引 |

## 安全隔离

文档解析必须当成不可信输入处理。文件可能包含恶意压缩包、异常 PDF object、超深 XML、超大图片或伪装扩展名。

落地要求：

- 解析 worker 和 API 服务进程隔离，上传请求不直接解析文件。
- 文件大小、页数、解压后体积、XML 节点深度都要有限制。
- 禁止执行文档内宏、脚本、外链资源和嵌入对象。
- DOCX / PPTX 解压要防 zip bomb：检查压缩比、entry 数量、单 entry 大小、总解压大小。
- PDF 解析设置 CPU 和内存上限，避免异常 object 造成死循环或 OOM。
- 原文件访问必须走 tenant / kb 权限校验，不允许通过 storage key 直接下载。

建议限制：

| 项目 | 默认限制 |
|---|---|
| 单文件大小 | 100 MB |
| DOCX / PPTX 解压后总大小 | 500 MB |
| ZIP entry 数量 | 10000 |
| PDF 页数 | 1000 页 |
| 单文档解析超时 | 10 分钟 |
| 单页最大文本对象 | 50000 |

超过限制时进入 `parse_failed` 或 `parse_low_confidence`，错误码必须可见。

## 异步任务与队列

解析是重 CPU / IO 任务，不应阻塞 API。

推荐队列：

```text
document.uploaded
  -> document.parse.requested
  -> document.parse.completed
  -> document.clean.requested
  -> document.chunk.requested
  -> document.embedding.requested
  -> document.index.completed
```

任务消息至少包含：

```json
{
  "job_id": "uuid",
  "doc_id": "uuid",
  "tenant_id": "uuid",
  "kb_id": "uuid",
  "file_sha256": "sha256",
  "parse_identity": "sha256(file + parser + config)",
  "attempt": 1,
  "requested_by": "uuid"
}
```

队列处理要求：

- 按 `parse_identity` 做幂等，重复消息不会重复写入有效版本。
- worker crash 后任务可重投。
- 重试使用指数退避，默认最多 3 次。
- 明确区分可重试错误和不可重试错误。
- 大文档可以拆成页级或章节级子任务，但最终必须汇总为一个 parse job。

错误分类：

| 类型 | 示例 | 是否重试 |
|---|---|---|
| 临时错误 | 对象存储短暂不可用、DB 超时 | 是 |
| 资源错误 | worker OOM、解析超时 | 限次重试，降低并发 |
| 文件错误 | 文件损坏、加密 PDF、类型伪装 | 否 |
| 质量错误 | 扫描 PDF、乱码过多、结构低置信度 | 否，进入人工或 OCR |

## 大文件与流式处理

生产系统一定会遇到几百页 PDF、超长合同、导出的 PPT 和包含大表格的 Word。

落地原则：

- 原文件流式上传，避免 API 一次性读入内存。
- parser 尽量按页、slide、XML block 流式产出。
- `document_blocks` 分批写入，每批 500 到 2000 条。
- 大表格单元格分批写入，避免一个事务过大。
- chunk 和 embedding 支持断点续跑。

长任务进度应拆成可展示状态：

```text
uploaded 10%
parsing 30%
quality_checking 45%
cleaning 55%
chunking 70%
embedding 90%
indexed 100%
```

进度不是精确百分比，但必须让管理员知道卡在哪个阶段。

## 版本治理

解析结果和 chunk 必须带版本。没有版本治理，上线后 parser 一升级就会出现“同一文档答案变了但无法解释”的问题。

需要记录：

- `parser_version`
- `parser_config`
- `schema_version`
- `cleaner_version`
- `chunker_version`
- `embedding_model`
- `index_version`

推荐版本链路：

```text
file_sha256
  -> parse_identity
  -> parse_job_id
  -> cleaning_job_id
  -> chunk_version
  -> embedding_version
  -> es_index_version
```

管理员重建索引时可选择：

| 重建类型 | 触发原因 |
|---|---|
| 只重建 ES | ES mapping 或索引损坏 |
| 重跑 embedding | embedding 模型变更 |
| 重跑 chunk | 切割参数变更 |
| 重跑 cleaning | 清洗策略变更 |
| 全量重解析 | parser 版本或表格解析逻辑变更 |

## 可观测性

解析 worker 必须输出结构化日志和指标。

关键日志字段：

```json
{
  "event": "document_parse_completed",
  "doc_id": "uuid",
  "parse_job_id": "uuid",
  "file_type": "pdf",
  "file_size": 3489120,
  "page_count": 42,
  "block_count": 512,
  "table_count": 8,
  "char_count": 90321,
  "quality_score": 0.91,
  "duration_ms": 18342,
  "warnings": ["pdf_header_footer_detected"]
}
```

核心指标：

| 指标 | 用途 |
|---|---|
| `parse_success_rate` | 解析成功率 |
| `parse_low_confidence_rate` | 低质量文档比例 |
| `parse_duration_p50/p95/p99` | worker 性能 |
| `parse_queue_lag` | 队列积压 |
| `parse_failure_by_error_code` | 失败原因分布 |
| `table_extraction_success_rate` | 表格解析质量 |
| `avg_blocks_per_doc` | 异常文档检测 |
| `avg_chunks_per_doc` | 切割策略漂移检测 |

告警建议：

- 解析失败率 10 分钟内超过 5%。
- 队列积压超过 worker 正常吞吐 30 分钟。
- P95 解析耗时超过基线 2 倍。
- 某 parser version 低置信度比例明显升高。

## 人工介入与管理后台

不是所有文档都能自动解析好。工业系统需要给管理员明确的处理入口。

管理后台至少展示：

- 文件名、类型、大小、上传人、上传时间。
- 当前解析状态和失败错误码。
- 解析质量分、warning 列表。
- 页数、block 数、表格数、chunk 数。
- 解析预览：原文页码 / slide 与 block 对照。
- 表格预览：Markdown 视图和原始 cell 视图。
- 操作：重试解析、标记低质量可索引、重新解析、删除文档、下载原文件。

低置信度文档不要静默失败。应该允许管理员决定：

| 操作 | 含义 |
|---|---|
| `retry_parse` | 原配置重试 |
| `force_index` | 管理员确认后进入索引 |
| `send_to_ocr` | 进入 OCR 增强队列 |
| `exclude_from_search` | 保留文件但不参与检索 |
| `replace_file` | 上传新版本替换 |

## 多租户与权限

解析结果不是公共缓存，必须继承文档权限。

要求：

- 所有表都带 `tenant_id` 或可通过 `doc_id` 强约束回 tenant。
- 队列消息携带 `tenant_id`，worker 写入时校验 document 属于该 tenant。
- ES 索引必须保存 `tenant_id`、`kb_id`，查询时强制 filter。
- 原文件、解析 JSON、CSV 派生物路径中包含 tenant / kb / doc。
- 删除知识库或文档时，级联删除 PG 数据、对象存储文件和 ES 索引。

不要跨租户按 `file_sha256` 复用解析内容。即使文件相同，也可能包含不同权限语义和审计要求。最多可以复用内部计算缓存，但落库必须隔离。

## 数据保留与清理

长期运行后，解析快照、旧版本 chunk、CSV 派生物会快速膨胀。

建议策略：

- 原文件默认永久保留，随文档删除而删除。
- 成功 parse job 默认保留最近 2 个版本。
- 失败 job 保留 30 天，用于排查。
- 大型 `parsed_json` 可转对象存储，PG 只保留摘要。
- ES 旧 index 在新版本切流成功后异步删除。
- 删除文档必须记录审计日志，包括删除人、时间、影响 chunk 数。

## 兼容性与灰度

parser 版本升级不能一次性影响全量文档。

推荐流程：

1. 准备 parser 新版本。
2. 对样本文档集重跑解析。
3. 比较 block 数、字符数、表格数、chunk 数和质量分。
4. 差异在阈值内后灰度到新上传文档。
5. 后台批量重解析旧文档。
6. 新旧索引并存，验证检索效果后切流。

样本文档集应覆盖：

- 普通 Word、带复杂表格 Word、带目录 Word。
- 普通 PPT、多栏 PPT、带备注 PPT、含大量图表 PPT。
- 文本 PDF、双栏 PDF、扫描 PDF、带表格 PDF、加密 PDF。
- 中英混合、纯中文、数字和金额密集文档。

## 成本与容量规划

解析系统的成本主要来自 CPU、存储和后续 embedding。

需要预估：

```text
日上传文档数
平均文件大小
平均页数
平均 chunk 数
embedding 模型吞吐
ES 索引膨胀倍率
解析 JSON 和表格 cell 存储量
```

经验估算：

| 数据 | 粗略倍率 |
|---|---|
| 原文件 | 1x |
| parsed JSON | 0.2x 到 2x，复杂 PDF 和表格更高 |
| chunks 文本 | 0.1x 到 0.5x |
| embedding | chunk 数 * 维度 * 4 bytes |
| ES 索引 | chunks 文本 + embedding 的 1.2x 到 2x |

超大表格和长 PDF 应单独监控，否则会让 PG 和 ES 容量增长异常。

## OCR 与非文本内容

第一版可以不默认做 OCR，但接口和状态要预留。

建议预留：

- `image_placeholder` block。
- `ocr_status`。
- `ocr_text` 或 OCR block。
- 图片 bbox 和页码。
- `caption` 字段，用于后续图表说明生成。

扫描 PDF 的处理建议：

```text
PDF parser 检测无文本层
  -> parse_low_confidence(scanned_pdf_no_text_layer)
  -> 管理员或配置决定是否进入 OCR
  -> OCR 结果作为新的 parse version
```

OCR 结果必须标记置信度，不能和原生文本层混为一谈。

## 上线验收清单

- [ ] 上传接口不阻塞解析。
- [ ] DOCX / PPTX 有 zip bomb 防护。
- [ ] PDF 有页数、耗时、内存限制。
- [ ] 解析任务可重试、幂等、可恢复。
- [ ] 每个 chunk 可追溯到 block、table、页码或 slide。
- [ ] 表格完整保存为 table + cell，不只保存 Markdown。
- [ ] 低置信度解析不会默认进入索引。
- [ ] 管理后台能看到失败原因和质量分。
- [ ] parser version、config、schema version 全部入库。
- [ ] 删除文档会清理 PG、对象存储、ES。
- [ ] 指标和告警覆盖成功率、耗时、队列积压、失败原因。
- [ ] 有样本文档集用于 parser 升级回归测试。

## 第一版落地建议

第一版不要追求所有格式 100% 完美。建议按风险收敛：

1. DOCX / PPTX 使用 OpenXML 强结构解析，优先保证段落、标题、表格准确。
2. PDF 先支持文本层 PDF，扫描 PDF 标记低置信度并预留 OCR。
3. 表格先完整保存 Word / PPT 强结构表格，PDF 表格低置信度时降级为普通文本。
4. 先做 PostgreSQL 权威存储 + ES 可重建索引。
5. 管理后台优先展示状态、错误、质量分、chunk 预览和表格预览。

这能保证系统第一版可上线、可解释、可演进，而不是在解析边界问题上无限消耗。

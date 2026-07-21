# DocuMind 文档与代码实现差距总账

本文档对齐 `docs/` 下设计文档与当前代码、当前服务器部署效果之间的差距。结论基于 2026-06-28 当前工作区与 `ssh documind` 服务器只读检查。

## 0. 当前部署证据

已验证的服务器状态：

| 项 | 当前证据 |
|---|---|
| 对外入口 | `http://123.57.255.204:8089/documind/` |
| 当前 release | `/opt/documind/releases/20260628-015027` |
| 健康检查 | `/api/health` 返回 `ok=true`、`mode=release`、`environment=production` |
| 依赖检查 | PostgreSQL、Redis、RabbitMQ、Elasticsearch、MinIO、真实 LLM、Embedding 全部 `ok=true` |
| 模型 | LLM `qwen-max`，Embedding `text-embedding-v3` |
| 文档状态 | `indexed=346`，`excluded_from_search=1`，`parse_failed=1`，`parse_low_confidence=9`，`parsed=2` |
| 真实账号 | `Anner` 登录为 `super_admin`，`admin@documind.local` 登录为 `enterprise_admin`，`user@documind.local` 登录为 `user` |
| 当前租户 | `AcmeCorp` / `acme` / `active` |
| 当前知识库数据 | 产品文档库 110 文档，销售资料库 249 文档，人力资源库 0 文档 |
| 当前切片与锚点 | `documents=359`，`chunks=2982`，`document_source_anchors=1195` |

说明：RabbitMQ 依赖健康检查已通过，但当前解析/OCR/embedding 的业务任务仍主要由 Rust 进程内异步任务驱动。应用启动时已能把上次进程中断留下的 in-flight 文档任务标记为明确失败/低置信并允许管理员重试，但尚未形成文档中描述的 RabbitMQ 队列编排、自动重投递和死信链路。

## 1. 总体架构

| 模块 | 文档目标 | 当前代码/部署 | 实现差距 |
|---|---|---|---|
| 单二进制服务 | Rust API + Agent Kernel + Next.js 静态前端统一服务 | `apps/api-rs/src/lib.rs` 同时挂载 API 与 `/documind` 静态前端，服务器 8089 已运行 | 已对齐 |
| 运行依赖 | PostgreSQL、Redis、RabbitMQ、Elasticsearch、MinIO、LLM、Embedding 都可检查 | `/api/health` 已逐项检查并返回详情 | 已对齐基础检查；缺少依赖失败时的启动前阻断/引导页 |
| 异步任务 | RabbitMQ 承载解析、清洗、切片、embedding、重试、死信 | `RABBITMQ_URL` 和 health 存在，`spawn_parse_job` 仍为进程内 `tokio::spawn`；`recover_interrupted_document_jobs` 在启动时标记上次中断的 pending/running/ocr_queued 任务 | worker 分离、RabbitMQ 投递/消费、自动重投递、DLX 未实现 |
| 文档智能 Worker | 可选 Python Worker / Docling / PyMuPDF / OCR | 已有 Rust 内置 OCR fallback，未见独立 worker 目录或 JSON contract worker | 扫描件 OCR 可用，但 Python Worker、layout/table 高质量解析未实现 |
| 可观测性 | OpenTelemetry、metrics、trace、告警 | 有结构化日志、问答 trace、系统页只读统计；新增 `/api/metrics` Prometheus 文本指标，暴露依赖 up/down、文档状态、chunk、parse job、会话、消息、反馈汇总 | 缺少 OTel trace、告警规则、队列积压和延迟直方图等完整可观测闭环 |

## 2. 认证、租户与权限

| 模块 | 文档目标 | 当前代码/部署 | 实现差距 |
|---|---|---|---|
| 本地登录 | DocuMind 独立认证、JWT、session | `apps/api-rs/src/auth.rs` 支持 DB 用户 bcrypt 校验、JWT、Redis session | 已对齐核心认证 |
| Portal SSO | 可选 `AUTH_LOGIN_MODE=portal`，门户 token 换本地登录态 | `apps/api-rs/src/api/auth.rs` 有 portal callback 路由和兼容接口 | 需要继续验证门户真实回调、自动建号和角色映射完整性 |
| RBAC | 角色权限与知识库 ACL | `derive_permissions`、`require_permission`、`knowledge_base_acl`、前端权限页已接 API | 已具备在线授权/撤销；细粒度审计与多租户配额未完整实现 |
| 审计 | 权限、登录、文档操作审计可查 | `record_audit_event` 已写 `audit_log`，系统/管理日志接口可查部分事件 | 审计事件覆盖面、筛选、导出、保留策略未达到生产完整态 |
| 超级管理员 | `Anner` 作为超级管理员可登录并看到全部全局后台能力 | 远端 `/api/v1/auth/login` 验证 `Anner` 返回 `roles=["super_admin"]`、26 个权限、3 个可访问知识库；可访问 `/api/system/users`、`/api/system/models` | 已对齐当前要求；后续需把验收脚本固定为发布门禁 |
| 租户管理员 | 租户管理员可管理本租户知识库、文档解析、成员、ACL 和租户级配置，不可访问全局模型配置 | `admin@documind.local` 当前为 `enterprise_admin`，可访问 `/api/admin/knowledge-bases`，访问 `/api/system/models` 返回 403 | 角色名仍需从兼容态 `enterprise_admin` 收敛到目标态 `tenant_admin`；前端侧栏还需统一 |
| 普通用户 | 普通用户不可见后台，只能访问授权知识库和对话 | `user@documind.local` 可登录，访问 `/api/admin/knowledge-bases` 与 `/api/system/models` 均返回 403 | 已对齐核心 API 边界；仍需补浏览器 UI 导航验收 |
| 邀请机制 | 租户管理员可邀请成员、分配角色和知识库授权，邀请链接可接受/撤销/重发/过期 | 数据库只有 `tenant_member.invited_by/invited_at`，无 invitation token 表；当前邀请字段均为空 | 未完成，需要新增 `tenant_invitation` 表、token hash、接受流程、审计和 E2E 验收 |

## 3. 知识库与文档管理

| 模块 | 文档目标 | 当前代码/部署 | 实现差距 |
|---|---|---|---|
| 知识库 CRUD | 管理端创建、更新、删除知识库 | `apps/api-rs/src/api/admin.rs` 已实现 `/api/admin/knowledge-bases` CRUD | 已对齐核心管理 |
| 文档上传 | 上传、存储、解析、状态追踪 | `apps/api-rs/src/api/documents.rs` 实现上传、详情、删除、移动、重试、批量重试 | 已对齐核心闭环 |
| 文档状态 | parsing/parsed/indexed/failed 等状态可解释 | 服务器仍有 `parse_failed`、`parse_low_confidence`、`parsed` 残留；上次遗留 `ocr_pending` 已由启动恢复转为可解释低置信状态 | 需要清理样本数据或在管理页明确这些状态的处置建议 |
| 文档详情 | blocks、chunks、tables、preview 可查看 | 管理详情和抽屉已有 parsed text preview、blocks、tables | 原文预览与解析文本预览共存；详情页不是完整 FileView |
| OCR 状态元数据 | OCR 队列/运行/失败状态不被普通解析覆盖 | `parse_running_metadata` / `parse_failed_metadata` 仅在 OCR 任务写入 `ocr_status` | 已修复非 OCR 重解析把 `ocr_status` 覆盖为 JSON null 的风险；队列化仍待实现 |
| 中断任务恢复 | 进程重启后解析/OCR/embedding 不应永久卡在处理中 | `recover_interrupted_document_jobs` 启动时把 `uploaded/parsing/chunked/embedding/ocr_pending` 且 job 为 `pending/running/ocr_queued` 的任务改为可解释失败态 | 已避免永久卡死；仍需 RabbitMQ worker 级自动重试和死信 |
| 租户数据隔离 | 知识库、文档、解析、chunk、embedding、anchor 均按租户隔离 | 远端 `documents/chunks/chunk_embeddings/document_source_anchors` scope mismatch 核验均为 0；storage_key 使用 `tenants/{tenant_id}/knowledge-bases/{kb_id}/documents/{doc_id}/...` | 当前数据干净；仍需补更多复合约束和跨租户权限 E2E |

## 4. 文档解析

| 模块 | 文档目标 | 当前代码/部署 | 实现差距 |
|---|---|---|---|
| 文件类型识别 | MIME、扩展名、文件头/zip 结构三方校验 | `detect_file_type` 已校验 PDF 头、Office zip 结构、文本格式 | 已对齐 |
| DOCX 解析 | paragraph/table/list/heading/header/footer/style/numbering | 已解析 `word/document.xml` 段落、表格、标题样式、编号基础信息 | header/footer、footnote、textbox、复杂列表编号、样式继承仍不完整 |
| PPTX 解析 | slide 顺序、shape、table、notes、layout/master 噪声 | 已解析 slide XML 文本段落和表格，保留 slide_index | shape id、shape bbox、notes、layout/master 噪声过滤、读取顺序恢复未完整实现 |
| PDF 解析 | text run、bbox、reading order、table、扫描件 fallback | 纯文本层用 `pdf-extract`，段落 anchor 使用页面垂直分带近似 bbox；扫描件可手动送 OCR | PDF bbox 不是 text-run 精确坐标；表格检测、阅读顺序恢复、自动 OCR 投递未完整实现 |
| Markdown/TXT | char offset、heading、table、代码块 | 已生成 char_range anchor；清洗切块可进入检索和 FileView 高亮 | Markdown 专项语法保真、表格结构化和代码块原子切分仍有限 |
| SourceAnchor | 解析期生成统一 anchor | `models/source_anchor.rs`、`document_source_anchors`、chunk primary anchor、ES anchor 字段已落地 | DOCX/PPTX 视觉 bbox、cell range 到预览坐标映射不足 |

## 5. 文本清洗

| 模块 | 文档目标 | 当前代码/部署 | 实现差距 |
|---|---|---|---|
| 通用清洗 | 空白、页眉页脚、噪声、清洗操作记录、offset mapping | `apps/api-rs/src/document/cleaning.rs` 已有统一 clean_blocks 和版本号 | offset mapping 未完整保存；格式特化清洗规则较简化 |
| PDF 清洗 | 页眉页脚、断行、页码、脚注 | 有基础段落和文本标准化 | 复杂版面、脚注、跨页段落和页眉页脚识别不完整 |
| Word/PPT 清洗 | 模板噪声、列表层级、标题规则 | 已保留 heading_path、list_item 基础类型 | 模板噪声、样式层级、notes/comment 清洗未完整实现 |

## 6. Chunking

| 模块 | 文档目标 | 当前代码/部署 | 实现差距 |
|---|---|---|---|
| 结构化切片 | heading/list/table aware，多粒度 chunk | `document/chunking.rs` 已有目标/最小/最大长度、PDF 防碎片、短尾合并和严格长文本切分 | atomic/parent/summary 多粒度体系未完整实现 |
| 表格切片 | 小表整体、中表按行组、大表摘要 | 表格按行数与 token 双阈值拆分并重复表头，超长单行有硬切保护 | 大表摘要、列语义、cell-level 精确 anchor 仍不足 |
| overlap | 按结构边界控制 overlap | overlap 受标题、slide、表格边界约束，并预留在最大 token 预算内 | 可继续用离线评估校准不同文档类型的 overlap 参数 |

## 7. Embedding 与索引

| 模块 | 文档目标 | 当前代码/部署 | 实现差距 |
|---|---|---|---|
| Embedding | OpenAI-compatible embedding 批量写入 | `vector_jobs` 持久化编排；按标题/章节/正文生成 input；SHA-256 复用；`REAL[]` 保存权威向量 | 已对齐核心向量化；模型质量仍需持续评估 |
| ES 索引 | dense vector + BM25 + anchor 字段 | 版本化物理索引、`chunks_search` 原子别名切换、CJK BM25、HNSW、ID 级对账和自动重建均已实现 | HNSW 与召回参数需要基于 golden set 持续调优 |
| 失败重试 | 队列失败重试与状态恢复 | RabbitMQ pending/DLX、PostgreSQL 补偿轮询、租约恢复、指数退避、终态失败和死信均已实现 | Worker 当前与 API 同二进制，后续可按容量独立部署 |

## 8. 查询改写、检索与重排

| 模块 | 文档目标 | 当前代码/部署 | 实现差距 |
|---|---|---|---|
| Query Rewrite | 指代消解、HyDE、multi-query、术语规范化 | `agent/rewriter.rs` 为规则指代消解和关键词拆分 | HyDE、多查询扩展、企业术语表和 LLM 改写未完整实现 |
| Retrieval Planner | 按模式规划检索策略 | `agent/planner.rs`、`kernel.rs` 有 single/multi 规划接口 | 复杂模式的检索策略差异较少 |
| Hybrid Search | dense + BM25 + RRF + metadata filter | `rag/retriever.rs` 已对 ES 执行 dense kNN、BM25，并融合 | 同义词、短语邻近、复杂 metadata prefilter、查询级参数调优未完整实现 |
| Reranking | HTTP reranker 或本地/mock 兜底 | `rag/reranker.rs` 支持 HTTP reranker；未配置时使用 lexical mock | 真实 reranker 未必已配置；阈值校准和评估闭环仍需补齐 |

## 9. 答案生成与引用

| 模块 | 文档目标 | 当前代码/部署 | 实现差距 |
|---|---|---|---|
| Agent Kernel | rewrite -> plan -> retrieve -> rerank -> assemble -> generate -> verify | `agent/kernel.rs` 已实现强类型流水线和进度事件 | 已对齐核心链路 |
| Prompt 架构 | persona/guardrail/mode/task 分层 | `agent/prompt.rs` 已有分层 prompt registry | 租户级 prompt 配置和版本管理后台未完整实现 |
| Claim Verifier | 答案 claim 校验、无依据拒答 | `agent/verifier.rs` 有基础 verifier | Claim extractor、数值/日期/金额强校验仍不完整 |
| Citation Resolver | claim-resolved citation、去重、anchor 优先 | `agent/citation_resolver.rs` 已返回 anchor、location_status、char_range/bbox，并非前端 quote 搜索 | 引用仍主要基于候选 evidence；claim 粒度选择、实体数值强校验、复杂合并待加强 |
| Citation Snapshot | 历史引用固定到当时 parse_job | migration `0013_citation_snapshots` 已存在 | 需要继续核验所有历史回看路径都使用 snapshot，不被最新解析覆盖 |

## 10. FileView 与前端预览

| 模块 | 文档目标 | 当前代码/部署 | 实现差距 |
|---|---|---|---|
| 引用点击 | 前端只消费 anchor，不做 quote/indexOf 定位 | `document-preview.tsx` 传递 bbox/char_range；PDF/TXT viewer 按 anchor 渲染 | 已对齐主原则 |
| PDF Viewer | PDF.js + bbox highlight | `pdf-viewer.tsx` 使用后端 page pdf/content 和 bbox overlay | PDF bbox 受后端近似 anchor 限制；多 quad/text-run 未实现 |
| TXT/MD Viewer | char_range highlight | `text-viewer.tsx` 支持 charRange 高亮 | Markdown rich view、代码块/表格视觉定位未完整实现 |
| Office Preview | DOCX/PPTX 转 PDF 预览 | 后端 LibreOffice 转 PDF，manifest/content/page PDF 可用 | 缺少 DOCX OpenXML/PPTX shape 到转换 PDF bbox 的精确映射 |
| Preview URL | 短期签名 URL，不暴露对象存储 | 已新增 `/api/files/:doc_id/preview-url`，返回带 `preview_token` 的短期 manifest/content/page PDF API 代理 URL；既不暴露 MinIO，也不要求预览端持有长期对象地址 | 当前是 DocuMind API 代理签名，不是 S3 presigned URL；如需直连对象存储可后续增强 |
| 缓存 | manifest/cache/大 PDF 懒加载 | 已有本地前端 blob cache、后端 page pdf/office pdf 文件缓存 | Redis manifest 缓存、大文件缩略图/懒加载策略未完整实现 |

## 11. 会话、历史、反馈与缓存

| 模块 | 文档目标 | 当前代码/部署 | 实现差距 |
|---|---|---|---|
| 会话 API | 创建、列表、消息、SSE、取消、重试 | `api/conversations.rs` 路由完整；服务器冒烟通过 | 已对齐核心会话 |
| Trace | retrieval/rerank/generation trace 可回看 | `repositories/sqlx.rs` 写 message trace，前端有 trace 展示 | Trace 还不是 OpenTelemetry 全链路 |
| Feedback | 用户反馈进入质量回流 | `models/feedback.rs`、feedback API 已存在 | 反馈驱动评估、缓存失效和训练数据回流未完整实现 |
| Answer Cache | Redis 热点问答缓存 | `repositories/cache.rs` 有 Redis/InMemory cache | 需要确认生产链路是否启用、命中率指标和失效策略 |

## 12. 系统后台与运维

| 模块 | 文档目标 | 当前代码/部署 | 实现差距 |
|---|---|---|---|
| Admin Overview | 租户级概览、文档、任务、告警 | 管理 overview 接 DB 统计，alerts 为空数组 | 告警规则未实现 |
| System Overview | 系统租户、用户、模型、任务、审计、索引 | `api/system.rs` 大多接 DB 或 runtime config；`/api/metrics` 可供 Prometheus 类系统抓取基础汇总指标 | 部分字段仍是 `not_measured`、只读、fallback 数据；不应承诺完整运维大屏 |
| Runtime Config | 配置页可看切分/embedding/search/llm | `/api/admin/runtime-config` 返回 `read_only=true` 的运行配置 | 在线持久化配置未实现 |
| Vector Index Ops | 索引管理、重建、迁移 | 已提供索引列表、ID 级 reconcile、持久化 rebuild API、健康检查和指标 | 前端尚未提供更细粒度的版本回滚与参数编辑 |
| 部署 | `make deploy` 到 `ssh documind`，健康检查 | 已稳定部署到 release 目录并通过 `make health` | 回滚演练、灰度策略、发布审计仍需补齐 |
| 后台导航 | 左侧边栏稳定统一，按角色过滤可见菜单 | 当前代码存在 `AdminSidebar`、`SystemSidebar`、`TenantSidebar`、`ChatSidebar` 多套入口；`SystemSidebar` 还内嵌知识库后台快捷组 | 需要按 `docs/frontend/admin-navigation.md` 收敛为统一菜单模型，避免知识库入口在不同页面位置变化 |

## 13. 测试与评估

| 模块 | 文档目标 | 当前代码/部署 | 实现差距 |
|---|---|---|---|
| API 冒烟 | 登录、KB、上传、会话、SSE | `scripts/api-test-conversation.py`、`scripts/api-test-ingest.sh` 已存在；`make release-gate` 已串起核心 API smoke | 仍需接入 CI 或部署流水线自动阻断 |
| Golden Set | 至少 50 条多格式问题 | `tests/golden/documind_core.json` 与 `scripts/eval-golden.py` 已存在 | 当前覆盖已到 50 条，但仍需扩大 Office、OCR、表格、权限样本 |
| 指标 | citation、faithfulness、recall、mode selection | golden 脚本已输出 pass/citation/doc hit/no-answer/mode | 缺少自动趋势记录、失败样例归因和发布阻断阈值 |
| Office/OCR/ops smoke | Office Preview、OCR、FileView anchor、metrics 需要可重复远端验收 | `scripts/api-test-preview-ocr.py` 已固化 DOCX/PPTX `office_pdf` manifest/content/page PDF、短期 `preview_token` URL 匿名访问、OCR chunk/bbox anchor、OCR QA citation anchor；`scripts/browser-test-fileview.sh` 已固化点击 citation 后右侧 FileView 的 canvas、bbox overlay、target/ready page 与精确定位文案断言；`scripts/api-test-metrics.sh` 验证 `/api/metrics` 关键指标；`make release-gate` 统一串行执行这些 smoke | 已覆盖主链路；仍需扩大到移动端、多页 PDF、DOCX/PPTX 引用和跨浏览器截图，并接入 CI/部署流水线 |
| 前端 E2E | 浏览器截图/交互验收 | `scripts/browser-test-fileview.sh` 通过 agent-browser 访问远端 `/documind/chat?c=...`，点击 citation 并保存 `/tmp/documind-fileview-ocr.png` | 仍需纳入固定发布门禁，并补移动端/权限边界 UI E2E |

## 14. 优先补齐顺序

按当前差距，后续应优先处理：

1. **解析/OCR 外部任务编排**：Embedding 已完成持久化任务、RabbitMQ 通知、retry/DLX 和补偿扫描；下一步把 parse/OCR 也迁移到同类可独立扩容的 worker。
2. **Office 精确定位**：建立 DOCX paragraph/table cell、PPTX shape/table cell 到转换 PDF/page preview 的 bbox 映射。
3. **PDF 精确 bbox**：用 text run/word bbox 替代当前段落垂直分带近似坐标。
4. **Claim 级 CitationResolver**：补 claim extractor、数字/日期/实体强校验、引用快照回看核验。
5. **运维可观测性**：在 `/api/metrics` 基础上继续补 OpenTelemetry、告警、队列积压、preview/render p95、LLM/embedding/rerank 延迟。
6. **发布门禁**：`make release-gate` 已串起 API 冒烟、golden smoke、Office/OCR/preview-token smoke、metrics smoke、浏览器 FileView 截图验收；下一步接入 CI/部署流水线，并继续扩展移动端和权限样本。

## 15. 文档修订原则

后续更新 `docs/` 时按以下口径处理：

- 写成“当前已实现”的能力，必须能在代码或 `ssh documind` 上找到直接证据。
- 写成“目标架构”的能力，必须明确标注未完成差距，不放进上线验收范围。
- 引用定位相关文档必须统一为 `SourceAnchor -> CitationResolver -> FileView`，不得恢复到前端 `quote/indexOf` 主定位。
- 运维和后台文档必须区分“只读可看”和“可操作生产能力”。

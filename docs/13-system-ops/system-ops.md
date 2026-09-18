# 系统运维 (System Ops)

系统级运维管理能力，覆盖 Elasticsearch 索引、模型、LLM Provider 配置和可观测性。

当前实现状态：服务器 `/api/health` 检查 PostgreSQL、Redis、RabbitMQ、Elasticsearch、MinIO/object storage、真实 LLM、Embedding、Reranker 和向量一致性；`/api/metrics` 输出 Prometheus 指标。`/api/system/jobs` 只返回数据库中当前 `pending` / `ocr_queued` / `running` 的解析、OCR、向量化和索引重建任务，没有活动任务时返回空数组。`/api/system/models` 会实时请求 LLM、Embedding 和 Reranker 提供商并返回探测延迟与错误。`/api/system/vector-indexes` 会实时核对 PostgreSQL 应有切片与 Elasticsearch 活动物理索引中的实际切片。在线模型切换、OpenTelemetry trace、告警规则和队列死信处理尚未完整落地。

## 核心职责

- ES 索引管理（mapping 更新、重建、HNSW 参数调优、分片策略）
- ES 集群监控（索引速度、查询延迟、内存/磁盘水位）
- LLM Provider 配置（API Key、Endpoint、模型切换）
- Embedding 模型管理（热切换、维度变更时的索引重建）
- 审计日志（操作留痕、问答追溯）
- 系统概览 Dashboard（文档数、切片数、问答量、延迟 P95）

## 远端现状核验（2026-06-28）

基于 `ssh documind`：

- 当前 release 为 `/opt/documind/releases/20260628-015027`，对外端口为 8089。
- `/api/health` 返回 `ok=true`、`mode=release`、`environment=production`。
- 依赖状态：PostgreSQL、Redis、RabbitMQ、Elasticsearch、MinIO/object storage、真实 LLM、Embedding 均为可用。
- `Anner` 以 `super_admin` 登录后可访问 `/api/system/users`、`/api/system/models`、`/api/admin/knowledge-bases`。
- `admin@documind.local` 以 `enterprise_admin` 登录后可访问 `/api/admin/knowledge-bases`，访问 `/api/system/models` 返回 403。
- `user@documind.local` 访问 `/api/admin/knowledge-bases` 和 `/api/system/models` 均返回 403。

## 运维权限边界

- `/system/*` 是超级管理员全局后台，只允许 `super_admin` 访问。
- `/system/models` 展示全局 LLM / Embedding / Reranker 的运行配置和实时探测结果，不回显密钥，只允许 `super_admin` 查看。
- `/system/vector-indexes` 展示活动物理索引、PostgreSQL/Elasticsearch 实时一致性及各租户知识库的索引数据，只允许 `super_admin` 查看和触发已有重建接口。
- `/system/jobs` 展示当前真实的解析、OCR、embedding 和索引重建队列；已完成和失败历史不冒充活动任务，只允许 `super_admin` 查看。
- 租户管理员只能在 `/admin/*` 下操作本租户知识库、文档、解析重试、切割策略、检索参数和租户模型绑定。
- 租户管理员不可查看全局密钥、不可修改全局 Provider、不可跨租户查看队列明细或审计日志。
- 后台左侧边栏必须遵循 [后台导航统一契约](../frontend/admin-navigation.md)：系统全局分组只对 `super_admin` 可见，知识库后台分组对 `super_admin` 和租户管理员可见。

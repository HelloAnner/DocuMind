# 系统运维 (System Ops)

系统级运维管理能力，覆盖 Elasticsearch 索引、模型、LLM Provider 配置和可观测性。

当前实现状态：服务器 `/api/health` 已检查 PostgreSQL、Redis、RabbitMQ、Elasticsearch、MinIO/object storage、真实 LLM 和 embedding；`/api/metrics` 已输出 Prometheus 文本格式的依赖 up/down、文档状态、chunk、parse job、会话、消息、反馈等汇总指标；后台系统页已有只读运行配置、依赖状态、部分数据库统计和审计查询。本文档后续描述的是目标运维能力，其中在线模型切换、索引重建/迁移、OpenTelemetry trace、告警规则和队列死信处理尚未完整落地。

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
- `/system/models` 管理全局 LLM / Embedding / Reranker Provider、base URL、模型名、fallback 顺序、健康状态和密钥尾号，只允许 `super_admin` 查看和修改。
- `/system/vector-indexes` 管理全局索引版本、mapping、重建任务和迁移，只允许 `super_admin` 查看和操作。
- `/system/jobs` 管理全局解析、OCR、embedding、清理任务队列和死信，只允许 `super_admin` 查看和操作。
- 租户管理员只能在 `/admin/*` 下操作本租户知识库、文档、解析重试、切割策略、检索参数和租户模型绑定。
- 租户管理员不可查看全局密钥、不可修改全局 Provider、不可跨租户查看队列明细或审计日志。
- 后台左侧边栏必须遵循 [后台导航统一契约](../frontend/admin-navigation.md)：系统全局分组只对 `super_admin` 可见，知识库后台分组对 `super_admin` 和租户管理员可见。

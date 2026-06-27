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

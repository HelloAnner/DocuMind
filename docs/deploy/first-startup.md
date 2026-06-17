# 首次启动与部署配置

DocuMind 是企业级文档智能问答系统，部署目标是单个 Rust 二进制承载 API、Agent Kernel、任务调度与静态前端，对外连接 PostgreSQL、Elasticsearch、MinIO / S3、Redis、RabbitMQ、LLM Provider 和 Embedding Runtime。首次启动的核心目标不是“先跑起来再说”，而是让系统在可追溯、可恢复、可观测的前提下完成依赖检查和配置固化。

本文说明部署整体思想、推荐部署路径、`.env` 配置方式、首次引导页逻辑，以及部分配置失效时的启动处理策略。

## 部署整体思想

DocuMind 的生产部署遵循三层边界：

| 层级 | 组件 | 部署原则 |
|---|---|---|
| 应用层 | DocuMind Rust Binary + 内嵌前端 | 单二进制启动，负责 HTTP API、SPA 静态资源、Agent 编排和任务入口 |
| 状态层 | PostgreSQL、Elasticsearch、MinIO / S3、Redis、RabbitMQ | 默认连接外部托管或独立部署组件，不把关键状态写进应用进程内存 |
| 模型层 | LLM Provider、Embedding 模型、Reranker | 支持本地模型或 OpenAI-compatible API，配置必须可检查、可替换 |

生产环境不应依赖内存仓库、内存缓存或 Mock LLM。当前代码在缺少 `DATABASE_URL` 或 `REDIS_URL` 时会退回内存实现，适合本地原型和前端联调；生产启动应通过启动校验禁止这种降级，或者把系统锁定在“未完成配置”的引导模式。

## 推荐部署路径

推荐目录结构：

```text
/opt/documind/
├── bin/
│   └── documind
├── config/
│   ├── .env
│   └── setup-state.json
├── models/
│   └── bge-large-zh-v1.5.onnx
├── logs/
└── data/
    └── uploads/
```

路径约定：

| 路径 | 用途 |
|---|---|
| `/opt/documind/bin/documind` | 应用二进制 |
| `/opt/documind/config/.env` | 部署配置，包含数据库、缓存、MQ、LLM、Embedding 等连接信息 |
| `/opt/documind/config/setup-state.json` | 首次引导完成标记和配置摘要，不保存明文密钥 |
| `/opt/documind/models/` | 本地 ONNX Embedding / Reranker 模型 |
| `/opt/documind/logs/` | 应用日志输出目录 |
| `/opt/documind/data/uploads/` | 本地开发模式下的原始上传文件或临时解析文件目录；生产环境建议使用 MinIO / S3 |

启动命令：

```bash
cd /opt/documind
set -a
source config/.env
set +a
./bin/documind
```

也可以保留仓库默认方式：

```bash
cp .env.example .env
cargo run -p documind
```

本地开发可以使用仓库根目录 `.env`；生产建议把 `.env` 放在部署目录的 `config/` 下，并通过进程管理器显式加载。

## 外部依赖

DocuMind 默认连接外部组件：

| 组件 | 必需性 | 作用 | 失效影响 |
|---|---|---|---|
| PostgreSQL | 必需 | 租户、知识库、文档元数据、会话、问答记录、审计和配置摘要 | 核心 API 不可用，不能进入正常服务 |
| Elasticsearch | 必需 | 文档 Chunk 的 BM25、向量检索、Hybrid Search 与索引管理 | 上传后无法完成检索索引，问答召回不可用 |
| MinIO / S3 | 必需 | 原始文档、解析快照、大型表格导出、预览文件和重处理输入 | 文档上传、预览、重新解析和审计不可用 |
| Redis | 建议必需 | 会话状态、热点问答缓存、LLM 请求去重、短期锁 | 可降级但会影响性能和并发安全 |
| RabbitMQ | 必需 | 文档解析、向量化、索引重建等异步任务队列 | 文档上传后不能可靠进入处理流水线 |
| LLM Provider | 必需 | Query Rewrite、答案生成、可选 HyDE | 问答链路不可用 |
| Embedding Runtime | 必需 | 文档向量化和查询向量化 | 语义检索不可用 |

## `.env` 配置

`.env` 是首次启动的主要配置来源。推荐优先级为：

1. 进程环境变量。
2. 部署目录 `config/.env`。
3. 仓库根目录 `.env`，仅用于本地开发。
4. 引导页提交后写入的持久化配置。

生产环境应保证以下配置完整：

```env
# ── Server ──
SERVER_HOST=0.0.0.0
SERVER_PORT=8089
PUBLIC_BASE_URL=https://documind.example.com
WEB_OUT_DIR=apps/web/out

# ── PostgreSQL ──
DATABASE_URL=postgres://documind:change-me@postgres.example.com:5432/documind
DATABASE_MAX_CONNECTIONS=20
DATABASE_CONNECT_TIMEOUT_SECONDS=10
DATABASE_MIGRATE_ON_START=true

# ── Elasticsearch ──
ELASTICSEARCH_URL=http://elasticsearch.example.com:9200
ELASTICSEARCH_USERNAME=elastic
ELASTICSEARCH_PASSWORD=change-me
ELASTICSEARCH_INDEX_PREFIX=documind
ELASTICSEARCH_VECTOR_DIMS=1024
ELASTICSEARCH_TLS_VERIFY=true

# ── Object Storage (MinIO / S3) ──
OBJECT_STORAGE_PROVIDER=minio
OBJECT_STORAGE_ENDPOINT=http://minio.example.com:9000
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_BUCKET=documind
OBJECT_STORAGE_ACCESS_KEY=documind
OBJECT_STORAGE_SECRET_KEY=change-me
OBJECT_STORAGE_FORCE_PATH_STYLE=true
OBJECT_STORAGE_TLS_VERIFY=true
OBJECT_STORAGE_PRESIGN_EXPIRE_SECONDS=900

# ── Redis ──
REDIS_URL=redis://:change-me@redis.example.com:6379/0
REDIS_KEY_PREFIX=documind
REDIS_CONNECT_TIMEOUT_SECONDS=5

# ── RabbitMQ ──
RABBITMQ_URL=amqp://documind:change-me@rabbitmq.example.com:5672/%2f
RABBITMQ_EXCHANGE=documind
RABBITMQ_QUEUE_PARSE=documind.document.parse
RABBITMQ_QUEUE_EMBED=documind.document.embed
RABBITMQ_QUEUE_INDEX=documind.document.index
RABBITMQ_PREFETCH=8

# ── LLM Provider ──
USE_REAL_LLM=true
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_API_KEY=change-me
LLM_MODEL=qwen-plus
LLM_TEMPERATURE=0.2
LLM_MAX_OUTPUT_TOKENS=1200

# ── Embedding ──
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=bge-large-zh-v1.5
EMBEDDING_DIM=1024
ONNX_MODEL_PATH=/opt/documind/models/bge-large-zh-v1.5.onnx
# EMBEDDING_PROVIDER=api
# EMBEDDING_API_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings
# EMBEDDING_API_KEY=change-me

# ── RAG Defaults ──
RAG_REWRITE_ENABLED=true
RAG_HYDE_ENABLED=true
RAG_REWRITE_MODEL=qwen-turbo
RAG_DENSE_TOP_K=100
RAG_BM25_TOP_K=100
RAG_RRF_TOP_K=20
RAG_TOP_K=5
RAG_RERANK_ENABLED=true
RAG_RERANK_MODEL=bge-reranker-v2-m3
RAG_RERANK_THRESHOLD=0.3
RAG_REQUIRE_CITATION=true
RAG_VERIFY_CLAIMS=true
RAG_CHUNK_SIZE=1500
RAG_CHUNK_OVERLAP=200

# ── Auth / Tenant Bootstrap ──
JWT_SECRET=replace-with-at-least-32-random-bytes
AUTH_TOKEN_EXPIRE_HOURS=24
DEFAULT_TENANT_ID=00000000-0000-0000-0000-000000000001
DEFAULT_USER_ID=00000000-0000-0000-0000-000000000002
DEFAULT_ROLE=tenant_admin
DEFAULT_KB_IDS=00000000-0000-0000-0000-000000000003

# ── Logging ──
RUST_LOG=documind=info,tower_http=info
LOG_FORMAT=json
```

当前 `.env.example` 已包含 PostgreSQL、Redis、RabbitMQ、LLM、Embedding、Server、Auth、RAG 和 Agent 的基础项。Elasticsearch 与 MinIO / S3 相关变量在 PRD 和文档解析存储模型中属于目标架构依赖，建议在索引和上传模块落地时同步补充到配置结构体。

### PostgreSQL

`DATABASE_URL` 使用标准连接串：

```env
DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/DB_NAME
```

要求：

- 数据库用户需要具备建表、建索引、执行迁移的权限。
- 首次启动前应创建数据库，例如 `createdb documind`。
- 迁移目录位于 `apps/api-rs/migrations/`，当前至少包含会话、消息、检索 Trace、引用和反馈表。
- 如果启用 `DATABASE_MIGRATE_ON_START=true`，应用启动时先执行迁移；否则由部署流水线提前执行迁移。

### Elasticsearch

Elasticsearch 存储 Chunk 检索索引，包含 BM25 字段、向量字段和元数据字段。配置重点：

```env
ELASTICSEARCH_URL=http://elasticsearch.example.com:9200
ELASTICSEARCH_INDEX_PREFIX=documind
ELASTICSEARCH_VECTOR_DIMS=1024
```

要求：

- `ELASTICSEARCH_VECTOR_DIMS` 必须等于 `EMBEDDING_DIM`。
- Embedding 模型维度变化时不能复用旧索引，需要创建新索引并重建文档向量。
- 中文 BM25 检索建议安装 IK 或明确使用项目内置分词策略。

### MinIO / S3

MinIO / S3 存储原始文档和大对象数据。PostgreSQL 只保存对象路径和元数据，不直接保存原始文件。

```env
OBJECT_STORAGE_PROVIDER=minio
OBJECT_STORAGE_ENDPOINT=http://minio.example.com:9000
OBJECT_STORAGE_BUCKET=documind
OBJECT_STORAGE_ACCESS_KEY=documind
OBJECT_STORAGE_SECRET_KEY=change-me
OBJECT_STORAGE_FORCE_PATH_STYLE=true
```

对象路径建议与 `docs/document-parsing/storage-model.md` 保持一致：

```text
tenants/{tenant_id}/knowledge-bases/{kb_id}/documents/{doc_id}/original/{file_sha256}.{ext}
```

要求：

- 生产环境推荐 MinIO 或兼容 S3 的对象存储；本地 blob 目录只作为开发兜底。
- Bucket 需要在首次启动时检查是否存在；如果账号有权限，可以自动创建。
- 上传文件必须先写对象存储，再写 PostgreSQL 元数据，避免数据库中出现无法回溯的空引用。
- 下载和预览必须经过 DocuMind 权限校验，再生成短期 presigned URL 或由应用代理输出，不能直接暴露永久对象地址。
- 删除文档时要清理 PostgreSQL 记录、对象存储文件和 Elasticsearch 索引。

### Redis

Redis 用于缓存和短期状态：

```env
REDIS_URL=redis://:PASSWORD@HOST:6379/0
REDIS_KEY_PREFIX=documind
```

要求：

- 多环境共用 Redis 时必须设置不同的 `REDIS_KEY_PREFIX`。
- Redis 连接失败时，本地开发可退回内存缓存；生产环境应标记为 degraded，并阻止需要分布式锁或请求去重的后台任务启动。

### RabbitMQ

RabbitMQ 承载文档处理异步链路：

```env
RABBITMQ_URL=amqp://USER:PASSWORD@HOST:5672/%2f
RABBITMQ_EXCHANGE=documind
RABBITMQ_QUEUE_PARSE=documind.document.parse
RABBITMQ_QUEUE_EMBED=documind.document.embed
RABBITMQ_QUEUE_INDEX=documind.document.index
```

要求：

- 启动时声明 exchange、queue 和 binding，声明操作必须幂等。
- 文档上传 API 只负责保存原始文件和元数据，然后投递解析任务。
- Worker 消费需要设置 `prefetch`，避免大文档解析把任务全部占满。
- 失败任务进入 retry 或 dead-letter 队列，并在管理后台暴露状态。

### LLM 与 Embedding

LLM 配置：

```env
USE_REAL_LLM=true
LLM_BASE_URL=https://provider.example.com/v1
LLM_API_KEY=change-me
LLM_MODEL=qwen-plus
```

Embedding 配置：

```env
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=bge-large-zh-v1.5
EMBEDDING_DIM=1024
ONNX_MODEL_PATH=/opt/documind/models/bge-large-zh-v1.5.onnx
```

要求：

- `USE_REAL_LLM=false` 只允许开发和演示环境使用。
- `EMBEDDING_DIM` 必须和 Elasticsearch dense vector mapping 一致。
- 本地模型文件不存在时，启动校验应失败并进入引导或错误页，而不是等到首次上传时才暴露问题。

## 首次启动流程

启动流程分为 `加载配置 -> 校验依赖 -> 决定运行模式 -> 暴露服务` 四步。

```text
进程启动
  │
  ├─ 读取环境变量和 .env
  │
  ├─ 检查关键配置是否存在
  │    ├─ 缺失：进入 setup_required
  │    └─ 完整：继续校验连接
  │
  ├─ 校验 PostgreSQL / Elasticsearch / MinIO / Redis / RabbitMQ / LLM / Embedding
  │    ├─ 全部可用：进入 normal
  │    ├─ 非关键项失败：进入 degraded
  │    └─ 关键项失败：进入 setup_required 或 fatal
  │
  └─ 启动 HTTP 服务
       ├─ normal：开放全部 API 和前端
       ├─ degraded：开放只读 API、健康检查和配置修复页
       └─ setup_required：只开放健康检查、静态资源和首次引导 API
```

建议运行模式：

| 模式 | 触发条件 | 行为 |
|---|---|---|
| `normal` | 必需配置存在且连接检查通过 | 正常启动 API、前端和 Worker |
| `setup_required` | 未检测到 `.env`、关键配置缺失、首次引导未完成 | 前端自动跳转引导页，只开放配置检测和保存接口 |
| `degraded` | 配置存在但部分非关键组件不可用 | 应用启动但禁用受影响功能，管理后台显示修复项 |
| `fatal` | PostgreSQL、Elasticsearch、MinIO / S3、RabbitMQ、Embedding 等关键依赖不可用且无法进入引导 | 退出进程，日志明确指出失败项 |

## 引导页面逻辑

引导页面用于首次部署或配置修复。入口建议为 `/setup`，后端提供 `/api/setup/status`、`/api/setup/validate` 和 `/api/setup/apply`。

### 未检测到配置

如果没有检测到 `.env` 或关键变量缺失：

1. 后端启动为 `setup_required`。
2. `/api/health` 返回 `ok: true`，但附带 `mode: setup_required` 和缺失项列表。
3. 所有业务 API 返回 `503 Service Unavailable`，响应中包含 `setup_required: true`。
4. 前端路由自动进入 `/setup`。
5. 引导页要求管理员填写 PostgreSQL、Elasticsearch、MinIO / S3、Redis、RabbitMQ、LLM、Embedding 和初始管理员信息。
6. 用户点击“测试连接”时，后端只校验连接和权限，不写入配置。
7. 用户点击“保存并启动”后，后端写入部署配置，生成 `setup-state.json`，重新构建运行状态。

引导页不应该把密钥明文回显给前端。已保存配置再次展示时，只显示掩码，例如 `sk-****abcd`。

### 已检测到配置

如果配置已经存在：

1. 后端读取 `.env` 并做 schema 校验。
2. 对 PostgreSQL、Elasticsearch、MinIO / S3、Redis、RabbitMQ、LLM 和 Embedding 进行连接检查。
3. 检查通过后直接进入 `normal`。
4. 前端进入主应用，不显示引导页。
5. 管理后台的系统配置页只允许有权限的管理员查看和更新配置。

### 配置来源与保存

配置获取逻辑建议如下：

| 来源 | 是否可写 | 用途 |
|---|---|---|
| 环境变量 | 否 | 容器、systemd、Kubernetes Secret 注入 |
| `config/.env` | 是 | 单机部署和私有化部署的主要配置 |
| 数据库存储配置 | 是 | 租户级策略、LLM Provider 切换、检索参数等运行期配置 |
| `setup-state.json` | 是 | 首次引导是否完成、配置摘要、版本号 |

连接字符串、API Key、JWT Secret 等机密优先来自环境变量或 Secret，不建议只存数据库。数据库中可以保存 Provider 名称、模型名、Top-K、阈值、是否启用 HyDE 等非敏感或可加密配置。

## 部分配置失效时的处理

启动期间必须区分“缺失配置”和“已有配置失效”。

### PostgreSQL 失效

PostgreSQL 是核心依赖。处理策略：

- 启动时连接失败：生产环境进入 `fatal`，进程退出；本地开发可以显式允许内存模式。
- 迁移失败：进入 `fatal`，保留错误日志，不继续启动业务 API。
- 连接池耗尽：应用保持运行，健康检查返回 `degraded`，业务 API 对写操作返回明确错误。

### Elasticsearch 失效

Elasticsearch 影响文档检索和索引：

- 启动时不可达：进入 `degraded` 或 `fatal`，取决于是否允许只浏览历史会话。
- 上传文档相关 API 应返回 `503`，提示“检索索引服务不可用”。
- 问答 API 如果无法检索文档，应拒绝无依据生成，返回可解释的 no-answer 状态。
- 索引 mapping 与 `EMBEDDING_DIM` 不一致时，应阻止启动 Worker，并提示重建索引。

### MinIO / S3 失效

MinIO / S3 影响原始文件和解析输入：

- 启动时不可达：进入 `fatal` 或 `setup_required`，不允许正常开放上传入口。
- Bucket 不存在且无法创建：进入 `fatal`，提示检查 bucket 名称和账号权限。
- 写入失败：上传 API 返回 `503`，不写入 `documents` 元数据，避免出现悬空记录。
- 读取失败：文档预览、重新解析和补偿任务返回明确错误；已有问答历史仍可浏览，但引用原文预览不可用。
- 删除失败：先标记对象待清理，保留后台补偿任务，避免误报删除完成。

### Redis 失效

Redis 可短期降级：

- 启动时不可达：进入 `degraded`，使用内存缓存兜底，但标记“非生产安全”。
- 禁用依赖分布式锁的任务，例如批量重建索引。
- 健康检查返回 Redis 子项失败，方便运维发现。

### RabbitMQ 失效

RabbitMQ 影响异步文档处理：

- 启动时不可达：业务 API 可以启动，但文档上传、重处理、索引重建 API 返回 `503`。
- Worker 不启动，避免任务状态被误标记。
- 已上传但未投递成功的文档状态应保持 `pending_queue`，RabbitMQ 恢复后由补偿任务重新投递。

### LLM Provider 失效

LLM 失效时：

- 启动探活失败：进入 `degraded`，禁用问答生成。
- Query Rewrite 可选择降级到规则改写，但最终生成不能使用 Mock 结果冒充真实答案。
- 前端问答入口显示模型不可用状态，管理后台提供重新测试入口。

### Embedding 失效

Embedding 是语义检索关键依赖：

- 本地模型路径不存在或维度不匹配：进入 `fatal` 或 `setup_required`。
- API Embedding 失效：暂停上传解析和向量化任务。
- 查询阶段无法生成 query embedding 时，不能只用 LLM 直接回答；可退回 BM25 检索，但答案仍必须有引用。

## 健康检查

建议 `/api/health` 返回聚合状态：

```json
{
  "ok": false,
  "mode": "degraded",
  "service": "documind",
  "checks": {
    "postgres": {"ok": true},
    "elasticsearch": {"ok": false, "reason": "connection refused"},
    "object_storage": {"ok": true, "provider": "minio", "bucket": "documind"},
    "redis": {"ok": true},
    "rabbitmq": {"ok": true},
    "llm": {"ok": true},
    "embedding": {"ok": true}
  },
  "actions": [
    "检查 ELASTICSEARCH_URL",
    "确认索引维度与 EMBEDDING_DIM 一致"
  ]
}
```

`ok` 只表示系统是否可提供完整服务；`mode` 用于告诉前端应该进入主应用、引导页还是配置修复页。

## 实现备注

当前代码已经通过 `dotenvy` 读取 `.env`，并在 `apps/api-rs/src/config.rs` 中解析 `DATABASE_URL`、`REDIS_URL`、LLM、RAG、Agent 等配置。后续落地首次引导时，建议补齐以下能力：

- 增加 `DeploymentConfig`，显式区分开发默认值和生产必填项。
- 增加 Elasticsearch、MinIO / S3、RabbitMQ、Embedding Provider 的配置结构体。
- 增加启动前 `validate_required_config` 和 `probe_dependencies`。
- 增加运行模式 `normal / setup_required / degraded / fatal`。
- 增加 `/api/setup/status`、`/api/setup/validate`、`/api/setup/apply`。
- 将当前“缺失 DB/Redis 时退回内存实现”的行为限制在开发环境。
- 在 `.env.example` 中补齐 Elasticsearch、MinIO / S3 和部署引导相关变量。

# 知识库文档对象存储（MinIO / S3）

## 背景与目标

DocuMind 当前把上传的原始文档保存在后端服务器的本地目录（默认 `data/documents`）。随着多租户、多知识库场景上线，本地目录在扩展、备份、权限隔离和集群部署上都存在明显瓶颈。

本文规定知识库文档对象存储的设计与实现路径，要求：

1. **默认走 MinIO / S3**：配置完整时，上传、下载、删除、重新解析读取原件全部通过对象存储客户端完成。
2. **按租户隔离**：存储 key 以租户为顶层前缀，避免跨租户数据混放。
3. **知识库与文档二次隔离**：同一租户下不同知识库、不同文档拥有独立前缀，便于后续按知识库生命周期清理。
4. **向后兼容**：未配置对象存储或本地开发时，自动回退到本地文件系统。
5. **权限边界清晰**：对象存储层只负责“按 key 存取”；租户 / 知识库 / 文档的访问权限由 API 层在操作数据库前完成校验。

## 存储路径约定

所有原始文档统一存放在同一个 bucket 下，通过 key 前缀实现逻辑隔离。

### Key 结构

```text
tenants/{tenant_id}/knowledge-bases/{kb_id}/documents/{doc_id}/original/{file_sha256}.{file_type}
```

示例：

```text
tenants/00000000-0000-0000-0000-000000000001/knowledge-bases/00000000-0000-0000-0000-000000000003/documents/00000000-0000-0000-0000-00000000000a/original/a1b2c3...f0d9.pdf
```

### 层级含义

| 层级 | 取值 | 作用 |
|---|---|---|
| `tenants/{tenant_id}` | UUID | 租户顶层命名空间，物理隔离不同租户的对象。 |
| `knowledge-bases/{kb_id}` | UUID | 知识库作用域，删除知识库时可通过前缀批量清理对象。 |
| `documents/{doc_id}` | UUID | 文档作用域，单个文档的多个版本、快照、附件都放于此。 |
| `original/` | 固定目录 | 存放用户上传的原始文件。 |
| `{file_sha256}.{file_type}` | 文件名 | 使用 SHA-256 避免重复上传时覆盖冲突，同时作为缓存/去重键。 |

### 为什么不用 bucket-per-tenant

- MinIO / S3 的 bucket 数量有上限或管理成本，且需要创建/删除权限。
- 同一 bucket 内按前缀隔离足以满足当前权限模型，且更利于统一生命周期策略、监控和备份。
- 后续如需要真正的物理强隔离，可再引入 bucket-per-tenant 或 bucket-per-kb 的迁移开关，而不影响 key 结构。

## 权限隔离设计

对象存储层**不自行实现** RBAC 或租户鉴权，而是依赖上层 API 的既有权限校验：

1. **上传**：`POST /api/knowledge-bases/:kb_id/documents`
   - 校验 `document.upload` 权限。
   - 校验当前用户对目标 `kb_id` 有 `write` 权限。
   - 校验通过后，再生成并写入对象存储 key。

2. **下载**：`GET /api/admin/documents/:doc_id/original`
   - 校验 `document.upload` 权限（读取原始文件与上传共用同一权限点）。
   - 从数据库读取 `doc_id` 对应的 `tenant_id`、`kb_id`、`storage_key`。
   - 校验当前用户属于该租户，且对 `kb_id` 有 `read` 或 `write` 权限。
   - 校验通过后，按 `storage_key` 从对象存储读取字节流返回。

3. **删除**：`DELETE /api/admin/documents/:doc_id`
   - 校验 `document.delete` 权限。
   - 校验对 `kb_id` 有 `write` 权限。
   - 先删除数据库记录，再删除对象存储中的原始文件。

4. **重新解析**：`POST /api/admin/documents/:doc_id/reprocess`
   - 校验 `document.reprocess` 权限。
   - 校验对 `kb_id` 有 `write` 权限。
   - 按 `storage_key` 从对象存储读取字节流进入解析流水线。

### 未来扩展

- 若后续需要“临时预签名下载链接”，可由后端调用 S3 `presign_get_object`，链接有效期受 `OBJECT_STORAGE_PRESIGN_EXPIRE_SECONDS` 控制，前端不直接接触 access key。
- 若需要“文档版本管理”，可在 `documents/{doc_id}/` 下增加 `versions/{parse_version}/` 前缀，原始文件仍保留在 `original/`。

## 配置项

所有对象存储配置已从 `.env.example` 中预留，实现后全部生效：

| 环境变量 | 说明 | 默认值 / 示例 |
|---|---|---|
| `OBJECT_STORAGE_PROVIDER` | 对象存储类型 | `minio`（兼容 S3）或 `s3` |
| `OBJECT_STORAGE_ENDPOINT` | 服务端点 | `http://localhost:9000` |
| `OBJECT_STORAGE_REGION` | 区域 | `us-east-1` |
| `OBJECT_STORAGE_BUCKET` | bucket 名称 | `documind` |
| `OBJECT_STORAGE_ACCESS_KEY` | Access Key | `documind` |
| `OBJECT_STORAGE_SECRET_KEY` | Secret Key | `documind` |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | 是否强制 path-style | `true`（MinIO 通常需要） |
| `OBJECT_STORAGE_TLS_VERIFY` | 是否校验 TLS | `false`（内网 MinIO 可关闭） |
| `OBJECT_STORAGE_PRESIGN_EXPIRE_SECONDS` | 预签名 URL 有效期 | `900` |
| `BLOB_STORAGE_DIR` | 本地回退目录 | `./data/objects` |

### 启用对象存储的条件

当且仅当以下三个配置同时存在且非空时，系统使用对象存储：

- `OBJECT_STORAGE_ENDPOINT`
- `OBJECT_STORAGE_ACCESS_KEY`
- `OBJECT_STORAGE_SECRET_KEY`

任一缺失时，系统回退到 `BLOB_STORAGE_DIR` 本地存储，并打印一条 info 日志说明当前使用的存储后端。

## 接口行为变更

### 上传接口

`POST /api/knowledge-bases/:kb_id/documents`

- 业务逻辑不变：文件校验、SHA-256 计算、数据库记录、解析任务排队均保留。
- `storage_key` 仍按约定生成并写入 `documents.storage_key`。
- 持久化步骤由 `tokio::fs::write` 改为调用对象存储客户端 `put_object`。

### 下载接口

`GET /api/admin/documents/:doc_id/original`

- 由 `tokio::fs::read` 改为对象存储客户端 `get_object`，返回 `Vec<u8>` 后组装响应。

### 删除接口

`DELETE /api/admin/documents/:doc_id`

- 先删除数据库记录；对象存储删除失败不阻塞 API 返回，但记录 warn 日志便于后续清理。

### 重新解析

`POST /api/admin/documents/:doc_id/reprocess`

- 由 `tokio::fs::read` 改为对象存储客户端 `get_object` 读取原始字节。

## 实现要点

### 依赖

后端引入 AWS SDK for Rust S3 客户端（`aws-sdk-s3` + `aws-config`），通过自定义 endpoint 兼容 MinIO：

```toml
aws-config = "1"
aws-sdk-s3 = "1"
aws-credential-types = "1"
```

### 存储抽象

新增 `apps/api-rs/src/storage/mod.rs`，定义统一接口：

```rust
#[async_trait]
pub trait ObjectStorage: Send + Sync {
    async fn put(&self, key: &str, bytes: &[u8]) -> Result<()>;
    async fn get(&self, key: &str) -> Result<Vec<u8>>;
    async fn delete(&self, key: &str) -> Result<()>;
}
```

提供两个实现：

- `S3Storage`：基于 `aws-sdk-s3`，支持 endpoint、path-style、TLS 校验等配置。
- `LocalStorage`：基于 `tokio::fs`，key 直接映射为 `BLOB_STORAGE_DIR` 下的相对路径。

### State 集成

`AppState` 增加 `storage: Arc<dyn ObjectStorage>`，由 `build_state` 根据配置初始化：

- 配置完整 → `Arc::new(S3Storage::new(...))`
- 配置缺失 → `Arc::new(LocalStorage::new(blob_storage_dir))`

### 文档 key 不变性

`documents.storage_key` 一旦写入不再变更。文档移动知识库时只修改 `kb_id` 字段，不移动对象存储中的文件。这样：

- 避免对象存储中大量 rename 操作。
- `storage_key` 中的 `knowledge-bases/{kb_id}` 段保留为文档**创建时**的知识库，不影响当前所属知识库查询。
- 若未来坚持要物理移动，可作为后台清理任务处理，而非实时阻塞操作。

## 本地开发

不配置 `OBJECT_STORAGE_ENDPOINT` 时自动使用本地目录 `./data/objects`，目录结构与生产对象存储 key 保持一致，便于调试：

```text
data/objects/tenants/{tenant_id}/knowledge-bases/{kb_id}/documents/{doc_id}/original/{sha256}.{type}
```

## 验收标准

- [ ] 配置完整 MinIO 后，上传的 PDF/DOCX/PPTX 出现在 MinIO bucket 的 `tenants/{tenant_id}/knowledge-bases/{kb_id}/documents/{doc_id}/original/` 下。
- [ ] 未配置对象存储时，文件仍落在 `BLOB_STORAGE_DIR` 下，目录结构与对象存储 key 一致。
- [ ] 下载、删除、重新解析功能在两种后端下均正常工作。
- [ ] 跨租户用户无法通过构造 URL 访问其他租户的原始文件（API 层校验 + key 前缀隔离）。
- [ ] 删除文档时数据库记录删除成功，对象存储删除失败不影响 API 返回。

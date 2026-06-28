# 权限控制 (Access Control)

跨领域的权限与隔离层，保证不同角色和租户的数据访问边界。

## 核心职责

- **租户隔离**：多租户数据完全隔离，查询/文档/chunks 严格按 tenant_id 过滤
- **RBAC 角色体系**：超级管理员 / 租户管理员 / 普通用户，按角色收敛 API 权限
- **知识库级权限**：用户只访问被授权的知识库（读/写/管理）
- **API 鉴权**：JWT / Session 中间件，请求级 enforce
- **操作审计**：敏感操作留痕（删除文档、修改配置、导出数据）

## 设计要点

权限是横切面，不归属任一业务领域。API 层通过中间件统一 enforce，领域服务层通过 context 传递 actor 身份和 scope。

## 远端现状核验（2026-06-28）

以下结论基于 `ssh documind` 上的真实运行环境：

- 当前服务运行在 `http://127.0.0.1:8089`，release 为 `/opt/documind/releases/20260628-015027`。
- `/api/health` 返回 `ok=true`、`mode=release`、`environment=production`，PostgreSQL、Redis、RabbitMQ、Elasticsearch、MinIO/object storage、真实 LLM、Embedding 均为 `true`。
- PostgreSQL 使用 `documind_dev` 数据库与 `documind` schema。
- 当前只有一个租户：`AcmeCorp` / `acme` / `active`。
- `Anner` 是真实存在的超级管理员账号，远端 API 登录成功后返回 `roles=["super_admin"]`、26 个权限、3 个可访问知识库并签发 token。
- `admin@documind.local` 当前是 `enterprise_admin`，API 可访问 `/api/admin/knowledge-bases`，不可访问 `/api/system/models`。
- `user@documind.local` 当前是 `user`，只拥有普通用户权限，不可访问 `/api/admin/*` 或 `/api/system/*`。
- 数据库存在 `tenant_member.invited_by`、`tenant_member.invited_at` 字段，但没有独立 invitation / invite token 表；当前 3 个成员的邀请字段均为空。

## 权限硬规则

- 左侧后台导航必须由一份权限菜单定义驱动，不能按页面各自拼装；同一路由下不同页面的边栏顺序、分组和入口必须稳定。
- `super_admin` 可以进入 `/system/*`，看到全局租户、全局用户、模型服务、向量索引、任务队列、全量审计和系统设置。
- `super_admin` 可以进入租户后台排障和管理，但默认仍要带明确 `tenant_id` scope，不允许用超管身份绕过业务数据边界直接问答。
- 租户管理员角色包括目标态 `tenant_owner` / `tenant_admin`，以及当前线上兼容角色 `enterprise_admin` / `team_admin` / `data_admin`。
- 租户管理员可以看到本租户知识库后台：概览、知识库、文档管理、解析/重处理、问答日志、成员、知识库授权、本租户审计。
- 租户管理员可以看到租户级系统配置：切割策略、检索参数、租户级 LLM/Embedding/Reranker 绑定、用量与配额、SSO 与安全。
- 全局模型 Provider、全局 API key、全局 embedding 维度、索引版本迁移、系统级任务队列、全平台审计只能由 `super_admin` 查看和修改。
- 普通用户只进入 `/chat`、只读 `/knowledge` 和个人历史，不展示后台左侧边栏。

## 租户隔离硬规则

- 所有知识库、文档、解析任务、block、table、chunk、embedding、source anchor、会话、消息、审计都必须携带或可追溯到 `tenant_id`。
- 后端不得信任请求 body/query 中传入的 `tenant_id`；租户范围必须来自 session/JWT 解析后的 `CurrentActor`。
- 知识库列表、文档列表、解析详情、chunk、引用、FileView、下载原文、检索和问答都必须先按 `tenant_id` 过滤，再按知识库 ACL 过滤。
- 检索链路必须 pre-filter：`tenant_id = actor.tenant_id AND kb_id IN actor.allowed_kb_ids`，不得检索后再过滤。
- 数据库迁移应继续补强复合一致性：`documents(tenant_id,kb_id)` 必须匹配 `knowledge_base(tenant_id,id)`；`chunks/chunk_embeddings/source_anchors` 必须匹配所属文档的 `tenant_id/kb_id/doc_id`。
- 当前远端核验未发现错配：documents/kb、chunks/doc、embeddings/chunk、anchors/doc 的 tenant/kb/doc scope mismatch 计数均为 0。

## 详细设计

- [用户角色认证与页面设计](./user-role-authentication.md)
- [后台导航统一契约](../frontend/admin-navigation.md)

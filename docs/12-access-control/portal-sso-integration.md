# DocuMind 门户统一登录接入方案

## 定位

DocuMind 是门户下的企业文档 RAG 子系统。接入门户统一登录后，用户在门户完成登录，从门户首页点击 DocuMind 入口即可进入文档问答或管理后台；DocuMind 不再在门户托管部署链路中要求用户再次输入账号密码。

本方案与门户侧总协议保持一致：

- 浏览器只携带一次性 code 跳转到 DocuMind。
- DocuMind 后端使用 code 调用门户 `POST /api/auth/exchange-ticket` 换取身份上下文。
- DocuMind 根据门户上下文建立本地 JWT 和 Redis session。
- DocuMind 本地账号体系保留，用于独立部署模式。

## 当前认证现状

DocuMind 当前已有本地认证、角色路由和租户 ACL：

- 本地登录：`POST /api/v1/auth/login`
- 当前用户：`GET /api/v1/me`、`GET /api/v1/auth/me`
- 刷新令牌：`POST /api/v1/auth/refresh`
- 退出登录：`POST /api/v1/auth/logout`
- 前端 token 存储：`localStorage`，key 为 `documind-auth`。
- 后端令牌：HS256 JWT。
- 服务端 session：Redis key `documind:auth:session:{sid}`。

当前 JWT claims：

```json
{
  "sub": "documind user uuid",
  "email": "zhangsan@example.com",
  "role": "enterprise_admin",
  "tenant_id": "documind tenant uuid",
  "sid": "session id",
  "exp": 1781590000
}
```

当前运行时用户上下文：

```rust
CurrentActor {
    user_id,
    tenant_id,
    email,
    name,
    roles,
    permissions,
    allowed_kb_ids,
    is_super_admin,
}
```

DocuMind 已支持多角色数组、权限派生和知识库级 ACL。门户接入后，应把门户下发的 `systemRoles` 转换为 DocuMind `roles`，再用门户 `permissions` 作为权限上限。

## 对接接口

### 门户进入 DocuMind

门户前端调用门户后端：

```text
POST /api/portal/systems/{system_code}/enter
```

其中 DocuMind 的系统编码固定为：

```text
documind
```

门户返回：

```json
{
  "callbackUrl": "https://documind.example.com/auth/portal/callback",
  "code": "ticket_uuid:secret",
  "expiresAt": "2026-06-16T10:00:00Z"
}
```

浏览器跳转到：

```text
GET /auth/portal/callback?code=ticket_uuid:secret
```

### DocuMind 换取门户上下文

DocuMind callback 后端收到 `code` 后，服务端调用门户：

```text
POST {PORTAL_BASE_URL}/api/auth/exchange-ticket
```

请求体：

```json
{
  "system_code": "documind",
  "code": "ticket_uuid:secret"
}
```

门户返回上下文：

```json
{
  "userId": "portal user uuid",
  "username": "zhangsan",
  "displayName": "张三",
  "email": "zhangsan@example.com",
  "avatarUrl": null,
  "tenantId": "portal tenant uuid",
  "tenantCode": "acme",
  "tenantName": "Acme Corp",
  "systemCode": "documind",
  "portalRoles": ["normal-user"],
  "systemRoles": ["enterprise_admin"],
  "permissions": ["documind:chat:ask", "documind:knowledge:manage"],
  "adminScopes": [],
  "issuedAt": 1781590000,
  "expiresAt": 1781590300
}
```

DocuMind 必须校验：

- `systemCode == "documind"`。
- `expiresAt` 未过期。
- `userId` 非空。
- `tenantId` 非空；本地不存在时可以自动创建 DocuMind 租户。
- `systemRoles` 至少能映射出一个 DocuMind 角色。

## 自动开通与本地登录态转换

DocuMind 不直接使用门户 code 作为本地 token。换票成功后，DocuMind 应创建或更新本地身份，再签发现有格式的 DocuMind JWT。

流程：

```text
/auth/portal/callback
  -> exchange portal ticket
  -> upsert local tenant
  -> upsert local app_user
  -> upsert tenant_member roles
  -> derive local permissions
  -> intersect with portal permissions
  -> create Redis auth session
  -> issue DocuMind JWT
  -> write token to frontend storage
  -> redirect default route by role
```

DocuMind 已有 `app_user.sso_subject`，可直接作为门户身份映射字段：

```text
auth_provider = 'portal'
sso_subject = portal user id
```

如果需要同时支持多个外部身份源，建议新增映射表：

```sql
CREATE TABLE external_identity_link (
    provider VARCHAR(32) NOT NULL,
    external_user_id VARCHAR(64) NOT NULL,
    external_tenant_id VARCHAR(64),
    local_user_id UUID NOT NULL REFERENCES app_user(id),
    local_tenant_id UUID REFERENCES tenant(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, external_user_id, external_tenant_id)
);
```

自动开通规则：

1. 租户：优先使用门户 `tenantId` 作为 DocuMind `tenant.id`；不存在则用 `tenantCode`、`tenantName` 创建租户。
2. 用户：按 `auth_provider='portal'` 和 `sso_subject=portal user id` 查找本地 `app_user`；不存在则创建用户。
3. 角色：每次门户进入都按 `systemRoles` 重算 DocuMind roles，并更新 `tenant_member.roles`。
4. 租户成员：不存在则创建 `tenant_member`；存在则更新角色、状态和最近访问时间。
5. 权限：先用本地 `derive_permissions` 派生权限，再与门户 `permissions` 取交集。
6. 知识库范围：普通用户仍按 `knowledge_base_acl` 计算 `allowed_kb_ids`；自动开通不默认授予所有知识库。
7. 幂等：重复进入同一租户时只更新资料、角色和权限快照，不重复创建用户或租户。
8. 失败：无法创建租户、无法映射角色或数据库写入失败时拒绝登录，不回退到默认租户或默认管理员。

## 角色映射

DocuMind 接收门户 `systemRoles`，并转换为 `tenant_member.roles` 或本次 session 的 `CurrentActor.roles`。

| 门户 `systemRoles` | DocuMind 角色 | 说明 |
| --- | --- | --- |
| `super_admin` | `super_admin` | 全局运维 |
| `tenant_owner` | `tenant_owner` | 租户所有者 |
| `tenant_admin` | `tenant_admin` | 知识库、文档、成员和配置管理 |
| `enterprise_admin` | `enterprise_admin` | 租户管理员兼容角色 |
| `team_admin` | `team_admin` | 团队或部分知识库管理 |
| `data_admin` | `data_admin` | 文档处理和检索配置管理 |
| `analyst` | `user` 或 `analyst` | 文档问答用户 |
| `user` | `user` | 普通问答用户 |
| `viewer` | `viewer` | 只读知识库用户 |

DocuMind 支持多角色数组，因此可以保留门户下发的多个角色。若需要确定默认跳转路径，按以下优先级选择主角色：

```text
super_admin > tenant_owner > enterprise_admin > tenant_admin > team_admin > data_admin > analyst > user > viewer
```

默认跳转：

| 主角色 | 默认入口 |
| --- | --- |
| `super_admin` | `/system` |
| `tenant_owner` / `tenant_admin` / `enterprise_admin` / `team_admin` / `data_admin` | `/admin` |
| `user` / `analyst` / `end_user` | `/chat` |
| `viewer` | `/knowledge` |

## 权限声明

门户下发的 `permissions` 是 DocuMind 权限上限。DocuMind 本地 `derive_permissions` 可以继续使用，但最终权限不能超过门户授权。

建议声明：

```text
documind:chat:ask
documind:knowledge:read
documind:knowledge:write
documind:knowledge:manage
documind:document:upload
documind:document:delete
documind:document:reprocess
documind:member:read
documind:member:write
documind:config:read
documind:config:write
documind:audit:read
documind:model:manage
```

有效权限计算建议：

```text
effective_permissions = local_permissions_derived_from_roles ∩ portal_permissions
```

权限名需要在实现中建立映射。例如：

| 门户权限 | DocuMind 本地权限 |
| --- | --- |
| `documind:chat:ask` | `chat.ask` |
| `documind:knowledge:read` | `kb.read` |
| `documind:knowledge:write` | `kb.write` |
| `documind:knowledge:manage` | `kb.manage` |
| `documind:document:upload` | `document.upload` |
| `documind:document:delete` | `document.delete` |
| `documind:document:reprocess` | `document.reprocess` |
| `documind:member:read` | `member.read` |
| `documind:member:write` | `member.write` |
| `documind:config:read` | `config.read` |
| `documind:config:write` | `config.write` |
| `documind:audit:read` | `audit.read` |
| `documind:model:manage` | `model.write` |

## 知识库范围

DocuMind 的业务权限最终还要落到知识库 ACL。

建议规则：

- 管理角色在门户授权范围内可管理当前租户 active 知识库。
- 普通用户仍按 `knowledge_base_acl` 计算 `allowed_kb_ids`。
- 门户 `adminScopes` 后续可映射到知识库、部门或标签范围。
- 若门户没有下发知识库范围，DocuMind 不能扩大到跨租户或未授权知识库。

## 配置项

当前服务器默认使用 DocuMind 独立本地认证。门户接入是可选模式，只有显式配置 `AUTH_LOGIN_MODE=portal` 时才按门户托管处理；否则 `/login` 与 `/api/v1/auth/login` 是正式入口，不应被当作门户系统的附属登录。

```env
SYSTEM_CODE=documind
AUTH_LOGIN_MODE=portal
PORTAL_MANAGED=true
PORTAL_AUTH_ENABLED=true
PORTAL_BASE_URL=http://localhost:8080
PORTAL_EXCHANGE_ENDPOINT=/api/auth/exchange-ticket
PORTAL_AUTH_CALLBACK=/auth/portal/callback
PORTAL_CLIENT_ID=documind
PORTAL_CLIENT_SECRET=change-me
```

语义：

- `AUTH_LOGIN_MODE=local`：正常独立登录模式。DocuMind 使用自己的邮箱/密码、会话和权限体系，门户 callback 不生效。
- `AUTH_LOGIN_MODE=portal`：接口门户模式。DocuMind 只信任门户下发的一次性 ticket；callback 换票成功后，按门户身份自动创建或同步本地租户、用户和租户成员关系，然后直接签发 DocuMind 登录态。
- `PORTAL_MANAGED=true`：当前部署由门户统一入口管理。
- `PORTAL_AUTH_ENABLED=true`：兼容旧配置，用于标识门户认证；实际是否进入门户模式以 `AUTH_LOGIN_MODE=portal` 为准。
- `PORTAL_BASE_URL`：门户后端地址。
- `PORTAL_EXCHANGE_ENDPOINT`：门户换票接口。
- `PORTAL_AUTH_CALLBACK`：DocuMind 接收门户 code 的回调路径。
- `PORTAL_CLIENT_SECRET`：DocuMind 调用门户换票接口的服务凭证。门户当前还需要补齐服务凭证校验。

## 本地登录入口处理

独立部署模式：

- `AUTH_LOGIN_MODE=local`。
- 保留 `/login`、`/api/v1/auth/login` 和本地账号密码登录。

门户托管模式：

- `AUTH_LOGIN_MODE=portal`。
- `/login` 不再作为生产登录入口。
- 未登录访问受保护页面时，跳转到门户登录页或门户首页。
- `/api/v1/auth/login` 可保留给开发和紧急维护；若门户是唯一生产入口，应通过配置关闭、限制来源或只允许专用维护账号。

## 门户模式自动建号规则

`AUTH_LOGIN_MODE=portal` 时，本地是否已存在用户不影响登录。DocuMind 必须优先信任门户 ticket：

- 门户超级管理员始终映射为 DocuMind `super_admin`，优先级最高；即使 DocuMind 本地没有该账号，也会自动创建并登录。
- 门户租户所有者映射为 `tenant_owner`。
- 门户租户管理员映射为 `tenant_admin`。
- 门户企业管理员或通用管理员映射为 `enterprise_admin`。
- 门户模块管理员或子系统管理员映射为 `team_admin`。
- 门户普通用户、标准用户、访客类角色映射为 `user`。
- 如果门户权限矩阵没有显式下发 `systemRoles`，但 ticket 合法，DocuMind 仍会兜底创建 `user`，避免因本地账号不存在或角色为空导致 `unauthorized`。
- 自动 provision 会写入 `auth_provider='portal'` 和 `sso_subject=portal user id`，后续同一门户用户再次进入时同步邮箱、姓名、角色、租户和成员关系，而不是创建重复账号。

## 审计

DocuMind 建议新增审计事件：

- `portal.login.success`
- `portal.login.failure`
- `portal.ticket.exchange.failure`
- `portal.identity.link.created`
- `portal.identity.link.updated`
- `portal.permission.clamped`

审计字段至少包含：

- `portal_user_id`
- `portal_tenant_id`
- `local_user_id`
- `local_tenant_id`
- `system_roles`
- `portal_permissions`
- `effective_permissions`
- `allowed_kb_ids`
- `failure_reason`

## 实施步骤

1. 增加门户配置项和 `PortalContext` 结构体。
2. 新增 `/auth/portal/callback` 路由。
3. 实现服务端 `exchange-ticket` 调用。
4. 使用 `app_user.sso_subject` 或映射表绑定门户用户。
5. 将 `systemRoles` 转换为 DocuMind roles。
6. 用本地 `derive_permissions` 和门户 `permissions` 计算最终权限。
7. 复用现有 session 与 JWT 签发逻辑建立本地登录态。
8. 在 `AUTH_LOGIN_MODE=portal` 时旁路本地登录页。
9. 增加端到端测试：门户登录后进入 DocuMind、重复 code 失败、权限不同导致默认入口不同。

## 验收标准

- 用户在门户登录后点击 DocuMind 入口，可直接进入文档问答或管理页面。
- 门户下发 `viewer` 时，DocuMind 默认进入 `/knowledge`，不能发起问答。
- 门户下发 `user` 或 `analyst` 时，DocuMind 默认进入 `/chat`。
- 门户下发 `enterprise_admin` 或 `tenant_admin` 时，DocuMind 默认进入 `/admin`。
- code 过期、重复使用、`system_code` 不匹配时登录失败。
- 门户托管模式下，生产访问不会出现 DocuMind 本地登录页；独立部署模式下仍使用 DocuMind 本地登录页。
- DocuMind 本地权限不会超过门户下发的 `permissions`。

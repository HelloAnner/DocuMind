# 用户角色认证与页面设计

> DocuMind 的用户、租户、角色设计对齐 Northline：同一套多租户身份模型、同一套 RBAC/资源范围控制，只是业务资源从“数据源/语义层”替换为“知识库/文档/检索配置”。当前服务器已使用 DocuMind 独立本地登录、JWT/session、租户成员和知识库 ACL；门户 SSO 是显式开启的可选模式。

---

## 1. 设计目标

DocuMind 是企业级文档智能问答系统，权限边界必须在 Prompt 之前完成，而不是把“你只能看哪些文档”交给模型自觉遵守。

核心目标：

- **租户隔离**：所有知识库、文档、切片、索引、对话、日志都带 `tenant_id`，跨租户不可见。
- **角色分层**：超级管理员看全局运维和租户，租户管理员管理本租户知识库，普通用户只问答和查看自己被授权的内容。
- **知识库级授权**：普通用户只可访问被授权的知识库；无权限知识库在列表、搜索、检索、引用中都不存在。
- **认证可替换**：先支持本地账号，后续兼容企业 SSO（OIDC/SAML）和邀请链接。
- **页面按角色收敛**：登录后按角色进入不同工作台，导航、接口、数据返回都同步收敛。

当前实现说明：

- 独立部署模式下保留 `/login` 和 `/api/v1/auth/login`，通过本地账号密码换取 DocuMind JWT/session。
- `AUTH_LOGIN_MODE=portal` 时才进入门户托管模式，由门户 ticket 换取本地登录态。
- 早期的 `mock_current_user` 只适合开发原型，不属于服务器验收口径。
- 登录后按角色和权限收敛导航、接口和知识库范围。

远端核验事实（2026-06-28）：

- `ssh documind` 当前 release 是 `/opt/documind/releases/20260628-015027`。
- `/api/health` 返回生产 release 正常，PostgreSQL、Redis、RabbitMQ、Elasticsearch、MinIO/object storage、真实 LLM、Embedding 全部可用。
- `Anner` 是当前超级管理员；远端 `/api/v1/auth/login` 核验返回 `roles=["super_admin"]`、26 个权限、3 个可访问知识库并签发 token。
- 当前租户为 `AcmeCorp` / `acme`；当前成员包括 `Anner`、`admin@documind.local`、`user@documind.local`。
- 当前线上兼容角色仍有 `enterprise_admin` 和 `user`：`enterprise_admin` 可访问 `/api/admin/*` 但不可访问 `/api/system/*`；`user` 不可访问后台。

---

## 2. 角色模型

### 2.1 角色分层

| 角色 | 代码 | 范围 | 对标 Northline | 核心职责 |
| --- | --- | --- | --- | --- |
| 超级管理员 | `super_admin` | 全平台 | `super_admin` | 租户管理、全局模型配置、系统运维、全量审计 |
| 租户所有者 | `tenant_owner` | 单租户 | `tenant_owner` | 租户删除/转移、SSO、安全策略、最高租户权限 |
| 租户管理员 / 知识库管理员 | `tenant_admin` | 单租户 | `tenant_admin` | 知识库、文档、成员、检索/切割/LLM 配置 |
| 普通用户 | `end_user` | 单租户内授权资源 | `analyst` / `end_user` | 文档问答、历史会话、反馈、个人设置 |
| 只读用户（可选） | `viewer` | 单租户内授权资源 | `viewer` | 只看共享问答、知识库目录，不发起问答 |

设计原则：

- 角色是能力集合，不是身份标签；同一个账号可以在 A 租户是 `tenant_admin`，在 B 租户是 `end_user`。
- `tenant_owner` 和 `tenant_admin` 可在页面上统称“租户管理员”，但接口鉴权必须保留更高权限能力。
- `knowledge_admin` 如果未来出现，只作为 `tenant_admin` 的产品文案别名；底层不再新增一套平行角色。
- 当前线上兼容角色 `enterprise_admin` / `team_admin` / `data_admin` 按租户管理员能力处理；后续迁移到目标态角色时，必须保留兼容映射直到数据库和前端全部清理完成。
- 当前线上兼容角色 `user` 按普通用户处理，目标态应统一为 `end_user`。

### 2.2 租户成员关系

```sql
CREATE TABLE app_user (
    id                   VARCHAR(64) PRIMARY KEY,
    email                VARCHAR(128) UNIQUE NOT NULL,
    name                 VARCHAR(128),
    avatar_url           TEXT,
    password_hash        VARCHAR(256),
    auth_provider        VARCHAR(32),       -- email / sso_oidc / sso_saml
    sso_subject          VARCHAR(256),
    last_active_tenant   VARCHAR(64),
    status               VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant (
    id             VARCHAR(64) PRIMARY KEY,
    name           VARCHAR(128) NOT NULL,
    slug           VARCHAR(64) UNIQUE NOT NULL,
    domain         VARCHAR(128),
    plan           VARCHAR(32) NOT NULL DEFAULT 'enterprise',
    status         VARCHAR(16) NOT NULL DEFAULT 'active',
    settings       JSONB NOT NULL DEFAULT '{}',
    branding       JSONB NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant_member (
    id             UUID PRIMARY KEY,
    tenant_id      VARCHAR(64) NOT NULL REFERENCES tenant(id),
    user_id        VARCHAR(64) NOT NULL REFERENCES app_user(id),
    roles          TEXT[] NOT NULL,
    attributes     JSONB NOT NULL DEFAULT '{}',
    status         VARCHAR(16) NOT NULL DEFAULT 'active',
    invited_by     VARCHAR(64),
    invited_at     TIMESTAMPTZ,
    joined_at      TIMESTAMPTZ,
    last_seen_at   TIMESTAMPTZ,
    UNIQUE (tenant_id, user_id)
);
```

`attributes` 用于后续 ABAC，例如：

```json
{
  "department": "sales",
  "region": "east",
  "allowed_kb_tags": ["sales", "product"]
}
```

### 2.3 知识库授权

普通用户的数据边界落在知识库和文档两个层级：

```sql
CREATE TABLE knowledge_base_acl (
    id          UUID PRIMARY KEY,
    tenant_id   VARCHAR(64) NOT NULL,
    kb_id       VARCHAR(64) NOT NULL,
    subject_type VARCHAR(16) NOT NULL, -- user / role / group
    subject_id   VARCHAR(128) NOT NULL,
    permission   VARCHAR(16) NOT NULL, -- read / write / manage
    created_by   VARCHAR(64),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, kb_id, subject_type, subject_id, permission)
);
```

权限解释：

| 权限 | 能力 |
| --- | --- |
| `read` | 查看知识库、检索、提问、查看引用 |
| `write` | 上传文档、重处理文档、编辑标签 |
| `manage` | 修改知识库配置、授权成员、删除知识库 |

检索链路必须在拿 chunk 之前过滤：

```
current_user
  ↓
resolve tenant + roles + kb_acl
  ↓
allowed_kb_ids
  ↓
query rewrite / embedding
  ↓
hybrid search WHERE tenant_id = ? AND kb_id IN (...)
  ↓
rerank / context assembly / answer generation
```

### 2.4 邀请机制

当前远端数据库只有 `tenant_member.invited_by`、`tenant_member.invited_at` 字段，没有独立 invitation / invite token 表，且当前 3 个成员邀请字段均为空。因此“邀请机制全部有效”必须作为独立闭环补齐，而不是只在成员表里补两个字段。

目标数据模型：

```sql
CREATE TABLE tenant_invitation (
    id              UUID PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenant(id),
    email           VARCHAR(128) NOT NULL,
    roles           TEXT[] NOT NULL,
    kb_grants       JSONB NOT NULL DEFAULT '[]',
    token_hash      VARCHAR(256) NOT NULL UNIQUE,
    status          VARCHAR(16) NOT NULL DEFAULT 'pending',
    invited_by      UUID NOT NULL REFERENCES app_user(id),
    accepted_by     UUID REFERENCES app_user(id),
    expires_at      TIMESTAMPTZ NOT NULL,
    accepted_at     TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email, status)
);
```

邀请流程：

```text
租户管理员创建邀请
  ↓
校验 tenant scope 与可分配角色
  ↓
写 tenant_invitation(token_hash)，只把明文 token 放进邮件/复制链接
  ↓
受邀人打开 /invite/{token}
  ↓
校验 token hash、过期时间、状态、租户状态
  ↓
已有账号：绑定 tenant_member
无账号：先创建 app_user，再绑定 tenant_member
  ↓
写 knowledge_base_acl 或成员属性 grants
  ↓
邀请标记 accepted，写 audit_log
```

邀请硬规则：

- 租户管理员只能邀请到自己当前租户，不能在请求体里指定任意 `tenant_id`。
- 租户管理员不能邀请 `super_admin`，也不能授予全局系统权限。
- 邀请链接只存 hash，不在数据库保存明文 token。
- 邀请必须支持重发、撤销、过期、接受后幂等处理。
- 接受邀请后必须立即生效：`/api/me` 返回新租户成员关系、角色、权限和知识库 ACL。
- 邀请创建、重发、撤销、接受、角色变更都必须写 `audit_log`。

---

## 3. 权限矩阵

| 功能 | `super_admin` | `tenant_owner` | `tenant_admin` | `end_user` | `viewer` |
| --- | --- | --- | --- | --- | --- |
| 查看全平台租户列表 | 是 | 否 | 否 | 否 | 否 |
| 创建 / 停用 / 归档租户 | 是 | 否 | 否 | 否 | 否 |
| 配置全局 LLM / Embedding / Reranker | 是 | 否 | 否 | 否 | 否 |
| 查看全局系统健康和任务队列 | 是 | 否 | 否 | 否 | 否 |
| 查看全量审计日志 | 是 | 否 | 否 | 否 | 否 |
| 查看本租户审计日志 | 是 | 是 | 是 | 否 | 否 |
| 修改租户安全设置 / SSO | 是 | 是 | 否 | 否 | 否 |
| 邀请 / 移除成员 | 是 | 是 | 是 | 否 | 否 |
| 修改成员角色 | 是 | 是 | 是 | 否 | 否 |
| 创建 / 删除知识库 | 是 | 是 | 是 | 否 | 否 |
| 上传 / 删除 / 重处理文档 | 是 | 是 | 是 | 否 | 否 |
| 配置切割 / 检索 / 模型参数 | 是 | 是 | 是 | 否 | 否 |
| 查看问答日志 | 是 | 是 | 是 | 仅自己 | 否 |
| 发起文档问答 | 否 | 是 | 是 | 是 | 否 |
| 查看授权知识库 | 是 | 是 | 是 | 是 | 是 |
| 查看回答引用原文 | 否 | 是 | 是 | 是 | 是 |
| 点赞 / 点踩 / 修正反馈 | 否 | 是 | 是 | 是 | 否 |

超级管理员的硬边界：

- 可看元数据、配置、日志、耗时、token、错误栈，不默认展开业务文档原文。
- 不代替普通用户发起问答，避免通过超管身份绕过知识库授权取数。
- 所有配置修改、租户状态变更、权限变更必须写入 `audit_log`。

---

## 4. 认证与角色路由

### 4.1 登录方式

目标态支持三种入口：

```
/login                         本地账号登录
/login/sso?tenant=acme         企业 SSO 登录
/invite/{token}                邀请链接激活
```

登录流程：

```
输入邮箱/SSO
  ↓
验证身份
  ↓
读取 app_user
  ↓
读取 tenant_member 列表
  ↓
单租户成员：进入默认租户
多租户成员：展示租户选择
  ↓
签发 session / JWT
  ↓
按角色跳转默认页面
```

### 4.2 Session 与令牌

| 项 | 默认 |
| --- | --- |
| Access token | 15 分钟 |
| Refresh token | 7 天 |
| Session 时长 | 8 小时滚动续期 |
| 多设备登录 | 允许 |
| 租户切换 | 不重新登录，但清空当前租户缓存 |
| 敏感操作 | 二次确认，后续可接 2FA |

### 4.3 默认跳转

| 当前身份 | 默认入口 | 说明 |
| --- | --- | --- |
| `super_admin` | `/system` | 超级管理员全局页面 |
| `tenant_owner` / `tenant_admin` | `/admin` | 当前已有租户管理员页面 |
| `end_user` | `/chat` | 普通用户问答页面 |
| `viewer` | `/knowledge` | 只读知识库页面，后续可加 |

根路径 `/` 的目标态逻辑：

```text
未登录       → /login
super_admin  → /system
tenant_admin → /admin
end_user     → /chat
viewer       → /knowledge
```

当前独立登录模式下：

```text
未登录访问受保护页面 → /login
登录后按角色进入 /system、/admin、/chat 或 /knowledge
/admin/* 仍作为租户管理员后台，需要管理权限
```

---

## 5. 页面地图

### 5.1 超级管理员页面

超级管理员是平台视角，建议使用独立路由 `/system/*`，避免和当前租户管理员 `/admin/*` 混淆。

```
/system                         全局总览
/system/tenants                 租户列表
/system/tenants/{tenant_id}     租户详情
/system/users                   全局用户
/system/models                  全局模型服务
/system/vector-indexes          向量索引与重建任务
/system/jobs                    解析 / 向量化 / 清理任务队列
/system/audit                   全量审计
/system/settings                系统设置
```

### 5.2 租户管理员页面

复用当前已有 `/admin/*`，这是本租户控制台。

```
/admin                          概览
/admin/knowledge                知识库
/admin/documents                文档管理
/admin/logs                     问答日志
/admin/members                  用户管理
/admin/chunking                 切割策略
/admin/search                   检索参数
/admin/models                   租户模型绑定
```

后续可补：

```
/admin/permissions              知识库授权与角色矩阵
/admin/audit                    本租户审计
/admin/settings                 租户设置 / SSO / 安全
/admin/usage                    用量与配额
```

说明：

- 现有 `/admin/embedding` 和 `/admin/llm` 如果继续保留，只能作为租户级模型绑定或参数覆盖页面，不得展示或修改全局 Provider 密钥。
- 全局模型 Provider、Embedding 维度、Reranker 服务、fallback 顺序属于 `/system/models`，只允许 `super_admin` 访问。
- 后台左侧边栏必须遵循 [后台导航统一契约](../frontend/admin-navigation.md)，不能在 `/system`、`/admin`、`/tenant` 各自维护不同顺序的“知识库”入口。

### 5.3 普通用户页面

普通用户的默认入口是对话，不展示后台导航。

```
/chat                           新对话
/chat/{conversation_id}         会话详情
/knowledge                      我可访问的知识库
/knowledge/{kb_id}              知识库详情（只读）
/history                        我的历史问答
/settings                       个人设置
```

普通用户不可见：

- `/system/*`
- `/admin/*`
- 全局配置、成员管理、LLM 密钥、向量索引、文档删除、权限策略、审计日志

---

## 6. 超级管理员页面设计

### 6.1 整体骨架

对标 Northline 全局管理系统，采用全屏接管式后台。

```text
┌─────────────────────────────────────────────────────────────────────┐
│ DocuMind / System                                      ⋮  超级管理员 │
├──────────────┬──────────────────────────────────────────────────────┤
│ 概览          │                                                      │
│ 租户          │                                                      │
│ 用户          │                  主内容区                             │
│ 模型服务       │                                                      │
│ 向量索引       │                                                      │
│ 任务队列       │                                                      │
│ 审计          │                                                      │
│ 系统设置       │                                                      │
└──────────────┴──────────────────────────────────────────────────────┘
```

设计语言：

- 与现有 `DESIGN.md` 一致：单色、发丝分隔、行式列表、少卡片。
- Stat 卡只展示平台级数字，不做彩色大屏。
- 编辑租户、编辑模型、查看任务详情用右抽屉；危险操作用居中确认模态。

### 6.2 全局总览 `/system`

```text
┌─────────────────────────────────────────────────────────────────┐
│ 系统总览                                      最近 24 小时 ▾       │
├─────────────────────────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐              │
│ │ 18        │ │ 1.2M      │ │ 99.3%     │ │ 42ms      │              │
│ │ 租户数     │ │ 检索次数   │ │ 生成成功率 │ │ P95 检索  │              │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘              │
│                                                                  │
│ 模型服务                                                         │
│ ─────────────────────────────────────────────────────────────── │
│ chat-default        qwen-plus        healthy     18 req/min       │
│ embedding-default   bge-large-zh     healthy     240 chunks/min   │
│ reranker-default    bge-reranker     degraded    p95 890ms        │
│                                                                  │
│ 待关注                                                           │
│ ─────────────────────────────────────────────────────────────── │
│ tenant:acme 向量化队列积压 2,341 个 chunk          [查看任务]       │
│ tenant:beta 本月存储配额使用 86%                    [调整配额]       │
│ 3 次 LLM provider fallback                         [查看日志]       │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3 租户管理 `/system/tenants`

```text
┌────────────────────────────────────────────────────────────────────┐
│ 租户                                             [+ 新建租户]        │
│ 搜索 / 状态 ▾ / 套餐 ▾ / 地域 ▾                                      │
│                                                                    │
│ 名称             状态       成员   知识库  文档数   本月问答  操作     │
│ Acme Corp        active     47     8      12,483   18,203   ⋮       │
│ Beta Industries  suspended  12     3      1,904    2,140    ⋮       │
│ Gamma LLC        trial      4      1      412      98       ⋮       │
└────────────────────────────────────────────────────────────────────┘
```

租户详情抽屉：

- 基本信息：名称、slug、domain、状态、套餐、时区。
- 配额：知识库数、文档数、存储、月问答、并发任务。
- 健康：最近失败任务、解析成功率、索引大小、LLM 调用量。
- 操作：启用/停用、归档、调整配额、查看本租户审计。

### 6.4 全局用户 `/system/users`

用于排查账号和跨租户成员关系，不替代租户内成员管理。

```text
邮箱                  状态      所属租户              最近登录       操作
alice@acme.com        active    Acme(admin), Beta(user)  2h 前        ⋮
ops@documind.local    active    system(super_admin)      10m 前       ⋮
```

可做：

- 禁用账号。
- 重置登录方式。
- 查看该账号的租户成员关系。
- 踢出所有 session。

不可做：

- 直接读取用户的业务文档原文。
- 代替用户发起问答。

### 6.5 模型与索引 `/system/models` `/system/vector-indexes`

页面目标是运维可控：

- Chat LLM Provider：名称、base_url、模型名、健康状态、fallback 顺序。
- Embedding Provider：模型、维度、吞吐、当前索引版本。
- Reranker Provider：模型、延迟、启停。
- 向量索引：租户、知识库、文档数、chunk 数、索引版本、重建状态。

所有密钥只显示尾号，不允许页面回显明文。

---

## 7. 租户管理员页面设计

当前 DocuMind 已有 `/admin` 系列页面，这一层就是 Northline 的“租户管理员后台”在文档 RAG 场景下的映射。

### 7.1 导航

```text
DocuMind

管理
  概览
  知识库
  文档管理
  问答日志
  用户管理

系统配置
  切割策略
  检索参数
  租户模型绑定
  用量与配额
  SSO 与安全

返回对话
```

后续补充：

```text
权限
  知识库授权
  角色矩阵
  自定义角色

租户
  审计日志
  用量与配额
  SSO 与安全
```

### 7.2 概览 `/admin`

```text
┌─────────────────────────────────────────────────────────────────┐
│ Acme Corp / 概览                              本月 ▾              │
├─────────────────────────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐              │
│ │ 12,483    │ │ 47        │ │ 87%       │ │ 1.8s      │              │
│ │ 文档数     │ │ 活跃用户   │ │ 命中率    │ │ P95 回答  │              │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘              │
│                                                                  │
│ 知识库状态                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ 产品文档库        3,201 文档    healthy      今日 1,204 次问答      │
│ 销售资料库        1,044 文档    indexing     231 个 chunk 待向量化   │
│ 人力资源库        328 文档      warning      2 个文档解析失败        │
│                                                                  │
│ 待你关注                                                          │
│ ─────────────────────────────────────────────────────────────── │
│ 6 个文档解析失败                                  [查看文档]         │
│ “产品定价政策” 负反馈 3 次                         [查看日志]         │
│ 向量化模型版本变更后 2 个知识库待重建索引              [开始重建]       │
└─────────────────────────────────────────────────────────────────┘
```

### 7.3 知识库 `/admin/knowledge`

能力：

- 创建、编辑、归档知识库。
- 配置知识库描述、标签、默认切割策略、默认检索策略。
- 查看文档数、chunk 数、问答量、命中率、最近更新时间。
- 进入授权设置：按用户、角色、部门授予 `read/write/manage`。

列表默认用卡片网格或行式列表均可；企业管理场景优先行式密排。

### 7.4 文档管理 `/admin/documents`

能力：

- 上传 Word / PPT / PDF。
- 查看解析、清洗、切割、向量化状态。
- 按知识库、文件类型、状态、上传人筛选。
- 查看文档详情抽屉：元数据、页数、chunk、错误、引用次数。
- 重处理、移动知识库、删除文档。

删除文档必须二次确认并写审计：

```text
删除文档会级联删除 chunks、embedding、检索索引引用。
历史回答保留文本与引用快照，但引用标记为“原文已删除”。
```

### 7.5 用户管理 `/admin/members`

对标 Northline 成员与权限页。

```text
┌─────────────────────────────────────────────────────────────────────┐
│ 用户管理                                          [+ 邀请用户]        │
│ 搜索 / 角色 ▾ / 状态 ▾ / 知识库权限 ▾                                │
│                                                                     │
│ 用户                  角色          可访问知识库        问答数  状态  │
│ 张三 zhang@corp.com    租户管理员     全部                156   启用  │
│ 李四 li@corp.com       普通用户       产品文档库、销售资料库 89    启用  │
│ 王五 wang@corp.com     普通用户       人力资源库           34    启用  │
└─────────────────────────────────────────────────────────────────────┘
```

成员详情抽屉：

- 角色：`tenant_admin` / `end_user` / `viewer`。
- 属性：部门、区域、岗位、SSO claims。
- 知识库授权：read/write/manage 列表。
- 活动：加入时间、最后活跃、月问答数、负反馈数。
- 操作：改角色、重发邀请、停用、移除、踢出 session。

邀请用户抽屉必须包含：

- 邮箱、姓名（可选）、角色。
- 初始知识库授权：全部知识库 / 指定知识库 / 暂不授权。
- 邀请有效期，默认 7 天。
- 发送邀请、复制邀请链接、重发邀请、撤销邀请。

租户管理员可邀请 `tenant_admin`、`end_user`、`viewer`，不可邀请 `super_admin`。

### 7.6 权限策略 `/admin/permissions`

后续新增页面，用于统一管理知识库授权和角色矩阵。

```text
[知识库授权]
知识库             授权对象              权限       操作
产品文档库          role:end_user         read       ⋮
销售资料库          user:li@corp.com      read       ⋮
研发规范库          dept:研发             read       ⋮

[角色矩阵]
权限                    owner admin user viewer
kb.create               ✓     ✓     ✗    ✗
document.upload          ✓     ✓     ✗    ✗
document.delete          ✓     ✓     ✗    ✗
chat.ask                 ✓     ✓     ✓    ✗
answer.feedback          ✓     ✓     ✓    ✗
audit.read               ✓     ✓     ✗    ✗
```

---

## 8. 普通用户页面设计

普通用户页面只服务一个目标：在授权知识库范围内高质量问答。不要把管理概念暴露给用户。

### 8.1 对话页 `/chat`

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Sidebar                         │ Main                                 │
│ DocuMind                        │                                      │
│ [+ 新对话]                      │  向你的文档提问                         │
│                                │                                      │
│ 知识库                          │  当前知识库：产品文档库 ▾                 │
│  产品文档库                      │                                      │
│  销售资料库                      │  ┌────────────────────────────────┐  │
│  人力资源库                      │  │ 用户问题                         │  │
│                                │  └────────────────────────────────┘  │
│ 今天                            │                                      │
│  销售政策里的折扣上限             │  ┌────────────────────────────────┐  │
│  Q3 合同模板变化                 │  │ 回答                             │  │
│                                │  │                                  │  │
│ 更早                            │  │ 引用来源                          │  │
│  入职材料汇总                    │  │ 1. 产品定价政策.pdf / p.12        │  │
│                                │  │ 2. 销售合同模板.docx / 第 4 节     │  │
│                                │  └────────────────────────────────┘  │
│                                │                                      │
│ 个人设置                         │  [ 继续追问或输入新问题...        ↑ ]    │
└────────────────────────────────────────────────────────────────────────┘
```

普通用户可见模块：

| 模块 | 能力 |
| --- | --- |
| 新对话 | 选择知识库或使用“全部授权知识库”提问 |
| 历史会话 | 仅自己的会话，支持搜索、收藏、删除 |
| 知识库切换 | 只展示授权知识库 |
| 回答引用 | 展示文档名、页码、标题路径、原文片段 |
| 反馈 | 点赞、点踩、补充正确答案、标记引用错误 |
| 个人设置 | 名称、头像、语言、退出登录 |

普通用户不可见：

- 文档上传、删除、重处理。
- 切割策略、Embedding、Reranker、LLM 配置。
- 成员管理、权限策略、审计日志。
- 未授权知识库的名称、文档名、chunk、引用。

### 8.2 知识库只读页 `/knowledge`

用于让用户知道“我能问什么”，不是管理页。

```text
┌────────────────────────────────────────────────────────────────────┐
│ 我可访问的知识库                                                     │
│                                                                    │
│ 产品文档库       3,201 文档    最近更新 2 小时前     [开始提问]       │
│ 销售资料库       1,044 文档    最近更新 昨天          [开始提问]       │
│ 人力资源库       328 文档      最近更新 3 天前        [开始提问]       │
└────────────────────────────────────────────────────────────────────┘
```

知识库详情：

- 展示简介、标签、最近更新文档。
- 可搜索文档标题和摘要。
- 不展示管理操作。
- 如果文档被管理员设置为不可直接浏览，只显示“可用于问答”，不显示文档列表。

### 8.3 历史问答 `/history`

```text
搜索历史...

今天
  产品定价政策里的大客户折扣上限是什么？
  销售合同模板里违约责任怎么写？

本周
  新员工入职材料需要准备哪些文件？
```

约束：

- 只查自己的会话。
- 如果会话引用的知识库权限被收回，历史回答仍可看，但重新追问时必须按当前权限重新检索。
- 如果引用文档被删除，展示“原文已删除”的引用状态。

---

## 9. 接口鉴权设计

### 9.1 请求上下文

所有业务接口统一解析：

```rust
pub struct CurrentActor {
    pub user_id: String,
    pub tenant_id: Option<String>,
    pub roles: Vec<String>,
    pub permissions: Vec<String>,
    pub allowed_kb_ids: Vec<String>,
    pub is_super_admin: bool,
}
```

接口层只接收 `CurrentActor`，不从请求 body 信任 `tenant_id`、`user_id`、`roles`。

### 9.2 中间件顺序

```text
request
  ↓
load session / jwt
  ↓
load user
  ↓
resolve tenant
  ↓
resolve roles + permissions
  ↓
resolve knowledge_base_acl
  ↓
handler
```

### 9.3 常用鉴权函数

```rust
require_super_admin(&actor)?;
require_tenant_admin(&actor)?;
require_permission(&actor, "document.upload")?;
require_kb_permission(&actor, kb_id, "read")?;
```

### 9.4 API 权限分组

| API | 角色 |
| --- | --- |
| `GET /api/health` | 匿名 |
| `POST /api/auth/login` | 匿名 |
| `GET /api/me` | 登录用户 |
| `GET /api/system/*` | `super_admin` |
| `GET /api/admin/*` | `tenant_admin` 及以上 |
| `POST /api/admin/documents` | `document.upload` |
| `DELETE /api/admin/documents/{id}` | `document.delete` |
| `POST /api/chat` | `chat.ask` + 知识库 `read` |
| `GET /api/conversations` | 登录用户，仅自己 |
| `GET /api/knowledge-bases` | 登录用户，按 ACL 过滤 |

---

## 10. 审计与安全

必须审计：

- 登录成功 / 失败 / 登出。
- 租户创建、停用、归档、配额调整。
- 成员邀请、移除、角色变更。
- 知识库创建、删除、授权变更。
- 文档上传、删除、重处理。
- LLM / Embedding / 检索参数修改。
- 超级管理员查看租户详情、导出日志、修改全局配置。

审计字段：

```sql
CREATE TABLE audit_log (
    id            UUID PRIMARY KEY,
    tenant_id     VARCHAR(64),
    actor_user_id VARCHAR(64),
    actor_role    VARCHAR(64),
    action        VARCHAR(128) NOT NULL,
    resource_type VARCHAR(64),
    resource_id   VARCHAR(128),
    ip            VARCHAR(64),
    user_agent    TEXT,
    detail        JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

安全红线：

- 任何检索、文档列表、引用详情都必须带 `tenant_id` 和 ACL 过滤。
- 普通用户不能通过 URL 猜测访问未授权知识库或文档。
- 超级管理员默认不能展开业务文档原文，除非进入受审计的“授权排障模式”。
- API 返回前再做一次资源归属校验，避免 handler 内部误传 ID。

---

## 11. MVP 落地顺序

第一阶段：角色模拟与页面分流

- 定义 `CurrentActor`。
- 用本地配置或请求头模拟 `super_admin` / `tenant_admin` / `end_user`。
- 新增 `/system` 页面壳和导航。
- 保留当前 `/admin` 租户管理员页面。
- `/chat` 按普通用户视角收敛，不出现管理入口。

第二阶段：正式账号与租户成员

- 建 `app_user`、`tenant`、`tenant_member`。
- 增加 `/login`、`/api/auth/login`、`/api/me`。
- 根路径按角色跳转。
- `/admin/members` 接真实成员数据。

第三阶段：知识库 ACL

- 建 `knowledge_base_acl`。
- 知识库列表、文档列表、检索链路全部按 ACL 过滤。
- `/admin/permissions` 支持按角色/用户授权知识库。

第四阶段：SSO、审计与高级安全

- 接 OIDC/SAML。
- 完整审计日志。
- Session 管理、踢出设备、敏感操作二次确认。
- 超管授权排障模式。

---

## 12. 与 Northline 的映射关系

| Northline | DocuMind |
| --- | --- |
| 数据源 | 知识库 / 文档来源 |
| 表 / 列 / 指标 | 文档 / chunk / 引用片段 |
| NDL / 语义层 | 文档解析结构、chunk 策略、检索配置 |
| 问数对话 | 文档问答对话 |
| 数据权限 | 知识库 ACL + 文档访问范围 |
| 租户管理员后台 `/admin` | DocuMind 当前 `/admin` |
| 普通用户 `/chat` | DocuMind `/chat` |
| 全局管理系统 | DocuMind `/system` |

---

## 相关文档

- [权限控制](./access-control.md)
- [知识库管理](../5-knowledge-base/knowledge-base.md)
- [产品需求文档](../prd.md)
- [设计系统](../../DESIGN.md)

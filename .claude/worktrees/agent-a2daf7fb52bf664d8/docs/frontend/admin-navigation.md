# 后台导航统一契约

本文规定 DocuMind 后台左侧边栏的统一口径，解决“同一后台里知识库位置变化、不同页面边栏不一致”的问题。

## 远端与代码现状（2026-06-28）

基于当前工作区代码和 `ssh documind` 真实环境核验：

- `Anner` 远端登录成功，角色为 `super_admin`，可访问 `/api/system/users`、`/api/system/models`、`/api/admin/knowledge-bases`、`/api/admin/documents?limit=1`。
- `admin@documind.local` 角色为 `enterprise_admin`，可访问 `/api/admin/knowledge-bases`，访问 `/api/system/models` 返回 403。
- `user@documind.local` 角色为 `user`，访问 `/api/admin/knowledge-bases` 和 `/api/system/models` 均返回 403。
- 代码中当前存在 `AdminSidebar`、`SystemSidebar`、`TenantSidebar`、`ChatSidebar` 多套入口，且 `/system` 侧栏又包含“知识库后台”快捷组，容易造成知识库入口在不同页面位置不一致。

## 统一原则

- 所有后台页面只使用一份菜单模型，按角色过滤可见项；页面组件不得自己临时拼装侧栏。
- 同一个菜单项在所有后台上下文中必须保持相同 label、icon、href 和相对顺序。
- `知识库` 永远位于“知识库后台”分组第一项，`文档管理` 永远紧随其后。
- 全局系统项与租户后台项必须分组清晰，不允许把“模型服务”这类全局配置混入普通租户管理员的可操作菜单。
- 普通用户没有后台左侧边栏，只保留对话历史、授权知识库和个人设置。

## 菜单分组

目标态侧栏按以下顺序渲染。

```text
DocuMind

系统全局（仅 super_admin）
  系统概览        /system
  租户            /system/tenants
  全局用户        /system/users
  模型服务        /system/models
  向量索引        /system/vector-indexes
  任务队列        /system/jobs
  全量审计        /system/audit
  系统设置        /system/settings

知识库后台（super_admin + 租户管理员）
  租户概览        /admin
  知识库          /admin/knowledge
  文档管理        /admin/documents
  问答日志        /admin/logs
  用户管理        /admin/members
  权限策略        /admin/permissions

租户配置（租户管理员可见，super_admin 可代管）
  切割策略        /admin/chunking
  检索参数        /admin/search
  租户模型绑定    /admin/models
  用量与配额      /admin/usage
  SSO 与安全      /admin/settings

返回对话          /chat
```

## 角色可见性

| 菜单分组 | `super_admin` | 租户管理员 | 普通用户 |
|---|---|---|---|
| 系统全局 | 可见，可操作 | 不可见 | 不可见 |
| 知识库后台 | 可见，必须带租户 scope | 可见，可管理本租户 | 不可见 |
| 租户配置 | 可见，必须带租户 scope | 可见，限租户级配置 | 不可见 |
| 返回对话 | 可见 | 可见 | 不使用后台侧栏 |

租户管理员包括目标态 `tenant_owner` / `tenant_admin`，以及当前线上兼容角色 `enterprise_admin` / `team_admin` / `data_admin`。

## 配置边界

- `/system/models` 是全局模型服务，只有 `super_admin` 可见和可操作。
- `/admin/models` 或现有 `/admin/embedding`、`/admin/llm` 只能表达“本租户使用哪个已授权模型配置、知识库默认模型绑定、租户级参数覆盖”，不能回显或修改全局密钥。
- `/admin/chunking`、`/admin/search` 属于租户知识库后台，租户管理员可以配置本租户知识库的解析、切割和检索参数。
- `/system/vector-indexes` 是全局索引运维；租户管理员只能在知识库或文档页面触发本租户范围内的重建、重解析和排障动作。

## 验收标准

- 从 `/admin`、`/admin/knowledge`、`/admin/documents`、`/admin/members` 任意页面进入，左侧边栏分组和顺序完全一致。
- 从 `/system` 任意页面进入，若展示知识库后台快捷入口，其 label、href、icon、顺序必须与 `/admin` 保持一致。
- `Anner` 登录后可看到系统全局与知识库后台入口。
- 租户管理员登录后不可看到系统全局入口，尤其不可看到 `/system/models`。
- 普通用户登录后不可看到任何 `/admin/*` 或 `/system/*` 入口，直接访问 API 返回 403。

# 外部 API 接入

租户管理员在 `/admin/api-clients` 创建外部应用，并为应用选择可访问知识库。Token 仅在创建时返回一次，服务端只保存 SHA-256 哈希。

## 认证

```http
Authorization: Bearer dm_live_<token-id>_<secret>
```

Token 不得放在 URL、日志或浏览器前端代码中。Token 的实际权限是 API Client scopes、租户成员权限与知识库 ACL 的交集。

## API

正式入口以部署 base path 为准，例如：

```text
http://<server>:8089/documind/api/v1/external
```

- `GET /me`：Token、租户、scope 和知识库身份
- `GET /knowledge-bases`：已授权知识库
- `GET|POST /conversations`：会话列表和创建
- `GET /conversations/{id}`：会话详情
- `GET|POST /conversations/{id}/messages`：消息列表和 SSE 真实问答
- `GET /conversations/{id}/messages/{message_id}/traces`：问答 trace

外部会话严格绑定 API Client 的服务身份。其他 API Client 或其他租户即使得到会话 UUID，也只能收到 `404 CONVERSATION_NOT_FOUND`。

## CLI

```bash
# 管理员创建
DOCUMIND_PASSWORD=... documind api-clients create --name crm --kb <kb-id> --json

# 外部调用
export DOCUMIND_API_TOKEN=dm_live_...
documind external doctor
documind external chat --kb <kb-id> --json '问题'

# 自动真实验收；可传另一个租户管理员配置验证跨租户隔离
documind external verify --kb <kb-id> --denied-kb <kb-id> \
  --other-config /path/to/other-tenant.toml --json
```

`external verify` 自动覆盖真实流式问答、知识库隔离、Token 轮换与吊销、应用停用与恢复、Redis 限流、跨租户会话隔离和测试资源停用清理。

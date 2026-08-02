---
title: DocuMind 第三方系统 API 接入说明书
subtitle: 面向客户研发、集成与运维人员的认证、问答调用和安全接入指南
version: V1.0
scenario: 第三方业务系统服务端集成
---

# DocuMind 第三方系统 API 接入说明书

> [!重要] 本说明书描述 DocuMind 当前已提供的第三方系统 API。API Token 属于高敏感凭据，只能保存在第三方系统服务端或受控密钥系统中，不得写入浏览器前端、移动端安装包、URL、代码仓库、日志或本文档。

## 文档目的

DocuMind 支持客户的 CRM、OA、门户、客服、业务工作台及其他内部系统通过 API 使用企业知识问答能力。第三方系统无需模拟用户登录，而是由租户管理员为每个接入方创建独立 API Client，授权指定知识库和功能范围，再通过专用 Token 调用外部 API。

本文说明：

- 接入前需要准备哪些信息。
- 如何创建 API Client、保存 Token 和验证身份。
- 如何查询授权知识库、创建会话并进行流式问答。
- 如何读取历史消息、引用和检索轨迹。
- Token、Scope、知识库授权和租户隔离如何共同限制访问。
- 如何处理限流、超时、吊销、轮换和常见错误。
- 上线前应完成哪些联调和安全验收。

本文只描述第三方业务调用接口。租户、成员、文档上传和知识库内容维护仍由 DocuMind 管理页面或已授权的管理能力完成，不属于外部 API Token 的默认范围。

## 适用架构

推荐由第三方系统后端调用 DocuMind，用户浏览器只访问第三方系统自己的页面。

```flow
终端用户|使用|第三方业务系统页面
第三方业务系统页面|提交业务请求|第三方系统后端
第三方系统后端|携带 API Token|DocuMind 外部 API
DocuMind 外部 API|在授权知识库内|检索与智能问答
DocuMind 外部 API|流式返回|答案、引用与处理事件
```

禁止将 API Token 下发到浏览器后直接调用 DocuMind。服务端代理便于统一保护密钥、控制调用来源、记录业务审计、处理限流和按需隐藏内部字段。

## 能力范围

当前外部 API 提供以下能力：

| 能力 | 用途 |
|---|---|
| 接入身份查询 | 确认 API Client、租户、Scope、知识库范围和 Token 到期时间 |
| 知识库列表 | 获取当前 API Client 被授权访问的有效知识库 |
| 会话创建与查询 | 为业务用户或业务流程建立独立多轮会话并查询历史 |
| 流式问答 | 通过 SSE 接收处理阶段、增量答案、引用和完成事件 |
| 消息查询 | 获取会话中已持久化的用户消息、助手回答和引用 |
| Trace 查询 | 获取指定回答的 Agent、问题改写和检索轨迹，供诊断与效果分析 |

当前外部 API 不提供租户管理、成员管理、文档上传、文档删除、知识库配置或平台管理能力。第三方系统不应尝试使用外部 Token 调用 `/api/admin/*` 或平台接口。

## 接入前准备

客户项目负责人、DocuMind 租户管理员和第三方系统研发人员应共同确认：

| 项目 | 需要确认的内容 |
|---|---|
| DocuMind 地址 | 正式环境域名、HTTPS 证书、base path 和网络访问策略 |
| 接入系统 | 系统名称、用途、负责人、部署环境和调用出口地址 |
| 知识范围 | 允许访问的知识库清单，不应默认授权租户全部知识库 |
| 功能范围 | 是否需要知识库查询、问答写入和历史会话读取 |
| 调用容量 | 预计每分钟请求数、并发问答数和超时要求 |
| Token 管理 | 密钥保存位置、轮换周期、应急吊销流程和责任人 |
| 数据合规 | 问题、答案、引用和日志允许保存的范围及保留期限 |

正式环境建议使用 HTTPS。数据库、Elasticsearch、MinIO、Redis、RabbitMQ 和模型服务不需要向第三方系统开放。

## API 地址

外部 API 根路径为：

```text
https://<DocuMind域名>/<base-path>/api/v1/external
```

例如 DocuMind 部署在 `/documind` 下：

```text
https://knowledge.example.com/documind/api/v1/external
```

本文示例使用以下占位变量：

```bash
export DOCUMIND_BASE_URL='https://knowledge.example.com/documind'
export DOCUMIND_API_TOKEN='dm_live_请替换为真实Token'
export KB_ID='请替换为授权知识库UUID'
```

不要把真实 Token 写入脚本并提交代码仓库。生产环境应从操作系统环境变量或企业密钥管理服务读取。

## 创建 API Client

### 管理入口

租户管理员登录 DocuMind 后，进入“API 接入”页面创建应用。每个第三方系统、环境或安全边界建议使用独立 API Client，例如：

- `crm-production`
- `crm-test`
- `oa-production`

不要让生产与测试环境共用 Token，也不要让多个无关系统共用同一 API Client。

### 创建参数

| 参数 | 规则 | 建议 |
|---|---|---|
| 应用名称 | 同一租户内唯一，长度 1 至 128 个字符 | 使用“系统名-环境”命名 |
| 描述 | 说明用途和责任方 | 写明业务场景与负责人，不记录密钥 |
| 知识库 | 至少选择一个当前租户的有效知识库 | 按最小权限授权 |
| Scope | 只能选择当前支持的 Scope | 只启用实际需要的能力 |
| Token 有效期 | 1 至 365 天 | 建议 30 至 90 天并定期轮换 |
| 每分钟限额 | 1 至 10000 | 根据真实容量设置，初期从小值开始 |

创建 API Client 时，系统同时建立独立的服务身份、知识库只读授权和首个 Token。不同 API Client 的会话彼此隔离。

### Token 只显示一次

完整 Token 仅在创建 API Client 或创建新 Token 时返回一次。DocuMind 服务端只保存 Token 的 SHA-256 哈希和用于识别的前缀，之后无法恢复完整明文。

管理员应在创建后立即把 Token 写入受控密钥系统。如果 Token 丢失，不应查询数据库或日志恢复，应创建新 Token、更新第三方系统配置并吊销旧 Token。

Token 格式类似：

```text
dm_live_<token-id>_<secret>
```

第三方系统不得解析或依赖 Token 内部字段。整个字符串必须作为不可拆分的凭据保存和发送。

## 认证方式

所有外部 API 请求使用标准 Bearer Header：

```http
Authorization: Bearer dm_live_<token-id>_<secret>
```

JSON 请求同时使用：

```http
Accept: application/json
Content-Type: application/json
```

流式问答使用：

```http
Accept: text/event-stream
Content-Type: application/json
```

Token 不得放在 URL 查询参数、Cookie、自定义跳转链接或页面源码中。DocuMind 不会把外部 Token 自动刷新为新 Token；到期或轮换需要第三方系统更新配置。

## 权限计算逻辑

一次外部请求的实际权限由以下条件共同决定：

```flow
API Token 状态|限制|API Client 是否可用
API Client Scope|限制|允许调用的功能
服务身份权限|限制|可执行的业务操作
知识库 ACL|限制|可访问的知识范围
租户标识|限制|所有数据查询与会话归属
```

只要任一条件不满足，请求就会被拒绝。拥有 `chat:write` 不表示可以访问租户全部知识库；拥有某个知识库授权也不表示可以调用未授予的功能。

### 支持的 Scope

| Scope | 允许能力 |
|---|---|
| `knowledge_bases:read` | 查询当前 API Client 被授权的知识库 |
| `chat:write` | 创建会话并向会话发送问题 |
| `conversations:read` | 查询会话列表、会话详情、历史消息和回答 Trace |

创建时未指定 Scope，系统默认授予以上三项。正式接入仍建议由管理员根据用途主动确认，不依赖默认值。

## API 快速验证

### 查询当前接入身份

```bash
curl -sS \
  -H "Authorization: Bearer ${DOCUMIND_API_TOKEN}" \
  -H 'Accept: application/json' \
  "${DOCUMIND_BASE_URL}/api/v1/external/me"
```

成功响应示例：

```json
{
  "client_id": "11111111-1111-1111-1111-111111111111",
  "client_name": "crm-production",
  "tenant_id": "22222222-2222-2222-2222-222222222222",
  "scopes": ["chat:write", "conversations:read", "knowledge_bases:read"],
  "allowed_kb_ids": ["33333333-3333-3333-3333-333333333333"],
  "token_expires_at": "2026-10-31T00:00:00Z"
}
```

第三方系统启动或发布验收时，应检查：

- `client_name` 与预期接入应用一致。
- `tenant_id` 与目标租户一致。
- `scopes` 包含所需能力且没有多余能力。
- `allowed_kb_ids` 与批准的知识库清单一致。
- `token_expires_at` 留有足够有效期。

## 查询授权知识库

### 请求

```bash
curl -sS \
  -H "Authorization: Bearer ${DOCUMIND_API_TOKEN}" \
  -H 'Accept: application/json' \
  "${DOCUMIND_BASE_URL}/api/v1/external/knowledge-bases"
```

### 响应字段

| 字段 | 说明 |
|---|---|
| `id` | 知识库 UUID，创建会话和问答时使用 |
| `name` | 知识库名称 |
| `description` | 知识库说明，可能为空 |
| `status` | 当前状态；接口只返回有效知识库 |
| `tags` | 知识库标签 |
| `updated_at` | 知识库最后更新时间 |

第三方系统应从该接口获得可用知识库，不应在代码中长期硬编码未经验证的 UUID。若业务固定使用一个知识库，可以在启动检查时确认该 UUID 仍位于返回列表中。

## 会话模型

会话用于保存多轮问题、回答和引用。建议按第三方系统中的实际交互单元建立会话：

- 一个用户的一次连续咨询使用一个会话。
- 新主题、新工单或新的业务上下文创建新会话。
- 不同最终用户不要长期共用同一个会话，否则历史上下文可能互相影响。

外部会话同时绑定租户和 API Client 的服务身份。其他 API Client、其他租户或普通用户即使获得会话 UUID，也不能读取该会话。

## 创建会话

### 请求

```bash
curl -sS \
  -X POST \
  -H "Authorization: Bearer ${DOCUMIND_API_TOKEN}" \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -d "{\"kb_ids\":[\"${KB_ID}\"],\"title\":\"CRM 客户咨询\"}" \
  "${DOCUMIND_BASE_URL}/api/v1/external/conversations"
```

请求体：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `kb_ids` | UUID 数组 | 是 | 本会话允许使用的知识库，必须位于 API Client 授权范围内 |
| `title` | 字符串 | 否 | 会话初始标题；未填写时使用系统默认标题 |

成功响应示例：

```json
{
  "conversation_id": "44444444-4444-4444-4444-444444444444",
  "title": "CRM 客户咨询",
  "kb_ids": ["33333333-3333-3333-3333-333333333333"],
  "created_at": "2026-08-02T09:00:00Z"
}
```

第三方系统应保存 `conversation_id` 与自身用户、工单或业务记录的映射，但不得把该 UUID 当作访问凭据。每次请求仍必须携带 API Token。

## 发起流式问答

### 请求

向会话消息接口发送问题，响应类型为 Server-Sent Events（SSE）：

```bash
export CONVERSATION_ID='44444444-4444-4444-4444-444444444444'

curl -N -sS \
  -X POST \
  -H "Authorization: Bearer ${DOCUMIND_API_TOKEN}" \
  -H 'Accept: text/event-stream' \
  -H 'Content-Type: application/json' \
  -d "{\"content\":\"采购合同的付款条件是什么？\",\"kb_ids\":[\"${KB_ID}\"],\"client_request_id\":\"crm-order-20260802-0001\",\"stream\":true}" \
  "${DOCUMIND_BASE_URL}/api/v1/external/conversations/${CONVERSATION_ID}/messages"
```

请求体：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `content` | 字符串 | 是 | 用户问题；去除空白后不能为空 |
| `kb_ids` | UUID 数组 | 否 | 本轮使用的知识库，必须同时属于会话范围和 API Client 授权范围 |
| `client_request_id` | 字符串 | 否 | 第三方请求标识，用于识别重复提交；应在接入方范围内保持唯一 |
| `stream` | 布尔值 | 否 | 建议传 `true`；当前消息接口以 SSE 返回处理结果 |

### 主要 SSE 事件

默认 SSE 协议会返回以下主要事件：

| 事件 | 含义 | 第三方系统处理建议 |
|---|---|---|
| `message.created` | 用户消息和助手消息记录已经创建 | 保存返回的消息 ID |
| `status.updated` | 回答状态发生变化 | 更新界面状态，不作为最终答案 |
| `rewrite.completed` | 问题理解或改写完成 | 可用于调试，普通用户界面可不展示 |
| `retrieval.completed` | 候选知识检索完成 | 可用于处理进度展示 |
| `rerank.completed` | 候选片段重排完成 | 可用于处理进度展示 |
| `answer.delta` | 收到一段增量答案 | 按事件顺序追加到当前答案 |
| `citation.delta` | 收到一条引用 | 按引用序号去重并保存 |
| `answer.completed` | 本轮问答成功完成 | 结束加载状态，并读取最终状态或持久化消息 |
| `answer.failed` | 本轮问答失败 | 停止流式展示，记录错误并按策略重试 |
| `conversation.title.updated` | 系统更新了会话标题 | 可同步第三方会话标题 |

SSE 客户端必须按事件边界解析，不能假设一次网络读取等于一个完整事件。连接结束后，建议调用消息查询接口取得服务端最终持久化结果，避免只依赖内存中拼接的增量文本。

### 服务端 JavaScript 示例

以下示例使用 Node.js 原生 `fetch`，不需要额外 SDK：

```javascript
const response = await fetch(
  `${process.env.DOCUMIND_BASE_URL}/api/v1/external/conversations/${conversationId}/messages`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DOCUMIND_API_TOKEN}`,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: question,
      kb_ids: [process.env.DOCUMIND_KB_ID],
      client_request_id: requestId,
      stream: true,
    }),
  },
);

if (!response.ok || !response.body) {
  throw new Error(`DocuMind request failed: ${response.status}`);
}

for await (const chunk of response.body) {
  process.stdout.write(new TextDecoder().decode(chunk));
}
```

生产代码还应增加 SSE 分帧、JSON 解析、超时、断线处理和业务日志脱敏。只有在确认请求没有被服务端接受时才自动重试；连接中断后应先查询会话消息，避免生成重复回答。

## 查询会话和消息

### 会话列表

```http
GET /api/v1/external/conversations?limit=20&cursor=<next_cursor>
```

响应包含 `items` 和可选的 `next_cursor`。第三方系统应使用游标翻页，不应自行拼接数据库偏移量。

### 会话详情

```http
GET /api/v1/external/conversations/{conversation_id}
```

返回会话标题、知识库范围、状态、摘要和创建更新时间。

### 消息列表

```http
GET /api/v1/external/conversations/{conversation_id}/messages
```

助手消息主要字段：

| 字段 | 说明 |
|---|---|
| `message_id` | 消息 UUID |
| `role` | `user` 或 `assistant` |
| `content` | 最终持久化文本 |
| `status` | `created`、`answering`、`completed`、`failed` 或 `cancelled` |
| `confidence` | 置信等级，可能为空 |
| `no_answer_reason` | 无法回答的原因，可能为空 |
| `citations` | 原文引用数组 |
| `parent_message_id` | 助手消息对应的用户消息 |
| `created_at` / `completed_at` | 创建和完成时间 |

### 引用字段

| 字段 | 说明 |
|---|---|
| `index` | 回答中的引用序号 |
| `doc_id` | 来源文档 UUID |
| `chunk_id` | 来源切片 UUID |
| `doc_title` | 来源文档标题 |
| `page_range` | 来源页码范围，文本类文档可能为空 |
| `quote` | 支撑回答的原文片段 |
| `source_status` | 引用来源当前状态 |
| `anchor` | 可选的页码、幻灯片、坐标或字符范围定位信息 |

第三方系统展示答案时应同时展示引用入口。涉及合同、制度、财务、法律或安全信息时，应引导用户查看原文，而不是只展示模型生成文本。

## 查询问答 Trace

```http
GET /api/v1/external/conversations/{conversation_id}/messages/{assistant_message_id}/traces
```

该接口需要 `conversations:read` Scope，返回：

| 字段 | 内容 |
|---|---|
| `agent_trace` | Agent 模式、模型、提示词版本、工具步骤和 token 使用等信息 |
| `query_trace` | 原问题、改写问题、关键词、引用消解和实际知识库范围 |
| `retrieval_traces` | Dense、BM25、RRF 和 Rerank 等阶段的候选片段、排名及分数 |

Trace 适合联调、效果评估和问题排查，不建议原样展示给普通最终用户。Trace 中可能包含文档片段，应按业务数据同等级保护。

## Token 生命周期管理

### 新建与轮换

一个 API Client 可以创建多个 Token。推荐零中断轮换流程：

1. 租户管理员为现有 API Client 创建新 Token。
2. 将新 Token 写入第三方系统的受控密钥配置。
3. 重启或热更新第三方服务，并调用 `/me` 验证新 Token。
4. 观察新 Token 的最后使用时间，确认流量已经切换。
5. 吊销旧 Token。
6. 再次确认旧 Token 返回 `401 API_TOKEN_REVOKED`。

不要先吊销旧 Token 再部署新 Token，除非正在处理凭据泄露。

### 停用 API Client

停用 API Client 后，该 Client 下所有 Token 立即无法使用并返回 `401 API_CLIENT_DISABLED`。停用适用于系统下线、安全事件或暂时禁止整个接入方访问。

重新启用 Client 不会恢复已吊销或已过期 Token，只会使仍处于有效期且状态为 active 的 Token 重新可用。

### 到期监控

第三方系统或运维平台应定期检查 `/me` 返回的 `token_expires_at`，在到期前完成轮换。DocuMind 不会把完整 Token 通过邮件或日志发送给接入方。

## 限流与容量

每个 Token 按自然分钟统计请求数，超过 API Client 配置的每分钟限额后返回：

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json

{"code":"API_RATE_LIMITED","message":"API 请求超过当前分钟限额"}
```

第三方系统收到 429 后应停止立即重试，等待下一时间窗口并加入随机退避。不要用并发重试放大流量。

问答请求还会占用 LLM、Embedding、Reranker 和检索资源。每分钟请求限额不等于允许同等数量的并发长连接；正式容量应通过真实问答压测和客户模型并发限制共同确定。

## 错误响应

非 SSE 接口和问答建立连接前的错误使用统一 JSON：

```json
{
  "code": "KB_SCOPE_DENIED",
  "message": "请求知识库超出用户权限"
}
```

| HTTP 状态 | 常见错误码 | 含义与处理 |
|---:|---|---|
| 400 | `EMPTY_MESSAGE` | 请求字段或消息内容无效；修正请求，不自动重试 |
| 401 | `INVALID_API_TOKEN` | Token 格式、ID 或 secret 无效；检查密钥配置 |
| 401 | `API_TOKEN_REVOKED` | Token 已吊销；切换到新 Token |
| 401 | `API_TOKEN_EXPIRED` | Token 已过期；创建并配置新 Token |
| 401 | `API_CLIENT_DISABLED` | API Client 已停用；联系租户管理员确认 |
| 403 | `API_SCOPE_DENIED` | 当前 Client 缺少所需 Scope；按审批增加权限 |
| 403 | `KB_SCOPE_DENIED` | 请求知识库不在授权范围；不得绕过 |
| 404 | `CONVERSATION_NOT_FOUND` | 会话不存在，或不属于当前租户和 API Client |
| 404 | `MESSAGE_NOT_FOUND` | 消息不存在，或不属于当前会话和身份 |
| 409 | `CLIENT_REQUEST_CONFLICT` | 请求标识发生冲突；先查询现有消息再决定后续操作 |
| 429 | `API_RATE_LIMITED` | 超过分钟限额；等待并退避 |
| 504 | `PIPELINE_TIMEOUT` / `LLM_TIMEOUT` | 问答或模型超时；查询消息状态后再决定是否重试 |
| 500 | `INTERNAL_ERROR` | 服务内部异常；记录时间和业务请求标识，联系运维排查 |

跨租户或跨 API Client 读取会话时返回 404，而不是暴露资源真实存在与否。第三方系统不应根据 UUID 猜测其他资源。

## 超时、重试与幂等建议

- 普通 JSON 查询可在网络失败或 5xx 时执行有限次数指数退避重试。
- 400、401、403、404 和 409 通常需要修正请求或权限，不应无限重试。
- 429 应等待限流窗口，并增加随机退避。
- 流式问答连接应配置比普通 API 更长的读取超时，反向代理需允许 SSE 持续传输。
- 每次业务问答建议生成唯一 `client_request_id` 并持久化。
- SSE 中断后先查询会话消息和状态；只有确认服务端没有创建对应回答时才重新提交。
- 不要因客户端等待超时就创建多个新会话并重复发送同一问题。

## 安全要求

- 正式环境使用 HTTPS，禁止通过明文公网链路发送 Token、问题和答案。
- API Token 只保存在第三方服务端密钥系统，配置文件权限应限制为运行账号可读。
- 日志只记录 Client 名称、Token 前缀、请求标识和状态，不记录完整 Authorization Header。
- 开发、测试和生产使用不同 Client、Token 和知识库授权。
- 按最小权限授予知识库和 Scope，定期复核不再使用的接入。
- 人员离岗、系统下线或疑似泄露时立即吊销 Token或停用 Client。
- Trace、引用和答案可能包含企业文档内容，第三方系统应执行与原文一致的数据保护策略。
- 第三方系统展示内容前应执行自身所需的用户身份和业务权限判断，不能把一个后台 Token 直接等同于所有最终用户均有权限。

> [!提示] 如果同一个第三方系统服务多个权限差异明显的用户群，不应只用一个拥有全部知识库权限的 Token 再完全依赖前端隐藏。应拆分 API Client、后端路由或知识库授权边界，确保服务端调用范围与业务权限一致。

## 审计与运维

DocuMind 记录 API Client 创建、状态修改、Token 创建和吊销等重要管理事件。Token 记录保存前缀、状态、到期时间、创建时间和最后使用时间，不保存可恢复的明文 secret。

第三方系统建议记录：

- 自身业务请求 ID 与 `client_request_id`。
- API Client 名称和 DocuMind 会话 ID。
- 请求开始时间、HTTP 状态、耗时和最终回答状态。
- 助手消息 ID、引用数量和错误码。
- 不含完整 Token 和敏感文档正文的必要诊断信息。

发生问题时，双方可通过时间、会话 ID、消息 ID 和业务请求 ID 对齐日志，不需要交换 Token。

## CLI 联调工具

DocuMind CLI 可以直接连接真实环境验证外部 API。Token 默认从 `DOCUMIND_API_TOKEN` 读取：

```bash
export DOCUMIND_API_TOKEN='dm_live_...'
documind external whoami
documind external doctor
documind external chat --kb <kb-id> --json '请概括该知识库的主要制度'
```

租户管理员可以使用 CLI 管理 API Client：

```bash
documind api-clients list
documind api-clients create --name crm-test --kb <kb-id> --json
documind api-clients token <client-id> --expires-in-days 90 --json
documind api-clients revoke <client-id> <token-id>
documind api-clients disable <client-id>
```

完整自动验收：

```bash
documind external verify --kb <kb-id> --denied-kb <other-kb-id> --json
documind external verify --kb <kb-id> --other-config /path/to/other-tenant.toml --json
```

`external verify` 会真实调用 Agent 和模型，并检查身份、知识库范围、流式问答、Token 轮换与吊销、Client 停用与恢复、Redis 限流及跨租户会话隔离。测试生成的 Token 应在验收结束后吊销，测试 Client 应停用。

## 上线验收清单

| 检查项 | 通过标准 | 结果 |
|---|---|---|
| 网络与证书 | 第三方后端可以通过正式 HTTPS 地址访问，证书有效 | 待填写 |
| 身份确认 | `/me` 返回预期 Client、租户、Scope 和到期时间 | 待填写 |
| 知识库范围 | 只返回批准的知识库，未授权知识库请求返回 403 | 待填写 |
| 真实问答 | SSE 能完整接收答案，消息最终状态为 completed | 待填写 |
| 引用核对 | 回答包含可核对的文档标题、原文和定位信息 | 待填写 |
| 无答案场景 | 无依据时明确说明，不能伪造引用 | 待填写 |
| 多轮会话 | 同一会话追问可使用上下文，不同会话互不混淆 | 待填写 |
| 会话隔离 | 其他 Client 和其他租户无法读取测试会话 | 待填写 |
| Token 吊销 | 旧 Token 吊销后立即返回 401 | 待填写 |
| Client 停用 | Client 停用后其所有 Token 均不可用 | 待填写 |
| 限流 | 超过配置限额后返回 429，调用方正确退避 | 待填写 |
| 日志脱敏 | 双方日志均不包含完整 Token | 待填写 |
| 故障处理 | 超时、断流和 5xx 场景不会造成无限重试 | 待填写 |

## 接口一览

| 方法 | 路径 | Scope | 说明 |
|---|---|---|---|
| GET | `/api/v1/external/me` | 有效 Token | 查询接入身份和授权范围 |
| GET | `/api/v1/external/knowledge-bases` | `knowledge_bases:read` | 查询授权知识库 |
| GET | `/api/v1/external/conversations` | `conversations:read` | 分页查询当前 Client 会话 |
| POST | `/api/v1/external/conversations` | `chat:write` | 创建会话 |
| GET | `/api/v1/external/conversations/{id}` | `conversations:read` | 查询会话详情 |
| GET | `/api/v1/external/conversations/{id}/messages` | `conversations:read` | 查询持久化消息和引用 |
| POST | `/api/v1/external/conversations/{id}/messages` | `chat:write` | 通过 SSE 发起真实问答 |
| GET | `/api/v1/external/conversations/{id}/messages/{message_id}/traces` | `conversations:read` | 查询回答 Trace |

## 文档关系

本说明书用于第三方系统 API 接入和联调；DocuMind 的整体组成、文档处理及 RAG 逻辑请参阅《DocuMind 系统架构与业务逻辑说明书》，服务器安装、配置、备份和运维请参阅《DocuMind 独立部署说明书》。

产品升级后，如外部 API 路径、请求字段、事件、Scope 或安全规则发生变化，应同步更新本说明书。客户最终使用的接口和文档应来自同一版本交付包。

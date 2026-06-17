# 知识库管理 (Knowledge Base)

知识库是文档的组织容器，也是检索的权限与范围边界。

## 核心职责

- 知识库 CRUD（创建、配置、删除）
- 文档上传与解析状态追踪（Word / PPT / PDF）
- 文档标签与分类管理
- 文档删除与重处理（级联清理 chunks + embeddings）
- 切割策略配置（按知识库粒度调整 chunk 参数）

## 当前目标

管理后台里的“知识库管理”必须从卡片概览升级为真实可用的文档管理入口：

1. 管理员可以新建、编辑、删除知识库，维护名称、描述、状态和标签。
2. 管理员点击某个知识库后，能看到该知识库下真实上传的文档，而不是只停留在统计卡片。
3. 知识库内文件数量可能很大，文档区默认使用表格展示，并提供服务端搜索、状态过滤和刷新。
4. 点击任意文档后打开右侧抽屉，抽屉必须提供真实预览：优先展示从原始 Word / PDF / PPT 解析出的原始正文结构，同时保留解析块、切片、表格和元数据。
5. 文档管理支持删除、移动知识库、下载原始文件、单个重试和批量重试失败文档。
6. “文档管理”页面和“知识库管理”页面点击文档时复用同一套详情抽屉，避免两边预览能力不一致。
7. 后端接口返回真实数据库数据；没有数据库时不伪造管理数据。

## 信息架构

```text
管理员后台
  -> 知识库管理
    -> 知识库列表 / 搜索
    -> 选中知识库
      -> 文档表格
      -> 文档详情抽屉
        -> 原文预览
        -> 解析块
        -> 切片
        -> 表格
        -> 文档信息

  -> 文档管理
    -> 上传文档
    -> 全局文档表格
    -> 文档详情抽屉（同一组件）
```

## 页面交互

### 知识库管理

页面遵循最新 Pencil 稿的卡片网格：

| 区域 | 内容 | 行为 |
|---|---|---|
| 顶部工具栏 | 知识库搜索、结果数、新建知识库 | 搜索只过滤卡片，不伪造数据 |
| 知识库网格 | 知识库名称、描述、状态、文档数、切片数、更新时间 | 点击卡片进入文档管理页并携带 `kb_id` |
| 文档管理页 | 当前 `kb_id` 下的真实文档表格 | 支持大量文件扫描、状态过滤和点击预览 |
| 文档详情抽屉 | 文档信息、原文预览、切片列表、表格、解析块 | 从右侧覆盖打开，不离开当前表格上下文 |

文档表格列：

| 列 | 数据源 | 说明 |
|---|---|---|
| 文件名 | `documents.file_name` | 主显示字段，副标题显示知识库名或标题 |
| 类型 | `documents.file_type` | `DOCX` / `PPTX` / `PDF` |
| 大小 | `documents.file_size` | 前端格式化 |
| 页数 | `documents.page_count` | 未解析完成显示 `—` |
| 切片 | `documents.chunk_count` | 检索切片数量 |
| 表格 | `documents.table_count` | 解析出的表格数量 |
| 质量 | `document_parse_jobs.quality_score` | 百分比 |
| 状态 | `documents.parse_status` | 已完成 / 解析中 / 待重建 / 失败 |
| 更新时间 | `documents.updated_at` | 表格排序依据 |

默认行为：

- 初次进入知识库页只展示知识库卡片，不自动展开文档。
- 点击知识库卡片跳转到 `/admin/documents?kb_id={kb_id}`。
- 文档管理页读取 `kb_id` 后只加载该知识库下的真实文档。
- 知识库为空时显示空状态，不显示假数据。
- 文档很多时后端先限制返回最近 200 条；后续再补分页和游标。

### 文档管理

文档管理继续承担上传和全局文档排查职责：

- 上传文档时必须选择真实知识库。
- 全局表格仍可按状态过滤。
- 点击文档后打开同一个 `DocumentDrawer`。
- 抽屉默认进入“原文预览”，而不是只看解析元数据。

## 后端契约

### `GET /api/admin/knowledge-bases`

管理员知识库列表，返回每个知识库的真实文档统计。

```json
[
  {
    "id": "uuid",
    "tenant_id": "uuid",
    "name": "产品文档库",
    "description": "产品手册与白皮书",
    "status": "active",
    "tags": ["产品"],
    "doc_count": 42,
    "chunk_count": 2380,
    "query_count": 0,
    "updated_at": "2026-06-17T10:20:00Z"
  }
]
```

统计规则：

- `doc_count` 来自 `documents`。
- `chunk_count` 来自 `documents.chunk_count` 汇总。
- `query_count` 目前没有落库统计，第一版返回 `0`。
- 管理员需要 `kb.manage` 或管理后台权限；普通知识库选择仍使用 `/api/knowledge-bases`。

### `POST /api/admin/knowledge-bases`

创建知识库。

```json
{
  "name": "产品文档库",
  "description": "产品手册与白皮书",
  "status": "active",
  "tags": ["产品", "手册"]
}
```

### `PUT /api/admin/knowledge-bases/:kb_id`

更新知识库名称、描述、状态和标签。`status` 允许 `active`、`disabled`、`archived`。

### `DELETE /api/admin/knowledge-bases/:kb_id`

删除知识库。当前实现使用数据库外键级联清理该知识库下的文档、解析任务、块、表格和切片。

### `GET /api/admin/documents`

已有接口继续使用，知识库下钻时传入 `kb_id`：

```text
GET /api/admin/documents?kb_id={kb_id}&status=parsed
```

第一版参数：

| 参数 | 说明 |
|---|---|
| `kb_id` | 可选。传入后只返回该知识库文档 |
| `status` | 可选。`all` / `parsed` / `parsing` / `parse_failed` |
| `q` | 可选。文件名 / 标题模糊搜索 |
| `limit` | 可选。默认 200，上限 200 |

后续扩展：

| 参数 | 说明 |
|---|---|
| `cursor` | 游标分页 |

### `GET /api/admin/documents/:doc_id`

详情接口新增 `preview` 字段：

```json
{
  "document": {},
  "latest_job": {},
  "preview": {
    "mode": "parsed_text",
    "title": "年度销售策略",
    "text": "# 年度销售策略\n\n第一段...",
    "truncated": false,
    "source": "document_blocks",
    "char_count": 38420
  },
  "blocks": [],
  "chunks": [],
  "tables": []
}
```

预览生成策略：

1. 优先使用当前 `latest_parse_job_id` 对应的 `document_blocks`，按 `block_index` 拼接原始正文。
2. 标题块按 `heading_level` 输出 Markdown 标题，普通段落保留段落换行，表格块用表格标题或占位说明。
3. Word 文档的预览以解析出的原始正文为准，不展示切片摘要。
4. 若解析尚未完成，返回空文本和 `mode = "pending"`。
5. 若解析失败，返回错误状态和已有可用块，前端同时显示错误信息。
6. 为避免大文件拖垮抽屉，第一版预览最多返回 60,000 字符，超出时 `truncated = true`。

### 文档管理操作

| 接口 | 行为 |
|---|---|
| `DELETE /api/admin/documents/:doc_id` | 删除文档和解析数据，并尝试删除本地 blob 原件 |
| `POST /api/admin/documents/:doc_id/move` | 移动文档到其他知识库，同时更新 `chunks.kb_id` |
| `POST /api/admin/documents/:doc_id/retry` | 单个文档重试解析 |
| `POST /api/admin/documents/retry` | 批量重试，第一版最多 50 个 |
| `GET /api/admin/documents/:doc_id/original` | 下载原始文件，需要认证请求头 |

## 前端组件

### `AdminKnowledge`

职责：

- 加载管理员知识库列表。
- 本地搜索知识库名称、描述和标签。
- 按最新 Pencil 稿展示知识库卡片网格。
- 支持新建、编辑、删除知识库。
- 点击知识库卡片跳转到 `/admin/documents?kb_id={kb_id}`。
- 不在知识库页直接渲染大文档表格，避免卡片入口页承载过多管理细节。

### `AdminDocuments`

职责：

- 从 URL 读取 `kb_id`。
- 当存在 `kb_id` 时调用 `listAdminDocuments({ kb_id, status, q, limit })`。
- 在表格中展示该知识库的真实文档。
- 点击文档后加载详情并打开 `DocumentDrawer`。
- 支持服务端搜索、状态过滤、删除、移动、下载原件、单个重试和批量重试失败文档。

### `DocumentDrawer`

职责：

- 标签页顺序贴近最新 Pencil：`文档信息`、`原文预览`、`切片列表`、`表格`、`解析块`。
- 默认打开 `原文预览`，让 Word / PDF / PPT 的原始解析正文优先可见。
- 预览区使用等宽/正文混排，保留换行，支持长文本滚动。
- 显示截断提示：当 `preview.truncated = true` 时提示“仅展示前 60,000 字符”。
- `onRetry` 仅在调用方传入时显示。

## 权限与范围

- 管理后台接口要求已有管理权限；第一版沿用 `document.upload` 作为文档管理入口权限，知识库统计接口使用 `kb.manage`。
- 文档查询必须限制 `tenant_id = actor.tenant_id`。
- 普通用户只能通过 `/api/knowledge-bases` 获取自己允许访问的知识库，不暴露全租户统计。

## 验收标准

- 点击“知识库管理”里的任意知识库，进入带 `kb_id` 的文档管理表格。
- 新建 / 编辑 / 删除知识库会真实写入 PostgreSQL。
- 文档表格点击文档，抽屉能看到 Word / PDF / PPT 的原始解析正文预览。
- 文档可移动到其他知识库，移动后表格和 chunk 范围一致。
- 文档可删除、下载原件、重试解析，失败文档可批量重试。
- “文档管理”点击同一文档，抽屉预览内容一致。
- 文档解析失败时，抽屉展示失败原因，且不会报前端运行时错误。
- 构建通过，部署到 `ssh documind` 后可在 `http://<server>:8089/documind/admin/knowledge/` 和 `http://<server>:8089/documind/admin/documents/` 真实验证。

# DocuMind 全功能上线路线图

本文档面向 2026-06-25 的 DocuMind 上线工作，目标是把系统从“当前已具备核心能力”推进到“服务器上可验收、可灰度、可对外试用”的状态。

路线图按阶段拆分。每一步都回答三个问题：

- 需要做什么，补齐什么内容
- 验证什么，保证什么
- 需要真实到 `ssh documind` 服务器里测试什么

## 0. 上线口径

### 0.1 今日建议上线范围

今日建议按“核心文档问答闭环”上线，而不是承诺所有后台运维功能都达到生产级。

今日应纳入正式上线范围：

- 本地账号登录与 JWT 鉴权
- 知识库列表与知识库管理
- 文档上传、存储、解析、清洗、切片
- embedding 入库与 Elasticsearch 索引
- 对话创建、流式问答、检索 trace、引用展示
- 历史会话、消息回看、反馈提交
- 基础租户、成员、用户、模型与任务只读查看
- 服务器部署、健康检查、日志查看、基础回滚

今日不建议承诺为完整生产能力的范围：

- 系统运维大屏的所有指标
- 审计日志完整链路
- 向量索引重建、优化、迁移等后台操作
- 模型配置、切分策略、检索策略的前端持久化配置
- 权限矩阵在线编辑
- RabbitMQ 异步任务的完整生产编排
- 多租户配额、计费、用量统计

### 0.2 当前摸底结论

已确认的当前状态：

- 远端 `ssh documind` 上 DocuMind 进程已运行，监听 `8089`。
- `make health` 通过，`/api/health` 返回正常，`/documind/` 返回 HTTP 200。
- 远端 `.env` 已打开真实 LLM：`USE_REAL_LLM=true`。
- 远端 LLM 为 DashScope OpenAI-compatible 接口，模型为 `qwen-max`。
- 远端 embedding 为 `text-embedding-v3`，`EMBED_ENABLED=true`。
- 远端 PostgreSQL、Redis、RabbitMQ、MinIO、Elasticsearch 容器均存在。
- 本地前端生产构建通过：`npm --prefix apps/web run build`。
- 本地 Rust workspace 测试通过：`cargo test --workspace --no-fail-fast`，当前 25 个测试全绿。
- 服务器上已经存在可检索数据：Elasticsearch `chunks` 索引有 `557` 条文档。
- 服务器冒烟验证已通过：登录、知识库列表、创建会话、SSE 问答均可完成。

需要重点处理的差距：

- `/api/health` 当前仍返回 `"mode": "prototype"`，上线前需要改成真实发布语义。
- 远端数据中存在 `embedding_failed`、`parsing`、`parse_low_confidence`、`parsed` 等非最终状态文档，需要清理或明确处置。
- 后台部分页面和接口仍使用 mock 或静态数据，必须标记为灰度、只读展示，或在上线前隐藏。
- reranker 未配置真实 API 时会走 mock reranker，检索可用，但不能承诺完整精排效果。
- 当前工作区有未提交改动，上线前必须确认这些改动是否纳入本次发布。

## 1. 阶段一：冻结上线范围与工作区

### 1.1 需要做什么

先冻结今天的上线范围，避免一边补功能一边扩大目标。

需要完成：

- 确认今天的上线目标是“核心文档问答闭环”，不是完整后台运维系统。
- 把后台页面分成三类：
  - `正式可用`：登录、聊天、历史、知识库、文档管理、知识库管理。
  - `只读可看`：成员、租户、系统用户、模型、任务。
  - `灰度或隐藏`：审计、向量索引管理、权限矩阵、配置持久化页面。
- 确认当前工作区里的改动是否全部纳入发布。
- 不执行 `git add`、`git commit`、`git push`，除非用户逐次明确授权。

### 1.2 验证什么

需要保证：

- 上线验收清单和实际系统能力一致。
- 不把 mock 页面当成生产功能验收。
- 不遗漏当前工作区中已经修改但尚未发布的文件。
- 发布范围中每个功能都有可验证的服务器测试路径。

本地检查命令：

```bash
git status --short
git diff --stat
rg -n "const mock|mock[A-Z]|prototype|TODO|FIXME|unimplemented!|todo!" apps docs README.md Makefile -S
```

验收标准：

- 明确列出本次发布包含和不包含的功能。
- 所有 `mock` 命中的页面都有处理决定：替换真实 API、标注灰度、隐藏入口，三选一。
- `git status --short` 中的每个文件都有归属判断。

### 1.3 服务器测试什么

到服务器确认当前运行版本和运行状态：

```bash
make status
make health
ssh documind 'bash -lc "readlink -f /opt/documind/current && ls -lt /opt/documind/releases | sed -n 1,8p"'
ssh documind 'bash -lc "curl -fsS http://127.0.0.1:8089/api/config | python3 -m json.tool"'
```

需要确认：

- `8089` 端口被 `/opt/documind/current/bin/documind` 监听。
- `/api/config` 中 `use_real_llm=true`、`mock_enabled=false`。
- `storage.elasticsearch`、`storage.redis`、`storage.rabbitmq`、`storage.object_endpoint` 都有服务器内网地址。

## 2. 阶段二：P0 代码补齐

### 2.1 需要做什么

这一阶段只处理会影响上线观感、安全性或验收口径的 P0 项，不做大重构。

必须补齐：

- 把 `/api/health` 的 `"mode": "prototype"` 改为更准确的发布状态，例如 `"release"` 或 `"production"`，并可附带版本信息。
- 对仍是 mock 的系统页做处理：
  - 能在 1 小时内接真实 API 的，接真实 API。
  - 不能快速补齐的，在导航或页面内转为灰度/只读说明，避免被当作可操作能力。
  - 对明显误导的 mock 指标，优先隐藏。
- 确认登录页默认账号不会泄露生产密码。默认用户名可以保留便捷性，密码不应预填。
- 确认前端错误提示能够显示 API 失败原因，不出现无响应状态。
- 确认上传、重试、删除等高风险操作都有明确反馈。

可以暂缓：

- 完整审计系统。
- 完整任务中心。
- 在线模型配置写入。
- 权限矩阵编辑器。
- 指标大屏的真实聚合。

### 2.2 验证什么

需要保证：

- 用户不会在正式入口看到明显演示态文字。
- 核心链路页面不依赖本地 mock 数据。
- API 失败时前端有明确错误反馈。
- 页面构建和 Rust 测试不回退。

本地验证命令：

```bash
npm --prefix apps/web run build
cargo test --workspace --no-fail-fast
rg -n "prototype|const mock|mock[A-Z]" apps/api-rs/src apps/web/app apps/web/components -S
```

验收标准：

- 前端构建成功。
- Rust 测试全部通过。
- `prototype` 不再出现在健康检查响应中。
- 所有保留的 mock 命中都有灰度理由，且不在正式验收范围内。

### 2.3 服务器测试什么

部署后在服务器上验证：

```bash
make deploy
make health
ssh documind 'bash -lc "curl -fsS http://127.0.0.1:8089/api/health | python3 -m json.tool"'
ssh documind 'bash -lc "curl -fsS -o /dev/null -w \"%{http_code}\n\" http://127.0.0.1:8089/documind/"'
```

需要确认：

- `/api/health` 返回发布语义。
- `/documind/` 返回 200。
- 重启后日志中没有 panic、migration failure、asset missing、bind port failure。

日志检查：

```bash
ssh documind 'bash -lc "tail -n 200 /opt/documind/shared/logs/documind-8089.log"'
```

## 3. 阶段三：服务器数据面清理

### 3.1 需要做什么

上线前必须把服务器上的文档状态整理到可解释状态，否则验收时会出现“为什么有很多失败/处理中”的问题。

需要补齐：

- 清点每种 `parse_status` 的文档数量。
- 对 `embedding_failed` 文档执行重试或标记不可上线。
- 对长时间停留在 `parsing` 的文档判断是否卡死：
  - 如果是历史残留，重新触发解析。
  - 如果原始文件缺失，标记失败并记录原因。
  - 如果只是后台状态未刷新，补齐状态更新逻辑。
- 对 `parse_low_confidence` 文档决定是否进入检索：
  - 上线样本文档不应依赖低置信解析。
  - 低置信文档应在管理页中有清晰状态。
- 对 `parsed` 但未 indexed 的文档执行 embedding 或重试。
- 清理重复测试文档，保留少量可用于演示的标准样本文档。

### 3.2 验证什么

需要保证：

- 文档最终状态可解释。
- 可演示知识库中至少有一组高质量样本文档。
- 每个 indexed 文档都有 chunks。
- 每个可检索 chunk 都有 embedding。
- Elasticsearch 索引数量与 PostgreSQL embedding 数量大致一致。

服务器查询命令：

```bash
ssh documind 'bash -lc "podman exec documind-postgres psql -U documind -d documind_dev -P pager=off -c \"select parse_status, count(*) docs, sum(chunk_count) chunks, sum(table_count) tables from documind.documents group by parse_status order by parse_status;\""'

ssh documind 'bash -lc "podman exec documind-postgres psql -U documind -d documind_dev -P pager=off -c \"select status, embedding_model, count(*) from documind.chunk_embeddings group by status, embedding_model order by count desc;\""'

ssh documind 'bash -lc "curl -fsS http://127.0.0.1:8104/_cat/indices?v"'
```

验收标准：

- 正式演示知识库中没有卡在 `parsing` 的核心样本文档。
- `embedding_failed` 有明确处理：重试成功、下线、或保留为已知问题。
- `chunk_embeddings` 中 completed 数量与 ES `chunks` 索引文档数能对齐。
- 管理页列表与数据库统计一致。

### 3.3 服务器测试什么

真实在服务器上操作：

- 登录 DocuMind。
- 进入 `/documind/admin/documents`。
- 按状态筛选失败文档。
- 对失败文档执行单个重试。
- 对批量失败文档执行批量重试。
- 打开文档详情，检查 preview、blocks、cleaned blocks、chunks、tables。
- 下载原始文件，确认对象存储可读。

需要观察：

- API 是否返回明确错误。
- 页面状态是否自动刷新。
- 重试后状态是否从 `embedding_failed` 或 `parsed` 进入 `indexed`。
- 日志中是否出现 embedding provider 错误、ES indexing 错误、对象存储读取错误。

## 4. 阶段四：文档上传与解析闭环验收

### 4.1 需要做什么

补齐真实文件格式的端到端验收，不只测已有数据。

需要准备服务器验收样本：

- DOCX：包含标题、段落、列表、表格。
- PPTX：包含多页 slide、标题、正文、备注、表格。
- PDF：包含多页文本，最好包含页码、页眉页脚。
- Markdown：如果当前产品入口承诺支持 Markdown，则加入样本；否则不要放入正式口径。

需要确认：

- 上传大小限制当前为 50MB。
- 原始文件进入 MinIO 或本地 blob。
- 解析结果进入 PostgreSQL。
- chunks 进入 PostgreSQL。
- embedding 进入 `chunk_embeddings`。
- chunk 文档进入 Elasticsearch。
- 文档详情页可以展示 preview 和 chunks。

### 4.2 验证什么

需要保证：

- 每种承诺格式都能成功上传和解析。
- 解析失败有明确错误码和错误信息。
- 表格文档不会导致解析崩溃。
- 空文档、极短文档、低质量扫描件能被识别为低置信或失败，而不是静默进入检索。
- 同一文件重复上传不会破坏数据一致性。

本地验证：

```bash
cargo test --workspace --no-fail-fast
```

服务器数据验证：

```bash
ssh documind 'bash -lc "podman exec documind-postgres psql -U documind -d documind_dev -P pager=off -c \"select title, file_type, parse_status, chunk_count, table_count, uploaded_at from documind.documents order by uploaded_at desc limit 20;\""'
```

验收标准：

- 每个样本文档都有明确最终状态。
- 成功样本文档的 `chunk_count > 0`。
- 表格样本文档的 `table_count` 与预期接近。
- 成功样本文档在 ES 中可检索。

### 4.3 服务器测试什么

必须在 `http://<server>:8089/documind/` 页面真实上传，不只用 API。

操作路径：

1. 登录企业管理员账号。
2. 进入文档管理。
3. 选择目标知识库。
4. 上传 DOCX、PPTX、PDF 样本。
5. 等待解析和向量化完成。
6. 打开每个文档详情。
7. 检查 preview、chunks、tables。
8. 对每个样本文档提出 2 个问题。

需要同时查看服务器日志：

```bash
ssh documind 'bash -lc "tail -f /opt/documind/shared/logs/documind-8089.log"'
```

需要确认日志中没有：

- parser panic
- object storage read/write failure
- embedding provider HTTP error
- Elasticsearch index mapping error
- database unique constraint 异常未处理

## 5. 阶段五：RAG 问答质量验收

### 5.1 需要做什么

补齐一组上线必需的黄金问题集，用来验证真实检索和生成质量。

黄金问题集至少包含：

- 精确事实问答：例如付款比例、报销上限、交付日期。
- 跨段落总结：例如总结某份制度的核心规则。
- 对比问题：例如 A 策略和 B 策略区别。
- 追问问题：先问某合同，再问“那付款节点呢？”。
- 无答案问题：文档中不存在的信息，必须明确说无法根据文档回答。
- 表格问题：从表格中抽取某行某列信息。
- 引用核验问题：答案必须带来源文档和原文片段。

需要补齐：

- 每个问题对应预期答案。
- 每个问题对应预期引用来源。
- 每个问题对应可接受的答案范围。
- 每个问题的不可接受回答，例如瞎编、无引用、引用错文档。

### 5.2 验证什么

需要保证：

- 流式事件顺序正常：created -> rewriting -> retrieving -> reranking -> generating -> completed。
- 检索结果和问题相关。
- 回答引用真实存在的 chunk。
- 没有文档依据时拒答或澄清。
- 多轮追问能利用上下文。
- 反馈提交可落库。
- 历史会话回看时，消息、引用、trace 都还在。

API 冒烟命令示例：

```bash
ssh documind 'bash -s' <<'REMOTE'
set -euo pipefail
TOKEN=$(curl -fsS -X POST http://127.0.0.1:8089/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"Anner\",\"password\":\"1\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)[\"access_token\"])")

CONV=$(curl -fsS -X POST http://127.0.0.1:8089/api/conversations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"上线验收问答\",\"kb_ids\":[]}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)[\"conversation_id\"])")

curl -fsS -N -X POST "http://127.0.0.1:8089/api/conversations/$CONV/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"2026-Q3采购合同的付款节点是什么？\"}" \
  | sed -n "1,120p"
REMOTE
```

验收标准：

- SSE 能输出 `answer.delta`。
- 最终回答包含可核验的事实。
- 回答完成后重新打开会话能看到完整消息。
- 引用卡片能展示文档标题、片段、分数、来源状态。

### 5.3 服务器测试什么

必须用浏览器真实测试：

- 普通用户登录后提问。
- 企业管理员登录后提问。
- 超级管理员登录后提问。
- 在 `/documind/chat` 新建会话。
- 在已有会话里追问。
- 刷新页面后继续会话。
- 点击引用或展开引用详情。
- 提交赞/踩反馈。
- 停止生成或重试消息。

需要观察：

- 页面是否卡住。
- SSE 是否中断。
- 多角色是否看到不该看的知识库。
- 引用是否和回答内容一致。
- 服务器日志中是否出现 LLM timeout、provider unauthorized、JSON parse error。

## 6. 阶段六：认证、角色与权限验收

### 6.1 需要做什么

补齐上线最低权限闭环。

需要确认三类账号：

- 超级管理员：可访问系统管理。
- 企业管理员：可管理租户内知识库、文档、成员。
- 普通用户：可查看授权知识库并问答，不可进入管理操作。

需要补齐：

- 默认账号密码只用于内部验收，生产交付时必须替换。
- JWT secret 必须为服务器私有强随机值。
- 登录失败、token 过期、无权限访问都有清晰响应。
- `AUTH_LOGIN_MODE=local` 时，不依赖门户。
- 如果切 `AUTH_LOGIN_MODE=portal`，必须单独做门户回调验收，不混入今天核心上线。

### 6.2 验证什么

需要保证：

- 未登录访问 API 返回 401。
- 普通用户访问管理接口返回 403。
- 管理员可以上传和重试文档。
- 用户只能看到授权知识库。
- token refresh/logout 行为正常。

服务器 API 验证：

```bash
ssh documind 'bash -lc "curl -i http://127.0.0.1:8089/api/conversations | sed -n 1,20p"'
```

预期：

- 未带 token 时返回 401。

继续分别用三类账号登录并访问：

```bash
/api/v1/me
/api/knowledge-bases
/api/admin/documents
/api/system/users
```

验收标准：

- 权限边界符合角色预期。
- 服务器日志没有因为权限失败产生 panic。
- 前端遇到 401 会回登录页，遇到 403 会显示无权限。

### 6.3 服务器测试什么

在真实页面中测试：

1. 清空浏览器 localStorage。
2. 访问 `/documind/chat`，应跳转登录或提示登录。
3. 用普通用户登录。
4. 尝试访问 `/documind/admin/documents` 和 `/documind/system`。
5. 退出登录。
6. 用企业管理员登录。
7. 上传文档、创建知识库、查看成员。
8. 退出登录。
9. 用超级管理员登录。
10. 访问系统管理页。

需要确认：

- 不同角色的默认入口正确。
- 侧边栏不暴露无权限入口，或者点击后明确 403。
- 刷新页面后登录态保持。
- 退出后 token 不再可用。

## 7. 阶段七：后台与配置页面上线策略

### 7.1 需要做什么

后台页面必须从“看起来完整”调整为“能力边界诚实”。

需要逐页处理：

- `/admin/documents`：正式上线，必须接真实文档 API。
- `/admin/knowledge`：正式上线，必须接真实知识库 API。
- `/admin/members`：至少只读真实成员数据。
- `/admin/logs`：如果仍是 mock，则灰度或隐藏。
- `/admin/chunking`：如果不能持久化配置，则标记只读策略展示。
- `/admin/embedding`：如果不能持久化配置，则标记只读模型说明。
- `/admin/llm`：如果不能持久化配置，则标记只读配置快照。
- `/admin/search`：如果不能持久化配置，则标记只读策略说明。
- `/system/tenants`：只读真实租户数据。
- `/system/users`：只读真实用户数据。
- `/system/models`：若是静态数据，改成来自 `/api/config` 或隐藏健康状态承诺。
- `/system/jobs`：若是 mock，灰度或隐藏。
- `/system/audit`：若是 mock，灰度或隐藏。
- `/system/vector-indexes`：若是 mock，灰度或隐藏。
- `/tenant/permissions`：若权限矩阵不能写入，灰度或隐藏。

### 7.2 验证什么

需要保证：

- 正式入口中不显示假的统计数字。
- 只读页不会出现可点击但无效的保存按钮。
- 灰度页面不会影响核心用户路径。
- 所有页面在静态导出后路径正常。

本地验证：

```bash
npm --prefix apps/web run build
rg -n "const mock|mock[A-Z]" apps/web/components/views -S
```

验收标准：

- 每个保留 mock 的页面都不在正式验收范围。
- 正式验收页面全部使用真实 API。
- 前端 build 静态路由全部生成成功。

### 7.3 服务器测试什么

真实打开以下页面：

```text
/documind/login
/documind/chat
/documind/history
/documind/knowledge
/documind/admin
/documind/admin/documents
/documind/admin/knowledge
/documind/admin/members
/documind/system
/documind/system/users
/documind/system/tenants
```

需要确认：

- 页面不会 404。
- 页面不会白屏。
- 首屏不会出现明显演示数据。
- 无权限账号访问受限页面时处理合理。
- 浏览器控制台没有关键错误。

## 8. 阶段八：可观测性、日志与运维准备

### 8.1 需要做什么

上线不是只把服务跑起来，还要能在出问题时定位。

需要补齐：

- 明确日志文件路径：`/opt/documind/shared/logs/documind-8089.log`。
- 明确 `.env` 路径：`/opt/documind/shared/.env`。
- 明确 release 结构：`/opt/documind/releases/<timestamp>`、`/opt/documind/current`、`/opt/documind/shared`。
- 明确基础组件容器名：
  - `documind-postgres`
  - `documind-redis`
  - `documind-rabbitmq`
  - `documind-elasticsearch`
  - `documind-minio`
- 明确故障检查顺序：
  - 进程
  - 端口
  - health
  - 日志
  - 数据库连接
  - Redis
  - Elasticsearch
  - MinIO
  - LLM/embedding provider

需要补齐的运维能力：

- 上线前备份数据库。
- 上线前记录当前 release。
- 上线失败时回滚 `current` symlink。
- 日志中敏感信息脱敏。
- `.env` 不通过聊天或文档泄露 API key。

### 8.2 验证什么

需要保证：

- 服务挂了能快速知道。
- 依赖挂了能定位是哪一层。
- 发布失败能回滚。
- 数据不会因为重建容器丢失。

服务器检查命令：

```bash
make status
make health
ssh documind 'bash -lc "podman ps --format \"table {{.Names}}\t{{.Status}}\t{{.Ports}}\" | grep documind"'
ssh documind 'bash -lc "df -h /opt/documind /opt/documind/shared || true"'
ssh documind 'bash -lc "du -sh /opt/documind/shared/* 2>/dev/null | sort -h"'
ssh documind 'bash -lc "tail -n 300 /opt/documind/shared/logs/documind-8089.log"'
```

验收标准：

- 所有容器状态正常。
- 磁盘空间足够。
- 日志中没有持续刷屏错误。
- health 和前端入口都正常。

### 8.3 服务器测试什么

需要做一次人工演练：

1. 记录当前 release：

   ```bash
   ssh documind 'bash -lc "readlink -f /opt/documind/current"'
   ```

2. 查看最近 release：

   ```bash
   ssh documind 'bash -lc "ls -lt /opt/documind/releases | sed -n 1,10p"'
   ```

3. 查看进程和端口：

   ```bash
   make status
   ```

4. 查看日志：

   ```bash
   make logs
   ```

5. 结束日志跟随后确认服务仍可访问：

   ```bash
   make health
   ```

需要确认：

- 操作人员知道去哪里看日志。
- 操作人员知道如何判断服务是否活着。
- 操作人员知道哪个 release 正在运行。

## 9. 阶段九：构建、部署与发布

### 9.1 需要做什么

正式部署必须按固定顺序执行。

发布前：

- 确认上线范围。
- 确认工作区改动。
- 确认 `.env` 中关键配置。
- 确认数据库和对象存储有备份。
- 确认远端基础组件运行正常。

构建与部署：

```bash
npm --prefix apps/web run build
cargo test --workspace --no-fail-fast
make deploy
make health
```

部署后：

- 确认 `/api/health`。
- 确认 `/documind/`。
- 确认登录。
- 确认核心问答。
- 确认日志。

### 9.2 验证什么

需要保证：

- 前端静态导出成功。
- Rust 编译成功。
- 单二进制启动成功。
- 新 release 被 `current` 指向。
- 旧 release 可用于回滚。
- 服务器端口仍是 `8089`。

验收标准：

- `make deploy` 成功退出。
- `make health` 成功。
- `readlink -f /opt/documind/current` 指向最新 release。
- 日志中能看到新服务启动时间。
- 无 5xx 错误持续出现。

### 9.3 服务器测试什么

部署完成后执行：

```bash
ssh documind 'bash -lc "curl -fsS http://127.0.0.1:8089/api/health | python3 -m json.tool"'
ssh documind 'bash -lc "curl -fsS http://127.0.0.1:8089/api/config | python3 -m json.tool"'
ssh documind 'bash -lc "curl -fsS -o /dev/null -w \"%{http_code}\n\" http://127.0.0.1:8089/documind/"'
ssh documind 'bash -lc "tail -n 200 /opt/documind/shared/logs/documind-8089.log"'
```

然后用浏览器验收：

- 登录。
- 进入聊天。
- 发起问答。
- 查看引用。
- 进入文档管理。
- 上传一个小文档。
- 等待 indexed。
- 用新文档提问。

## 10. 阶段十：上线验收用例

### 10.1 需要做什么

整理一份上线验收表，逐项打勾。

建议验收用例：

| 编号 | 场景 | 角色 | 预期 |
|---|---|---|---|
| A01 | 访问 `/documind/` | 未登录 | 正常打开或跳转登录 |
| A02 | 密码登录 | 企业管理员 | 登录成功进入聊天页 |
| A03 | 查看知识库 | 企业管理员 | 返回授权知识库 |
| A04 | 上传 DOCX | 企业管理员 | 文档进入解析并最终 indexed |
| A05 | 上传 PPTX | 企业管理员 | slide 文本可解析 |
| A06 | 上传 PDF | 企业管理员 | 多页文本可解析 |
| A07 | 文档详情 | 企业管理员 | preview、chunks、tables 可查看 |
| A08 | 创建会话 | 普通用户 | 会话创建成功 |
| A09 | 单轮问答 | 普通用户 | 流式回答且带引用 |
| A10 | 多轮追问 | 普通用户 | 能结合上下文 |
| A11 | 无答案问题 | 普通用户 | 明确拒答或澄清 |
| A12 | 历史会话 | 普通用户 | 刷新后可回看 |
| A13 | 反馈提交 | 普通用户 | 赞/踩落库 |
| A14 | 管理页越权 | 普通用户 | 返回 403 或无入口 |
| A15 | 系统页访问 | 超级管理员 | 可访问系统管理 |
| A16 | 服务器健康 | 运维 | health、日志、端口正常 |

### 10.2 验证什么

需要保证：

- 核心用户旅程可完成。
- 管理员旅程可完成。
- 失败场景可解释。
- 权限边界不穿透。
- 数据在刷新后仍存在。

验收记录应包含：

- 测试时间。
- 测试账号角色。
- 测试文档名。
- 测试问题。
- 实际回答摘要。
- 引用是否正确。
- 是否通过。
- 问题截图或日志片段。

### 10.3 服务器测试什么

验收期间持续观察：

```bash
ssh documind 'bash -lc "tail -f /opt/documind/shared/logs/documind-8089.log"'
```

验收后查询数据：

```bash
ssh documind 'bash -lc "podman exec documind-postgres psql -U documind -d documind_dev -P pager=off -c \"select count(*) conversations from documind.conversation_sessions; select count(*) messages from documind.conversation_messages; select count(*) feedback from documind.conversation_feedback;\""'
```

需要确认：

- 验收会话有落库。
- assistant 消息有落库。
- citation 有落库。
- feedback 有落库。

## 11. 阶段十一：灰度发布与上线后观察

### 11.1 需要做什么

正式对外前先灰度。

灰度策略：

- 第一批只给内部 3-5 个用户。
- 只开放 1 个正式知识库。
- 只上传经过确认的样本文档和少量真实文档。
- 明确反馈渠道。
- 每 2 小时检查一次日志和失败文档。

上线后第一天重点观察：

- LLM 调用是否超时。
- embedding 是否失败。
- 文档解析是否卡住。
- ES 查询是否变慢。
- 用户是否问出无引用答案。
- 前端是否出现 SSE 中断。
- 日志是否有持续 4xx/5xx。

### 11.2 验证什么

需要保证：

- 灰度用户可以完成真实工作。
- 失败不会扩散到全部用户。
- 发现问题可以快速回滚或关闭入口。
- 核心数据不会丢失。

观察命令：

```bash
make status
make health
ssh documind 'bash -lc "tail -n 500 /opt/documind/shared/logs/documind-8089.log"'
ssh documind 'bash -lc "podman exec documind-postgres psql -U documind -d documind_dev -P pager=off -c \"select parse_status, count(*) from documind.documents group by parse_status order by parse_status;\""'
ssh documind 'bash -lc "curl -fsS http://127.0.0.1:8104/_cat/indices?v"'
```

验收标准：

- health 持续正常。
- 新上传文档最终能 indexed。
- 问答响应稳定。
- 没有持续新增的 `embedding_failed`。
- 没有大量 LLM provider error。

### 11.3 服务器测试什么

上线后 2 小时：

- 复查 health。
- 复查日志。
- 复查文档状态。
- 抽查 3 个真实问题。
- 抽查历史会话。

上线后 24 小时：

- 汇总失败文档。
- 汇总用户反馈。
- 汇总高频问题。
- 汇总性能问题。
- 决定是否扩大灰度。

## 12. Go / No-Go 标准

### 12.1 Go 标准

满足以下条件可以上线核心闭环：

- `npm --prefix apps/web run build` 通过。
- `cargo test --workspace --no-fail-fast` 通过。
- `make deploy` 成功。
- `make health` 成功。
- 服务器登录成功。
- 服务器上传样本文档成功。
- 样本文档最终 indexed。
- 服务器问答能流式返回。
- 回答带正确引用。
- 历史会话可回看。
- 普通用户无法访问管理能力。
- 服务器日志没有持续 panic 或 5xx。

### 12.2 No-Go 标准

出现以下任一情况，不应正式上线：

- 无法登录。
- 无法创建会话。
- 流式问答不可用。
- 文档上传后无法解析或无法 indexed。
- 回答经常无引用或引用错误。
- 普通用户能访问管理员 API。
- 服务器重启后服务不可恢复。
- 日志出现持续 panic。
- `.env` 或日志泄露 API key、JWT secret、数据库密码。
- 前端正式入口大量显示 mock 数据且未标记灰度。

## 13. 今日推荐执行顺序

1. 冻结上线口径，确认正式范围和灰度范围。
2. 处理 `/api/health` 发布语义和明显 mock 页面。
3. 跑本地 build 和测试。
4. 清理服务器文档状态，处理失败和卡住任务。
5. 部署到 `ssh documind`。
6. 执行 health、config、日志检查。
7. 上传 DOCX/PPTX/PDF 样本文档。
8. 等待 indexed 并确认 PG + ES 数据。
9. 执行黄金问题集问答。
10. 执行三角色权限验收。
11. 记录验收结果。
12. 小范围灰度。
13. 上线后 2 小时复查。
14. 上线后 24 小时复盘并决定扩面。

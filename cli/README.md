# DocuMind CLI

DocuMind CLI 是面向 Vibe Coding 和后端效果调试的真实环境客户端。它不会启动本地 DocuMind 服务；所有问答都发往 TOML 中配置的真实服务器。

一次 `chat` 会合并两类事实：

- 实时 SSE/Atom 事件：执行 ID、步骤、工具调用、流式答案、引用和 token 用量。
- 服务端落库结果：最终消息、query trace、agent trace、dense/BM25/RRF/rerank retrieval trace 与持久化引用。

因此 JSON 报告既能用于人工看效果，也能作为自动评测和回归测试输入。

当前后端报告的是固定工具阶段时，`execution.round_source` 为 `runtime_tool_events`，`react_round_count` 表示实际收到的工具轮次；后端将来发出 `agent.iteration.*` 时会标记为 `agent_iterations`。CLI 不会把未上报的内部推理步骤臆测成 ReAct 轮次。

## 安装

需要 Bun 1.3 或更高版本。

```bash
cd cli
bun install
bun run verify
bun link
documind --version
```

也可以生成无 Bun 运行时依赖的单文件可执行程序：

```bash
cd cli
bun run build
./dist/documind --version
```

## 配置与认证

```bash
documind init
export DOCUMIND_PASSWORD='<真实账户密码>'
documind auth login
documind doctor
```

默认配置路径是 `~/.config/documind/config.toml`；可通过 `--config` 或 `DOCUMIND_CONFIG` 覆盖。当前真实环境默认值为：

- API：`http://123.57.255.204:8089`
- 用户：`Anner`
- 租户：`AcmeCorp`，登录 slug 为 `acme`
- SSH：`documind`
- Elasticsearch：服务器内部 `http://127.0.0.1:8104/chunks`

密码优先从 `auth.password_env` 指向的环境变量读取；也可以写入权限为 `0600` 的 TOML。JWT 缓存在同目录的 `session.json`，同样使用 `0600` 权限。`config show` 始终脱敏密码。

## 快速对话

```bash
# 新建会话并显示完整执行、检索和引用
documind chat '采购合同的付款条件是什么？'

# 延续上一次会话
documind chat --continue '刚才提到的期限从哪一天开始计算？'

# 指定会话与知识库
documind chat --conversation <conversation-id> --kb <kb-id> '再解释得具体一点'

# 交互式多轮对话
documind chat --interactive --kb <kb-id>

# 完整机器可读报告
documind chat --json '员工差旅报销标准是什么？' > report.json

# SSE 事件逐行输出，最后一行是合并后的 report
documind chat --ndjson '问题' > execution.ndjson

# 从 JSON、文件或 stdin 构造请求
documind chat --json --input-json '{"content":"问题","kb_ids":["..."]}'
documind chat --json --input-json @request.json
printf '%s' '{"content":"问题"}' | documind chat --json --input-json -
```

交互模式支持 `/new [标题]`、`/use <会话ID>`、`/kb <ID,ID>`、`/trace off|summary|full` 和 `/quit`。

## JSON 多轮评测

```bash
documind run examples/conversation-scenario.json
documind run examples/conversation-scenario.json --json --output result.json
```

每一轮可断言：

- `status`
- `confidence`
- `citations_min`
- `retrievals_min`
- `react_rounds_min`
- `contains` / `not_contains`
- `max_duration_ms`

断言失败时命令退出码为 `2`，适合放进后端回归流程。

## 会话与 trace

```bash
documind kb list
documind conversations list
documind conversations show <conversation-id> --json
documind traces show <conversation-id> <assistant-message-id> --json
```

`conversations show` 会读取数据库持久化后的消息，并为每一条 assistant 消息读取 trace。

## 知识库管理

CLI 覆盖管理页面的知识库能力。所有管理请求都自动限定为当前登录租户，权限由服务端校验。

```bash
# 租户全部知识库；普通用户可用 --accessible 查询自身授权范围
documind kb list
documind kb list --accessible
documind kb show <kb-id> --json

# 创建、更新、删除
documind kb create --name '采购制度' --description '采购与付款制度' --tag 采购 --tag 财务
documind kb update <kb-id> --status archived
documind kb delete <kb-id> --force
```

`kb update` 会先读取当前知识库，未指定的字段保持不变；`--description=` 可以清空描述。删除会级联删除知识库中的文档与解析数据，因此必须显式传入 `--force`。

## 文档与文件管理

```bash
# 查询页面中的全部详情区段
documind documents list --kb <kb-id> --status failed --query 合同
documind documents show <document-id> --json
documind documents preview <document-id>
documind documents blocks <document-id> --json
documind documents cleaned-blocks <document-id> --json
documind documents chunks <document-id>
documind documents tables <document-id> --json

# 上传、下载、移动、替换和删除
documind documents upload ./contract.pdf --kb <kb-id>
documind documents download <document-id> --output ./contract.pdf
documind documents move <document-id> --kb <target-kb-id>
documind documents replace <document-id> ./contract-v2.pdf
documind documents delete <document-id> --force

# 解析、索引和 OCR 管理
documind documents retry <document-id>
documind documents retry-batch <document-id-1> <document-id-2>
documind documents force-index <document-id>
documind documents exclude <document-id> --force
documind documents ocr <document-id>
```

上传文件限制与页面一致：支持 PDF、DOCX、PPTX、TXT、Markdown，单文件不超过 100MB。上传、重试、替换和 OCR 都可以追加 `--wait`，等待文档达到默认的 `indexed` 状态：

```bash
documind documents upload ./contract.pdf --kb <kb-id> --wait --timeout 300 --json
documind documents wait <document-id> --until indexed --timeout 300 --interval 1
```

遇到 `parse_failed`、`embedding_failed`、`parse_low_confidence` 或 `excluded_from_search` 时，等待命令会立即以非零状态退出并报告最终文档；这使上传和解析可直接作为自动化闭环测试步骤。

## 向量库诊断

```bash
# 后端 API 汇总的索引状态
documind vector indexes

# 对比 PostgreSQL 当前切片和 Elasticsearch 实际文档，发现残留或缺失向量
documind vector audit

# 通过 SSH 在真实服务器内部直接查询 Elasticsearch
documind vector count --kb <kb-id>
documind vector list --kb <kb-id> --limit 10
documind vector search '付款 条件' --kb <kb-id>
documind vector get <chunk-id> --json
documind vector get <chunk-id> --include-embedding --json
```

直接向量库查询会先验证 JWT 身份，并强制加入当前 `tenant_id` 和 `allowed_kb_ids` 过滤条件。默认不返回体积很大的 embedding；只有显式指定 `--include-embedding` 才返回完整数组。

`vector search` 用于检查 Elasticsearch 中的真实文本与元数据。真实的 dense 向量召回由后端问答链路执行，请使用 `chat --json` 查看 `trace.retrieval_traces` 中 `source=dense` 的结果。

`vector audit` 的数量不一致时退出码为 `1`，并为每个知识库报告 `delta = elasticsearch_chunks - postgres_chunks`。正数通常意味着旧解析版本或已删除文档的向量仍然残留，负数意味着索引缺失。

## 开发检查

```bash
cd cli
bun run check
bun test
bun run build
# 或一次完成
bun run verify
```

最终验收必须连接 `ssh documind` 对应的真实服务器；不要在本机启动 DocuMind 或临时服务。

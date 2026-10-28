# DocuMind

企业级文档智能问答系统 —— 基于 RAG（检索增强生成）架构，支持多格式文档解析、混合检索与流式生成。

## 技术栈

- **后端**: TypeScript + Bun + Hono（SQL 直连 PostgreSQL）
- **前端**: Next.js (静态导出，编译期内嵌进 Bun 单文件二进制)
- **数据库**: PostgreSQL + Redis + RabbitMQ + Elasticsearch
- **模型**: OpenAI 兼容 LLM / Embedding / Reranker 服务
- **部署**: `bun build --compile` 单文件二进制

后端目录：`apps/api-bun`，按领域分层（`api/` 路由、`agent/` Agent Kernel、`rag/` 检索、`document/` 解析、`repositories/` 持久化）。移植约定见 `apps/api-bun/CONVENTIONS.md`。

## 快速开始

```bash
cd apps/api-bun
bun install
cp ../../.env.example ../../.env   # 按需修改
bun run src/index.ts
```

本地静态检查与单元测试（不启动服务）：

```bash
cd apps/api-bun
bun run typecheck
bun test
```

后端与问答效果的真实环境测试使用 TypeScript + Bun 编写的 [`cli/`](cli/README.md)：

```bash
cd cli
bun install
bun run verify
bun link
documind init
```

## 文档

- [产品定位与需求](docs/prd.md)
- [技术架构](docs/tech.md)
- [门户统一登录接入方案](docs/access-control/portal-sso-integration.md)
- [设计系统](DESIGN.md)

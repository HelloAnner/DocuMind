# DocuMind 协作说明

DocuMind 是企业级文档智能问答系统：Rust API + Agent Kernel 承载后端能力，Next.js 静态导出后由 Rust 单二进制内嵌并对外服务。

## 运行环境

- `ssh documind` 是 DocuMind 的独立服务器环境，不是普通跳板机；部署、端口、日志、PostgreSQL / Redis / RabbitMQ 等运行时状态都以这台机器为准。
- 默认优先服务器环境：部署、排查、验收和端到端测试都在 `ssh documind` 上确认。
- 本地环境不允许启动任何 DocuMind 服务器、前端 dev server、预览服务器或临时服务（包括但不限于 `next dev`、`next start`、`npm run dev`、`python -m http.server`、`serve`、本地 Rust API 进程等）；本地只用于编辑代码、静态检查、构建和生成发布包。
- 当前仓库用于构建发布包；服务器部署根目录是 `/opt/documind`，采用 `releases/<timestamp>` + `current` + `shared` 的发布结构。
- DocuMind 启动端口和访问端口统一为服务器 `8089`。
- DocuMind 是独立系统，默认使用自身认证页面、认证逻辑、用户与权限体系。
- 门户接入只是 DocuMind 支持的一个可选功能；除非明确启用 `AUTH_LOGIN_MODE=portal`，否则不按门户托管系统处理。

## 部署

- 用户说“部署 DocuMind”或“make deploy”时，视为授权执行 `make deploy`，并在 `ssh documind` 上完成部署与验证。
- `make deploy` 会先构建 Next.js 静态导出，再交叉编译 Linux amd64/musl 二进制，最后上传到 `ssh documind:/opt/documind` 并重启远端进程。
- 关键变量：
  - `DEPLOY_HOST=documind`
  - `DEPLOY_PORT=8089`
  - `DEPLOY_BASE_PATH=/documind`
  - `DEPLOY_TARGET=x86_64-unknown-linux-musl`
- 常用命令：
  - `make deploy`：构建发布包并部署到 `ssh documind`
  - `make status`：查看远端 DocuMind 进程、8089 端口和日志目录
  - `make health`：在服务器上检查 `127.0.0.1:8089/api/health` 与 `127.0.0.1:8089/documind/`
  - `make logs`：查看 `/opt/documind/shared/logs/documind-8089.log`

## 开发流程

- 任何功能改动完成后，都应通过 `make deploy` 自动部署到 `ssh documind` 服务器，并在服务器上完成验证与测试；不以本地环境作为最终测试依据。
- 所有功能验证、页面验收、端到端测试、浏览器截图与交互检查，都必须访问 `ssh documind` 上运行的服务器实例（`127.0.0.1:8089` 或通过 SSH 隧道访问该远端实例），不得访问本地启动的服务。
- 若改动涉及前端页面：
  1. 先在 `documind.pen` 中完成页面设计，确保视觉与交互方案优秀、与整体风格一致；
  2. 再按设计稿实现前端代码（Next.js 静态导出部分）；
  3. 最后与 Rust API 对接，保证前后端功能与数据流对齐。
- 若改动仅涉及后端，则先完成 API/领域逻辑，再通过 `make deploy` 部署到服务器验证。
- 所有端到端测试、验收测试均在 `ssh documind` 服务器环境执行，确保与生产运行环境一致。

## 服务器依赖隔离

- `ssh documind` 是 DocuMind 的专属服务器，仅运行 DocuMind 服务，不与其他系统混用资源。
- 全部基础组件都在该服务器上完整部署，默认容器名包括：`documind-postgres`、`documind-redis`、`documind-rabbitmq`、`documind-elasticsearch`。
- 所有数据全部外挂到宿主机持久化目录（如 `/opt/documind/shared/data/*` 或独立数据盘），容器仅作为计算实例运行，不保存业务数据；升级或重建容器不会丢失数据。
  - PostgreSQL 默认使用 `documind_dev` 数据库与 `documind` schema，并通过 `DATABASE_URL` 设置 `search_path=documind,public`。
  - Redis 默认使用独立实例的默认 DB；如需多环境隔离，优先在服务器 `.env` 中显式配置。
  - RabbitMQ 当前代码只保留连接配置；后续落队列时使用 `documind.*` 命名前缀。
  - Elasticsearch 用于文档检索与语义搜索，按 DocuMind 业务需求独立配置索引与映射，索引数据同样外挂持久化。
- 远端 `.env` 位于 `/opt/documind/shared/.env`，由 `scripts/deploy.sh` 管理；密钥类配置需要改动时优先直接改服务器文件。

## 访问

- 服务器对外访问端口统一为 `8089`。
- 期望访问入口：`http://<server>:8089/documind/`。

## 代码规范

- 优先彻底重构而非局部修补；当现有模块出现职责混乱、过度耦合或大量兜底逻辑时，应直接按领域边界重新设计。
- 后端 Rust 代码遵循领域驱动的小文件组织方式：按领域（domain）拆分为多个聚焦的模块，每个 `.rs` 文件不超过 500 行。
- 禁止使用兜底逻辑（如宽泛的 `unwrap`、`expect`、隐式默认值、空实现、catch-all 分支等）；所有分支与错误必须显式处理，缺失路径应返回明确错误而非静默跳过。
- 每层职责单一：路由层只处理 HTTP、服务层编排业务、仓库层封装持久化、领域层表达核心规则；禁止跨层直接调用或把业务逻辑堆在 handler 中。
- 优先使用最佳架构（如六边形/端口适配器、清晰的分层、依赖注入接口）保持可测试、可替换；新增功能必须先定义接口/契约，再实现适配器。
- 重构时同步拆分对应测试文件，保持测试与源码同粒度；不允许为了通过测试保留临时兼容层或 shim。

## Git 边界

- 不自动 `git add`、`git commit`、`git push`。
- 提交、推送、切分支、合并、rebase、reset、tag、PR/MR 等操作都必须用户逐次明确授权。


<claude-mem-context>
# Memory Context

# claude-mem status

This project has no memory yet. The current session will seed it; subsequent sessions will receive auto-injected context for relevant past work.

Memory injection starts on your second session in a project.

`/learn-codebase` is available if the user wants to front-load the entire repo into memory in a single pass (~5 minutes on a typical repo, optional). Otherwise memory builds passively as work happens.

Live activity: http://localhost:37701
How it works: `/how-it-works`

This message disappears once the first observation lands.
</claude-mem-context>

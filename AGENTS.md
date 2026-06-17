# DocuMind 协作说明

DocuMind 是企业级文档智能问答系统：Rust API + Agent Kernel 承载后端能力，Next.js 静态导出后由 Rust 单二进制内嵌并对外服务。

## 运行环境

- `ssh documind` 是 DocuMind 的独立服务器环境，不是普通跳板机；部署、端口、日志、PostgreSQL / Redis / RabbitMQ 等运行时状态都以这台机器为准。
- 默认优先服务器环境：部署、排查、验收和端到端测试都在 `ssh documind` 上确认。
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

## 服务器依赖隔离

- DocuMind 服务器使用独立基础组件，默认容器名为：`documind-postgres`、`documind-redis`、`documind-rabbitmq`。
- DocuMind 不复用 Northline 的数据库、Redis 或 RabbitMQ。
  - PostgreSQL 默认使用 `documind_dev` 数据库与 `documind` schema，并通过 `DATABASE_URL` 设置 `search_path=documind,public`。
  - Redis 默认使用独立实例的默认 DB；如需多环境隔离，优先在服务器 `.env` 中显式配置。
  - RabbitMQ 当前代码只保留连接配置；后续落队列时使用 `documind.*` 命名前缀。
- 远端 `.env` 位于 `/opt/documind/shared/.env`，由 `scripts/deploy.sh` 管理；密钥类配置需要改动时优先直接改服务器文件。

## 访问

- 服务器对外访问端口统一为 `8089`。
- 期望访问入口：`http://<server>:8089/documind/`。

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

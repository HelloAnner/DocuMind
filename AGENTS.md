# DocuMind 协作说明

DocuMind 是企业级文档智能问答系统：Rust API + Agent Kernel 承载后端能力，Next.js 静态导出后由 Rust 单二进制内嵌并对外服务。

## 运行环境

- `ssh northline` 是服务器环境，不是普通跳板机；部署、端口、日志、PostgreSQL / Redis / RabbitMQ 等运行时状态都以这台机器为准。
- 本地仓库用于开发和构建；服务器部署根目录是 `/opt/documind`，采用 `releases/<timestamp>` + `current` + `shared` 的发布结构。
- 本地 Northline 源代码位于 `$HOME/Northline`，必要时可以查看其 Makefile、部署脚本和 AGENTS.md 作为同机部署参考。
- DocuMind 服务端口固定为服务器本地 `5555`，对外通过原生 Nginx 的 `:6688/documind/` 访问。
- Northline 同机运行，Nginx 的 `:6688/northline/` 代理到服务器本地 Northline 端口 `6666`。
- 当前阶段不需要登录页面和登录机制；访问根路径应直接进入 DocuMind 工作台。

## 部署

- 用户说“部署 DocuMind”或“make deploy”时，视为授权执行本地 `make deploy`。
- `make deploy` 会先构建 Next.js 静态导出，再交叉编译 Linux amd64/musl 二进制，最后上传到 `ssh northline:/opt/documind` 并重启远端进程。
- 关键变量：
  - `DEPLOY_HOST=northline`
  - `DEPLOY_PORT=5555`
  - `DEPLOY_BASE_PATH=/documind`
  - `DEPLOY_TARGET=x86_64-unknown-linux-musl`
- 常用命令：
  - `make deploy`：本地构建并部署到 `ssh northline`
  - `make status`：查看远端 DocuMind 进程、5555 端口、Nginx 6688 和日志目录
  - `make health`：检查 `127.0.0.1:5555/api/health` 与 `127.0.0.1:6688/documind/`
  - `make logs`：查看 `/opt/documind/shared/logs/documind-5555.log`

## 服务器依赖隔离

- 服务器已有 Northline 的基础组件：`northline-postgres`、`northline-redis`、`northline-rabbitmq`。
- DocuMind 复用这些组件但做隔离：
  - PostgreSQL 使用同库 `northline_dev` 的 `documind` schema，并通过 `DATABASE_URL` 设置 `search_path=documind,northline,public`；`northline` 只用于复用服务器上已安装的 Postgres 扩展函数。
  - Redis 使用 DB `1`，避免与 Northline 默认 DB `0` 冲突。
  - RabbitMQ 当前代码只保留连接配置，使用同一本地 broker；后续落队列时使用 `documind.*` 命名前缀。
- 远端 `.env` 位于 `/opt/documind/shared/.env`，由 `scripts/deploy.sh` 管理；密钥类配置需要改动时优先直接改服务器文件。

## Nginx

- 服务器安全组只开放 `6688`，所以对外入口统一是 Nginx。
- 期望代理关系：
  - `http://<server>:6688/northline/` -> `http://127.0.0.1:6666/`
  - `http://<server>:6688/documind/` -> `http://127.0.0.1:5555/`
- 修改 Nginx 后必须执行 `nginx -t`，再 reload。

## Git 边界

- 不自动 `git add`、`git commit`、`git push`。
- 提交、推送、切分支、合并、rebase、reset、tag、PR/MR 等操作都必须用户逐次明确授权。

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

- 每一个功能开发和缺陷修复都执行下述全自动闭环；常规的建分支、创建 worktree、部署、测试、提交、rebase、合并、推送和清理无需再次向用户确认。只有出现无法安全自动处理的冲突、认证失败、远端不可用、用户已有改动会被覆盖等真实阻塞时，才停止并报告。
- 每个较大的独立功能必须使用一个单独的 Git worktree 和临时本地分支进行隔离；缺陷修复也默认在独立 worktree 中完成。多个功能可以在不同 worktree 中开发，但部署、服务器验收和合并到主分支必须串行执行，避免互相覆盖。
- 默认主分支必须根据仓库配置或 `origin/HEAD` 动态确认；当前仓库为 `main`。`main` 永远是所有已经完成并通过验收的功能与修复的最终汇总分支，worktree 临时分支不是交付分支。
- 开始开发前自动获取远端状态，并从最新的 `origin/main` 创建功能 worktree；不得把主工作区或其他 worktree 中用户已有的改动带入功能分支，也不得为了开始任务擅自丢弃、覆盖或隐藏这些改动。
- 在功能 worktree 中完成实现、本地静态检查和构建，只暂存当前功能相关文件并创建内容准确的候选 commit。进入服务器验收前先获得全局部署锁，再获取最新远端状态、把临时分支 rebase 到最新 `main` 并重新执行受影响的检查；检查通过后通过 `make deploy` 自动部署到 `ssh documind`，并在真实服务器环境完成验证与测试，不以本地环境作为最终测试依据。
- 所有功能验证、页面验收、端到端测试、浏览器截图与交互检查，都必须访问 `ssh documind` 上运行的服务器实例（`127.0.0.1:8089` 或通过 SSH 隧道访问该远端实例），不得访问本地启动的服务。
- 部署后至少执行与改动相称的 `make status`、`make health`、服务日志检查、API 测试和端到端测试。涉及前端时，必须通过浏览器自动化访问服务器实例，实际操作关键路径并按需截图；涉及问答、Agent 或检索时，必须在服务器上用真实对话覆盖成功、失败和边界场景，并核对回答、引用、权限及日志。
- 若改动涉及前端页面：
  1. 先在 `documind.pen` 中完成页面设计，确保视觉与交互方案优秀、与整体风格一致；
  2. 再按设计稿实现前端代码（Next.js 静态导出部分）；
  3. 最后与 Rust API 对接，保证前后端功能与数据流对齐。
- 若改动仅涉及后端，则先完成 API/领域逻辑，再通过 `make deploy` 部署到服务器验证。
- 服务器验收发现问题时，在原功能 worktree 中修复、创建新的候选 commit，并重新部署和验收；不得直接修改服务器文件或让服务器运行无法对应到明确 commit 的未提交代码。
- 集成前再次获取最新远端状态；如果远端 `main` 已变化，则把临时分支 rebase 到最新 `main`、重新执行受影响的检查，并在最终代码发生变化时重新部署和服务器复验。随后在主工作区把临时分支以 fast-forward-only 方式合并到 `main`。对于会改变可部署产物的功能或修复，必须从最终 `main` 再次部署并完成服务器验收，确保服务器运行内容与最终主分支一致；随后自动将 `main` 推送到 `origin`。不得强制推送，不默认推送临时功能分支，也不默认创建 PR。
- 推送成功后确认远端 `main` 包含功能提交、服务器健康且运行版本与 `main` 一致；然后自动移除已完成的 worktree、清理失效元数据并安全删除已经完全合并的临时本地分支。
- 只有“功能已进入并推送到远端 `main`、服务器部署成功、真实环境验收通过、临时 worktree 已安全清理”全部满足时，一个功能开发或缺陷修复才算完成。任一步失败都不得宣称完成，也不得使用强制合并、强制推送、跳过测试或删除现场等方式绕过。

## 部署互斥与串行发布

- 所有功能 worktree 可以并行开发、执行本地静态检查和构建，但共享的 `ssh documind` 部署环境、`/opt/documind/current`、基础组件和 8089 端口属于单一验收槽位，任何时刻只允许一个功能占用。
- 全局部署锁使用服务器目录 `/opt/documind/shared/runtime/deploy.lock` 作为互斥租约。进入发布流程时必须通过原子 `mkdir` 成功创建该目录，并在目录中记录 worktree、分支、候选 commit、操作者和开始时间；目录已存在即表示其他功能正在发布，当前功能必须等待，不得覆盖、复用或删除他人的锁。
- 部署锁的持有范围必须完整覆盖：获取最新远端状态、功能分支 rebase、候选版本部署、服务器验收、fast-forward 合并到 `main`、从最终 `main` 重新部署、最终验收、推送 `origin/main` 和远端版本确认。不得在候选版本验收后提前释放锁。
- 持有部署锁期间，其他 worktree 禁止执行 `make deploy`、修改 `/opt/documind/current`、重启 DocuMind、执行数据库迁移，或运行会改变共享数据和部署状态的测试；可以继续本地开发、静态检查和构建，并等待进入串行发布队列。
- 前一个功能完成合并后，后续功能必须重新获取 `origin/main`，并 rebase 到已经包含前序功能的最新 `main`，再进入部署验收流程；基于旧 `main` 得出的构建和服务器验收结果不得直接复用。
- 正常完成时，只有确认远端 `main` 已包含功能提交、服务器健康且运行版本与该 `main` 一致后才能删除部署锁。候选部署、验收、合并或推送失败时，必须先重新部署并验证当前远端 `main`，再释放锁；无法安全恢复时保留 worktree 和锁现场并报告，不得继续部署下一个功能。
- 发现遗留锁时，必须先读取锁内的归属信息并确认原发布流程已经终止，同时核对服务器当前版本和远端 `main`；不能确认锁已失效时不得擅自删除。

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

## DocuMind CLI：后端与问答效果测试入口

- 仓库内的 `cli/` 是 DocuMind 官方开发诊断 CLI，命令名为 `documind`，使用 TypeScript + Bun 构建。它只连接真实服务器，不会也不得在本地启动 DocuMind 服务。
- 凡是后端能力、问答效果、多轮上下文、Agent/ReAct 步骤、工具调用、耗时、引用、检索轨迹、文档切片或向量索引相关测试，默认优先使用此 CLI；前端页面与交互仍使用 Agent Browser 访问服务器实例验收。
- 初次安装与检查：
  - `cd cli && bun install`
  - `bun run verify`：依次执行 TypeScript 类型检查、Bun 单元测试和单文件可执行程序构建。
  - `bun link`：把 `documind` 命令链接到 Bun 的全局 bin；也可直接使用 `cli/dist/documind`。
- CLI 配置默认位于 `~/.config/documind/config.toml`，也可用 `--config` 或 `DOCUMIND_CONFIG` 指定。执行 `documind init` 创建配置；默认真实环境为 `http://123.57.255.204:8089`、用户 `Anner`、租户 slug `acme`、SSH host `documind`。密码优先通过 `DOCUMIND_PASSWORD` 提供，不得把真实密码、JWT 或 `session.json` 提交到仓库。
- 部署后的标准后端验收顺序：
  1. `documind health` 与 `documind doctor` 检查 API、认证、租户知识库和服务器内 Elasticsearch 连通性；
  2. `documind chat --json --kb <kb-id> '<问题>'` 发起真实 SSE 对话，检查最终回答、token、耗时、引用、Atom 事件和落库 trace；
  3. `documind chat --continue --json '<追问>'` 或指定 `--conversation` 验证多轮上下文；
  4. `documind run cli/examples/conversation-scenario.json --json` 执行可断言的多轮回归；
  5. `documind conversations show <id> --json` 和 `documind traces show <conversation-id> <assistant-message-id> --json` 核对数据库持久化结果；
  6. `documind vector audit` 对比 PostgreSQL 当前 chunks 与 Elasticsearch 实际文档，使用 `vector list/search/get` 查看当前租户授权范围内的真实索引内容。
- `chat --json` 的结果同时包含实时 SSE/Atom events 和服务端落库后的 message、query trace、agent trace、retrieval traces、citations；后端效果结论应以这份合并结果为依据，不只观察流式正文。
- `vector list/search/get` 通过 SSH 从 `ssh documind` 内部访问 Elasticsearch，并强制附加当前 JWT 身份对应的 `tenant_id` 与 `allowed_kb_ids`。真实 dense 向量召回结果以问答报告内 `trace.retrieval_traces` 的 `source=dense` 为准；直接 `vector search` 用于检查索引文本与元数据。
- CLI 的完整命令、TOML 字段、JSON 场景格式和安装说明见 `cli/README.md`。新增后端能力时，应同步考虑 CLI 是否需要增加相应测试命令或报告字段。

## 代码规范

- 优先彻底重构而非局部修补；当现有模块出现职责混乱、过度耦合或大量兜底逻辑时，应直接按领域边界重新设计。
- 后端 Rust 代码遵循领域驱动的小文件组织方式：按领域（domain）拆分为多个聚焦的模块，每个 `.rs` 文件不超过 500 行。
- 禁止使用兜底逻辑（如宽泛的 `unwrap`、`expect`、隐式默认值、空实现、catch-all 分支等）；所有分支与错误必须显式处理，缺失路径应返回明确错误而非静默跳过。
- 每层职责单一：路由层只处理 HTTP、服务层编排业务、仓库层封装持久化、领域层表达核心规则；禁止跨层直接调用或把业务逻辑堆在 handler 中。
- 优先使用最佳架构（如六边形/端口适配器、清晰的分层、依赖注入接口）保持可测试、可替换；新增功能必须先定义接口/契约，再实现适配器。
- 重构时同步拆分对应测试文件，保持测试与源码同粒度；不允许为了通过测试保留临时兼容层或 shim。

## Git 自动化授权与安全边界

- 用户已明确授权上述完整开发闭环：对功能开发和缺陷修复，可自动执行所需的 `git add`、`git commit`、worktree/临时分支创建与清理、`rebase`、fast-forward 合并和向 `origin/main` 推送，无需逐次询问。
- 自动化授权仅覆盖当前任务所需改动。提交前必须检查 diff，只暂存和提交当前功能相关文件；用户预先存在的改动、其他任务的改动和无关生成文件一律保留，不得混入提交。
- 不自动执行会改写共享历史或可能丢失数据的操作，包括但不限于强制推送、破坏性 reset、丢弃用户改动、机械选择 `ours`/`theirs` 解决冲突。此类情况必须停止并向用户说明。
- 如果主工作区不干净但脏文件与当前任务无关，可以继续在独立 worktree 开发；进入 `main` 集成前必须确认可以在不影响这些文件的前提下安全完成 fast-forward 合并和推送，否则保留功能 worktree 并报告阻塞。


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

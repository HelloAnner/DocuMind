# DocuMind TS 后端移植约定

本文档是所有 Rust→TS 移植工作的强制约定。移植目标是**行为等价**：API 契约、数据库读写、错误码、SSE 事件序列必须与 Rust 版本一致。

## 源码对照

TypeScript 实现已是唯一后端（Rust 版已从仓库删除，历史见 git）。
各文件头部保留 `移植自 apps/api-rs/...` 出处注释用于追溯语义；需要对照原文时用
`git show <删除 Rust 前的 commit>:apps/api-rs/src/<文件>` 取回。
原始对照关系如下（Rust → TS）：

| Rust | TS |
|---|---|
| config.rs | src/config.ts（已移植） |
| error.rs | src/errors.ts（已移植） |
| auth.rs | src/auth/ |
| models/ | src/models/ |
| api/ | src/api/ |
| agent/ | src/agent/ |
| document/ | src/document/ |
| llm/ | src/llm/ |
| rag/ | src/rag/ |
| repositories/ | src/repositories/ |
| storage/ | src/storage/ |
| state.rs | src/state.ts |
| lib.rs (run/app 装配) | src/app.ts + src/index.ts |

## 硬性规则

1. **JSON key 必须与 Rust serde 输出完全一致**。Rust struct 字段默认序列化为字段原名（snake_case）；只有标注 `#[serde(rename_all = "camelCase")]` 的 DTO 才用 camelCase。枚举标注 `rename_all = "snake_case"` → TS 字符串字面量联合类型（小写 snake）。
2. **HTTP 错误响应格式**：`{"code": "...", "message": "..."}`，状态码映射见 src/errors.ts 的 `AppError`，必须逐一对齐（404/403/409/400/401/504/500）。
3. **数据库**：postgres.js（`postgres` 包）。SQL 语句从 Rust sqlx 原样复制，占位符 $1..$n 不变。uuid 列直接传字符串；timestamp 传 Date 或 ISO 字符串；jsonb 传对象。查询返回行按 Rust `query_as`/row.get 的顺序取值。
4. **时间序列化**：chrono DateTime<Utc> → RFC3339。统一用 src/infra/time.ts 的 `toRfc3339()`（毫秒为 0 时输出不带 .000 的 ISO，与 serde 一致）。
5. **UUID**：用 crypto.randomUUID()（infra/uuid.ts re-export）。禁止引入 uuid 包。
6. **禁止兜底逻辑**：不捕获后忽略错误；不用 any 掩盖类型；缺失分支返回显式错误，与 Rust 的显式错误风格一致。所有 async 函数错误显式声明/抛出 AppError 或 Error。
7. **每个 .ts 文件 ≤ 500 行**，按领域拆小文件，与 Rust 文件一一对应或合理拆分。
8. **日志**：console.log/error + 简单前缀 `[documind][模块]`，不引入 pino 等日志库。
9. **HTTP 框架 Hono**。handler 签名 `(c: Context<AppEnv>) => Promise<Response>`，actor 通过 `c.get('actor')` 获取（middleware 已注入）。SSE 用 hono/streaming 的 streamSSE。
10. **测试**：bun:test，测试文件与被测文件同目录 `*.test.ts` 或 `tests/` 下，移植 Rust `#[cfg(test)]` 用例。
11. **环境变量读取只能经过 src/config.ts** 的 loadConfig()；模块不得直接读 process.env（除 config.ts 本身）。
12. **不修改 apps/api-rs 下任何 Rust 文件**（删除阶段除外）。

import { VERSION } from "./version.ts";

export function printHelp(path: string[]): void {
  const topic = path[0];
  if (topic === "chat") {
    process.stdout.write(CHAT_HELP);
    return;
  }
  if (topic === "vector") {
    process.stdout.write(VECTOR_HELP);
    return;
  }
  if (topic === "run") {
    process.stdout.write(RUN_HELP);
    return;
  }
  process.stdout.write(HELP);
}

const HELP = `DocuMind CLI ${VERSION} — 真实环境对话与检索诊断\n\n` +
  `用法: documind <command> [options]\n\n` +
  `初始化与连接\n` +
  `  init                         创建 ~/.config/documind/config.toml\n` +
  `  config show|path             查看脱敏配置或配置路径\n` +
  `  auth login|whoami|logout     登录、身份检查、退出\n` +
  `  health                       检查真实服务器健康状态\n` +
  `  doctor                       检查 API、认证、租户与 Elasticsearch\n\n` +
  `对话与评测\n` +
  `  chat|ask <问题>              真实 SSE 对话并合并落库 trace\n` +
  `  chat --interactive           多轮交互 REPL\n` +
  `  run <scenario.json>          运行 JSON 多轮评测场景\n` +
  `  conversations list|create|show|messages|delete\n` +
  `  traces show <会话ID> <消息ID>\n\n` +
  `知识与向量\n` +
  `  kb list                      查看当前租户可访问知识库\n` +
  `  documents list|show|chunks   查看 PostgreSQL 中的文档与切片\n` +
  `  vector indexes|audit|count|list|search|get\n\n` +
  `全局选项\n` +
  `  --config <path>              指定 TOML 配置\n` +
  `  --json, -j                   机器可读 JSON 输出\n` +
  `  --help, -h                   查看帮助\n` +
  `  --version, -V                查看版本\n\n` +
  `运行 documind help chat|run|vector 查看详细帮助。\n`;

const CHAT_HELP = `用法: documind chat [问题] [options]\n\n` +
  `  --conversation, -c <id>      在指定会话继续多轮对话\n` +
  `  --continue                   使用本地记录的上一次会话\n` +
  `  --kb, -k <id[,id]>           指定知识库，可重复\n` +
  `  --title <title>              新会话标题\n` +
  `  --trace, -t off|summary|full 人类输出的诊断详细度\n` +
  `  --events                     显示实时步骤（默认人类输出已显示）\n` +
  `  --json                       输出含 events/trace/citations 的完整 JSON\n` +
  `  --ndjson                     每个 SSE 事件一行，末行输出 report\n` +
  `  --input-json <json|@file|->  用 JSON 提供 content/conversation_id/kb_ids\n` +
  `  --interactive, -i            多轮 REPL\n` +
  `  --quiet, -q                  只输出回答正文\n`;

const VECTOR_HELP = `用法: documind vector <subcommand> [options]\n\n` +
  `  indexes                      API 返回的租户向量索引健康统计\n` +
  `  audit                        对比 PostgreSQL 当前 chunks 与 ES 实际数量\n` +
  `  count [--kb ID] [--doc ID]  从服务器 Elasticsearch 统计真实文档数\n` +
  `  list [--kb ID] [--doc ID]   浏览真实 chunks 索引内容\n` +
  `  search <文本>                在真实索引中做关键词内容检索\n` +
  `  get <chunk-id>               读取指定向量文档\n` +
  `  --limit N --offset N         分页\n` +
  `  --include-embedding          包含完整 embedding（JSON 可能很大）\n\n` +
  `所有查询都强制附加当前登录身份的 tenant_id 和 allowed_kb_ids。\n` +
  `真实稠密向量召回请使用 chat，并查看 trace.retrieval_traces 中的 dense 结果。\n`;

const RUN_HELP = `用法: documind run <scenario.json|-> [--json] [--output report.json]\n\n` +
  `场景示例:\n` +
  `{\n` +
  `  "name": "采购制度多轮测试",\n` +
  `  "conversation": {"kb_ids": ["..."]},\n` +
  `  "turns": [\n` +
  `    {"content": "付款条件是什么？", "expect": {"status": "completed", "citations_min": 1}},\n` +
  `    {"content": "刚才提到的期限呢？", "expect": {"retrievals_min": 1}}\n` +
  `  ]\n` +
  `}\n`;

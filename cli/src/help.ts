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
  if (topic === "kb") {
    process.stdout.write(KB_HELP);
    return;
  }
  if (topic === "documents" || topic === "document") {
    process.stdout.write(DOCUMENTS_HELP);
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
  `  kb list|show|create|update|delete\n` +
  `  documents <subcommand>       文档上传、解析、下载与完整管理\n` +
  `  vector indexes|audit|count|list|search|get\n\n` +
  `全局选项\n` +
  `  --config <path>              指定 TOML 配置\n` +
  `  --json, -j                   机器可读 JSON 输出\n` +
  `  --help, -h                   查看帮助\n` +
  `  --version, -V                查看版本\n\n` +
  `运行 documind help chat|run|kb|documents|vector 查看详细帮助。\n`;

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

const KB_HELP = `用法: documind kb <subcommand> [options]\n\n` +
  `  list                         列出租户全部知识库（需要管理权限）\n` +
  `  list --accessible            列出当前用户可访问的知识库\n` +
  `  show <kb-id>                 查看知识库\n` +
  `  create --name NAME           创建知识库\n` +
  `  update <kb-id> [options]     更新知识库，未指定字段保持不变\n` +
  `  delete <kb-id> --force       删除知识库及其文档和解析数据\n\n` +
  `写入选项:\n` +
  `  --name NAME                  名称\n` +
  `  --description TEXT           描述；使用 --description= 可清空\n` +
  `  --status active|disabled|archived\n` +
  `  --tag TAG                    标签，可重复或使用逗号分隔\n` +
  `  --tags TAG[,TAG]             标签列表\n`;

const DOCUMENTS_HELP = `用法: documind documents <subcommand> [options]\n\n` +
  `查询与内容:\n` +
  `  list [--kb ID] [--status S] [--query Q] [--limit N]\n` +
  `  show <doc-id>                文档、解析任务和各内容区段摘要\n` +
  `  preview|blocks|cleaned-blocks|chunks|tables <doc-id>\n\n` +
  `文件与知识库管理:\n` +
  `  upload <file> --kb ID        上传文件到当前租户的指定知识库\n` +
  `  download <doc-id> [--output PATH] [--force]\n` +
  `  move <doc-id> --kb ID        移动到目标知识库\n` +
  `  replace <doc-id> <file>      替换原件并重新解析\n` +
  `  delete <doc-id> --force      删除原件、解析数据和检索索引\n\n` +
  `解析与索引管理:\n` +
  `  retry <doc-id>               重新解析单个文档\n` +
  `  retry-batch <id...>          批量重新解析（最多 50 个）\n` +
  `  force-index <doc-id>         确认低置信结果并强制索引\n` +
  `  exclude <doc-id> --force     保留文件但排除检索\n` +
  `  ocr <doc-id>                 将低置信 PDF 送入 OCR\n` +
  `  wait <doc-id>                等待文档达到目标状态\n\n` +
  `异步等待选项（upload/retry/replace/ocr/wait）:\n` +
  `  --wait                       操作后等待（默认目标 indexed）\n` +
  `  --until STATUS               目标状态\n` +
  `  --timeout SECONDS            最长等待时间，默认 300\n` +
  `  --interval SECONDS           轮询间隔，默认 1\n` +
  `所有管理操作自动限定为当前登录租户，并由服务端校验权限。\n`;

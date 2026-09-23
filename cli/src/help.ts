import { VERSION } from "./version.ts";

export function printHelp(path: string[]): void {
  const topic = path[0];
  if (topic === "skills") {
    process.stdout.write(SKILLS_HELP);
    return;
  }
  if (topic === "system") {
    process.stdout.write(SYSTEM_HELP);
    return;
  }
  if (topic === "admin") {
    process.stdout.write(ADMIN_HELP);
    return;
  }
  if (topic === "invitation") {
    process.stdout.write(INVITATION_HELP);
    return;
  }
  if (topic === "conversations") {
    process.stdout.write(CONVERSATIONS_HELP);
    return;
  }
  if (topic === "feedback") {
    process.stdout.write(FEEDBACK_HELP);
    return;
  }
  if (topic === "files") {
    process.stdout.write(FILES_HELP);
    return;
  }
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
  `  auth register|login [--platform]|whoami|logout  注册、登录、身份检查、退出\n` +
  `  auth profile                查看展示名称与头像\n` +
  `  auth profile-update [--name N] [--avatar-url URL|--clear-avatar]\n` +
  `  auth tenants|switch <id>     列出并切换当前账号的企业空间\n` +
  `  health                       检查真实服务器健康状态\n` +
  `  doctor                       检查 API、认证、租户与 Elasticsearch\n` +
  `  external doctor|whoami       使用 DOCUMIND_API_TOKEN 检查外部 API\n` +
  `  external chat <问题>         使用外部 API Token 真实问答\n` +
  `  external verify              自动验证真实问答、权限、限流与租户隔离\n` +
  `  api-clients list|create      管理租户 MCP / API 客户端与 Token\n` +
  `  mcp tools                    列出 Token 可用的 MCP 工具\n` +
  `  mcp ask <问题>               通过 MCP 执行真实文档问答\n` +
  `  skills list|show|create|update|delete|upload|import|files  管理租户技能\n` +
  `  mcp verify                   验证工具发现与租户会话隔离\n\n` +
  `  system <subcommand>          平台后台全量查看与管理\n` +
  `  admin <subcommand>           租户后台全量查看与管理\n` +
  `  invitation <subcommand>      邀请创建、校验、接受、重发与撤销\n` +
  `对话与评测\n` +
  `  chat|ask <问题>              真实 SSE 对话并合并落库 trace\n` +
  `  models                       列出可选模型与深度思考能力\n` +
  `  files list|upload|show|download|delete  管理当前用户隔离文件\n` +
  `  chat --interactive           多轮交互 REPL\n` +
  `  run <scenario.json>          运行 JSON 多轮评测场景\n` +
  `  conversations list|create|show|messages|update|delete\n` +
  `  feedback set|clear <会话ID> <回答消息ID>  提交或清除真实用户反馈\n` +
  `  share create <会话ID> [--title T] | share show <token>\n` +
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
  `运行 documind help system|admin|chat|run|files|kb|documents|skills|vector 查看详细帮助。\n`;

const SKILLS_HELP = `用法: documind skills <subcommand> [options]\n\n` +
  `  list [--search TEXT] | show <技能ID或名称>\n` +
  `  create --name NAME --display-name TITLE --description TEXT --content-file SKILL.md\n` +
  `  update <技能ID> [--name NAME --display-name TITLE --description TEXT --content-file SKILL.md]\n` +
  `  delete <技能ID> --force | upload <skill.zip或SKILL.md> | import <HTTPS地址>\n` +
  `  files list <技能ID> | files show <技能ID> <路径> [--out 本地文件]\n` +
  `  files put <技能ID> <路径> --content-file 本地文件 [--force 覆盖已有文件]\n` +
  `  files rename <技能ID> <原路径> <新路径> | files delete <技能ID> <路径> --force\n\n` +
  `脚本使用 scripts/ 路径；参考文档建议使用 references/。仅保存/读取 UTF-8 文本，不执行脚本。\n` +
  `每个附属文件最多 256 KB、最多 100 个；SKILL.md 正文最多 64 KB；总文本及上传包最多 5 MB。\n` +
  `update 保留已有文件，files put 新建或更新单文件。所有命令支持 --json。\n`;

const SYSTEM_HELP = `用法: documind system <subcommand> [options]\n\n` +
  `查看: overview | tenants | tenant <id> | users | models | jobs | audit | settings | vectors | vector-reconcile | integrity\n` +
  `租户: tenant-create --name NAME [--slug S --plan P --expires-in-days N]\n` +
  `      tenant-update <id> [--name N --plan P --status S]\n` +

  `      tenant-delete <id> --slug S --force\n` +
  `设置: settings-set [--auth-token-expire-hours N] [--object-storage-presign-expire-seconds N]\n` +
  `向量: vector-rebuild --force\n` +
  `筛选: audit [--q TEXT --limit N]\n`;

const ADMIN_HELP = `用法: documind admin <subcommand> [options]\n\n` +
  `查看: overview | logs | members | permissions | permission-matrix | runtime-config\n` +
  `配置: chunking | search | embedding | llm（运行时只读配置）\n` +
  `成员: member-update <id> [--role ROLE --status STATUS] | member-remove <id> --force\n` +
  `权限: permission-grant --kb ID --subject-type role|user --subject ID --permission read|write|manage\n` +
  `      permission-revoke <id> --force\n` +
  `日志: logs [--range today|week|month|all --q TEXT --limit N]\n` +
  `质量: quality-summary | quality-cases [--status S --root-cause C --kb ID --q TEXT]\n` +
  `      quality-case <id> | quality-diagnose <id>\n` +
  `      quality-update <id> [--status S --root-cause C --resolution-note TEXT]\n` +
  `答案: corrections [--status S --q TEXT] | correction <id>\n` +
  `      correction-create --question Q --answer A [--alias Q --kb ID --case ID]\n` +
  `      correction-update <id> [--question Q --answer A --alias Q --valid-until DATE]\n` +
  `      correction-publish|correction-archive <id>\n` +
  `      correction-match --question Q [--kb ID]\n` +
  `      写入命令可用 --change-note TEXT 与 --source-json '[{...}]'\n` +
  `知识库、文档、文档任务和 API 接入分别使用 kb、documents、api-clients 命令。\n`;

const INVITATION_HELP = `用法: documind invitation <subcommand> [options]\n\n` +
  `租户邀请: list\n` +
  `          create --username USER [--role ROLE --expires-in-days N]\n` +
  `          resend <id> [--expires-in-days N] | revoke <id> --force\n` +
  `领取邀请: validate --token TOKEN | accept --token TOKEN\n` +
  `所有者邀请: owner-create <tenant-id> [--expires-in-days N]\n` +
  `            owner-resend <tenant-id> [--expires-in-days N]\n` +
  `            owner-revoke <tenant-id> --force\n`;

const CHAT_HELP = `用法: documind chat [问题] [options]\n\n` +
  `  --conversation, -c <id>      在指定会话继续多轮对话\n` +
  `  --continue                   使用本地记录的上一次会话\n` +
  `  --kb, -k <id[,id]>           指定知识库，可重复\n` +
  `  --file-id <id[,id]>          关联当前用户文件，可重复；文件不会进入公共知识库\n` +
  `  --title <title>              新会话标题\n` +
  `  --model <id>                 指定本次问答模型（省略时使用服务端 ENV 默认）\n` +
  `  --thinking / --no-thinking   开启或关闭本次深度思考\n` +
  `  --trace, -t off|summary|full 人类输出的诊断详细度\n` +
  `  --events                     显示实时步骤（默认人类输出已显示）\n` +
  `  --json                       输出含 events/trace/citations 的完整 JSON\n` +
  `  --ndjson                     每个 SSE 事件一行，末行输出 report\n` +
  `  --input-json <json|@file|->  用 JSON 提供 content/conversation_id/kb_ids\n` +
  `  --interactive, -i            多轮 REPL\n` +
  `  --quiet, -q                  只输出回答正文\n`;

const FILES_HELP = `用法: documind files <subcommand> [options]\n\n` +
  `  list [--conversation ID]     列出当前用户全部文件或指定会话文件\n` +
  `  upload <本地文件> [--path 相对路径] [--conversation ID]\n` +
  `  show <文件ID>                查看文件元数据和下载地址\n` +
  `  download <文件ID> [--output 本地路径] [--force]\n` +
  `  delete <文件ID> --force      删除当前用户文件\n\n` +
  `对话使用: documind chat \"问题\" --file-id <文件ID>；沙箱生成物自动出现在 files list。\n` +
  `Office 技能验收: 在 chat 中要求使用 cnpc-word、cnpc-excel 或 cnpc-ppt 生成文件。\n`;


const CONVERSATIONS_HELP = `用法: documind conversations <subcommand> [options]\n\n` +
  `  list [--limit N]             列出会话\n` +
  `  create [--kb ID] [--title T] 创建会话；不传 --kb 时默认全部可访问知识库\n` +
  `  show <id>                    查看会话、消息与检索轨迹\n` +
  `  messages <id>                查看会话消息\n` +
  `  update <id> --kb ID[,ID]     保存该会话使用的知识库组合\n` +
  `  update <id> --all            恢复为全部可访问知识库\n` +
  `  delete <id>                  删除会话\n`;

const FEEDBACK_HELP = `用法: documind feedback <subcommand> <会话ID> <回答消息ID> [options]\n\n` +
  `  set --rating up|down [--reason REASON --comment TEXT --correction TEXT]\n` +
  `  clear                        撤回当前用户对该回答的反馈\n` +
  `点踩原因: wrong_answer | missing_source | outdated | not_helpful | other\n`;

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

const RUN_HELP = `用法: documind run <scenario.json|-> [--file-id ID] [--json] [--output report.json]\n\n` +
  `场景示例:\n` +
  `{\n` +
  `  "name": "采购制度多轮测试",\n` +
  `  "conversation": {"kb_ids": ["..."]},\n` +
  `  "turns": [\n` +
  `    {"content": "分析上传文件", "file_ids": ["..."], "expect": {"status": "completed"}},\n` +
  `    {"content": "生成 Word 汇总", "expect": {"react_rounds_min": 1}}\n` +
  `  ]\n` +
  `}\n` +
  `命令行 --file-id 应用于未在 turn.file_ids 中单独指定的每一轮。\n` +
  `文件断言支持 expect.files_min 与 expect.file_extensions。\n` +
  `服务端验收: documind run cli/examples/dm-be-files-scenario.json --json\n`;

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
  `  list [--kb ID] [--status S] [--query Q] [--page N] [--page-size N]\n` +
  `  show <doc-id>                文档、解析任务和各内容区段摘要\n` +
  `  preview|blocks|cleaned-blocks|chunks|tables <doc-id>\n` +
  `  diagnose <doc-id>            布局、bbox、OCR、表格和告警诊断\n` +
  `  preview-file <doc-id>        验证原文预览传输：manifest、签名 URL 与字节范围\n\n` +
  `文件与知识库管理:\n` +
  `  upload <file...> --kb ID     批量上传文件（最多 50 个，并发 3）\n` +
  `  upload-batch <file...> --kb ID  upload 的显式批量别名\n` +
  `  jobs [--status STATUS]       查看当前租户文档处理队列与汇总\n` +
  `  job <job-id>                 查看阶段事件、错误与向量任务\n` +
  `  job-wait <job-id>            等待任务进入完成、警告或失败状态\n` +
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

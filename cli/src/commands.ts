import { createInterface } from "node:readline/promises";
import { readFile, writeFile } from "node:fs/promises";
import { ApiClient } from "./api.ts";
import {
  booleanOption,
  listOption,
  numberOption,
  type ParsedArgs,
  stringOption,
} from "./args.ts";
import { ChatService } from "./chat.ts";
import { documentCommand, knowledgeBaseCommand } from "./admin_commands.ts";
import {
  configPath,
  initializeConfig,
  loadConfig,
  redactedConfig,
} from "./config.ts";
import { CliError } from "./errors.ts";
import { printHelp } from "./help.ts";
import {
  LiveChatRenderer,
  printChatReport,
  printIdentity,
  printJson,
  printScenarioReport,
  printTable,
  printVectorHit,
  printVectorIndexes,
  printVectorResult,
} from "./render.ts";
import { loadScenario, runScenario } from "./scenario.ts";
import type { ChatRequest, MessageTraceResponse } from "./types.ts";
import { VectorDiagnostics } from "./vector.ts";
import { VERSION } from "./version.ts";

export async function dispatch(args: ParsedArgs): Promise<number> {
  const command = args.positionals[0];
  if (booleanOption(args, "version") || command === "version") {
    process.stdout.write(`documind ${VERSION}\n`);
    return 0;
  }
  if (!command || booleanOption(args, "help") || command === "help") {
    printHelp(args.positionals.slice(1));
    return 0;
  }

  const path = configPath(stringOption(args, "config"));
  if (command === "init") return initCommand(args, path);
  if (command === "config") return configCommand(args, path);

  const config = await loadConfig(path);
  const api = new ApiClient(config, path);
  const json = booleanOption(args, "json");

  switch (normalizeCommand(command)) {
    case "auth": return authCommand(args, api, json);
    case "health": return healthCommand(api, json);
    case "doctor": return doctorCommand(api, json);
    case "kb": return knowledgeBaseCommand(args, api, json);
    case "chat": return chatCommand(args, api, json);
    case "run": return runCommand(args, api, json);
    case "conversations": return conversationCommand(args, api, json);
    case "traces": return traceCommand(args, api, json);
    case "documents": return documentCommand(args, api, json);
    case "vector": return vectorCommand(args, api, json);
    default:
      throw new CliError(`未知命令: ${command}。运行 documind help 查看帮助`, 2);
  }
}

async function initCommand(args: ParsedArgs, path: string): Promise<number> {
  const url = stringOption(args, "url");
  const basePath = stringOption(args, "base-path");
  const username = stringOption(args, "username");
  const password = stringOption(args, "password");
  const passwordEnv = stringOption(args, "password-env");
  const tenant = stringOption(args, "tenant");
  const sshHost = stringOption(args, "ssh-host");
  const config = await initializeConfig(path, {
    ...(url ? { url } : {}),
    ...(basePath ? { basePath } : {}),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(passwordEnv ? { passwordEnv } : {}),
    ...(tenant ? { tenant } : {}),
    ...(sshHost ? { sshHost } : {}),
    force: booleanOption(args, "force"),
  });
  if (booleanOption(args, "json")) printJson({ path, config: redactedConfig(config) });
  else {
    process.stdout.write(`已创建 ${path}\n`);
    process.stdout.write(`服务器 ${config.server.url} · 用户 ${config.auth.username} · 租户 ${config.auth.tenant}\n`);
    if (!config.auth.password) {
      process.stdout.write(`登录前请设置 ${config.auth.password_env}=<password>\n`);
    }
  }
  return 0;
}

async function configCommand(args: ParsedArgs, path: string): Promise<number> {
  const subcommand = args.positionals[1] ?? "show";
  if (subcommand === "path") {
    process.stdout.write(`${path}\n`);
    return 0;
  }
  if (subcommand !== "show") throw new CliError(`未知 config 子命令: ${subcommand}`, 2);
  const config = await loadConfig(path);
  printJson({ path, config: redactedConfig(config) });
  return 0;
}

async function authCommand(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const subcommand = args.positionals[1] ?? "whoami";
  if (subcommand === "login") {
    const identity = await api.login(true);
    if (json) printJson(identity); else printIdentity(identity);
    return 0;
  }
  if (subcommand === "whoami") {
    const identity = await api.me();
    if (json) printJson(identity); else printIdentity(identity);
    return 0;
  }
  if (subcommand === "logout") {
    await api.logout();
    if (json) printJson({ logged_out: true }); else process.stdout.write("已退出并清除本地 token\n");
    return 0;
  }
  throw new CliError(`未知 auth 子命令: ${subcommand}`, 2);
}

async function healthCommand(api: ApiClient, json: boolean): Promise<number> {
  const health = await api.health();
  if (json) printJson(health);
  else {
    const value = health as Record<string, unknown>;
    process.stdout.write(`DocuMind ${value.ok === true ? "healthy" : "unhealthy"}\n`);
    printJson(value);
  }
  return (health as Record<string, unknown>).ok === true ? 0 : 1;
}

async function doctorCommand(api: ApiClient, json: boolean): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: unknown; error?: string }> = [];
  await doctorCheck(checks, "api.health", () => api.health());
  await doctorCheck(checks, "auth.identity", () => api.me());
  await doctorCheck(checks, "tenant.knowledge_bases", () => api.listKnowledgeBases());
  await doctorCheck(checks, "vector.elasticsearch", async () => ({
    count: await new VectorDiagnostics(api).count(),
  }));
  const ok = checks.every((check) => check.ok);
  if (json) printJson({ ok, server: api.baseUrl, checks });
  else {
    process.stdout.write(`DocuMind CLI doctor: ${ok ? "PASS" : "FAIL"}\n`);
    for (const check of checks) {
      process.stdout.write(`${check.ok ? "✓" : "✗"} ${check.name}${check.error ? ` — ${check.error}` : ""}\n`);
    }
  }
  return ok ? 0 : 1;
}

async function doctorCheck(
  checks: Array<{ name: string; ok: boolean; detail?: unknown; error?: string }>,
  name: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    checks.push({ name, ok: true, detail: await operation() });
  } catch (error) {
    checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function chatCommand(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  if (booleanOption(args, "interactive")) {
    if (json) throw new CliError("交互模式不能与 --json 同时使用", 2);
    return interactiveChat(args, api);
  }
  const request = await chatRequest(args, api);
  const trace = traceOption(args, api.config.chat.trace);
  const quiet = booleanOption(args, "quiet");
  const ndjson = booleanOption(args, "ndjson");
  const renderer = !json && !ndjson ? new LiveChatRenderer(quiet) : undefined;
  const service = new ChatService(api);
  const report = await service.send(request, {
    onEvent: (event) => {
      renderer?.onEvent(event);
      if (ndjson) process.stdout.write(`${JSON.stringify({ type: "event", event })}\n`);
    },
    onDelta: (text) => renderer?.onDelta(text),
  });
  if (ndjson) process.stdout.write(`${JSON.stringify({ type: "report", report })}\n`);
  else if (json) printJson(report);
  else printChatReport(report, { trace, quiet, streamed: true });
  return 0;
}

async function chatRequest(args: ParsedArgs, api: ApiClient): Promise<ChatRequest> {
  const inputJson = stringOption(args, "input-json");
  let input: Partial<ChatRequest> = {};
  if (inputJson) input = await parseChatJson(inputJson);
  const positional = args.positionals.slice(1).join(" ").trim();
  const content = input.content ?? stringOption(args, "content") ?? positional;
  if (!content) throw new CliError("chat 需要问题文本、--content 或 --input-json", 2);
  let conversationId = input.conversation_id ?? stringOption(args, "conversation");
  if (!conversationId && booleanOption(args, "continue")) {
    conversationId = await api.lastConversationId();
    if (!conversationId) throw new CliError("没有可继续的上一次会话", 2);
  }
  const requestedKbs = listOption(args, "kb");
  const kbIds = input.kb_ids ?? (requestedKbs.length ? requestedKbs : api.config.chat.kb_ids);
  const title = input.title ?? stringOption(args, "title");
  const clientRequestId = input.client_request_id ?? stringOption(args, "request-id");
  return {
    content,
    ...(conversationId ? { conversation_id: conversationId } : {}),
    kb_ids: kbIds,
    ...(title ? { title } : {}),
    ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
  };
}

async function parseChatJson(value: string): Promise<Partial<ChatRequest>> {
  let text = value;
  if (value === "-") text = await Bun.stdin.text();
  else if (value.startsWith("@")) text = await readFile(value.slice(1), "utf8");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("JSON root must be an object");
    return parsed as Partial<ChatRequest>;
  } catch (error) {
    throw new CliError("--input-json 无法解析", 2, error);
  }
}

async function interactiveChat(args: ParsedArgs, api: ApiClient): Promise<number> {
  const requestedKbs = listOption(args, "kb");
  let kbIds = requestedKbs.length ? requestedKbs : api.config.chat.kb_ids;
  let conversationId = stringOption(args, "conversation");
  if (!conversationId && booleanOption(args, "continue")) conversationId = await api.lastConversationId();
  let trace = traceOption(args, api.config.chat.trace);
  const service = new ChatService(api);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write("DocuMind 真实环境交互模式。/help 查看命令，/quit 退出。\n");
  try {
    while (true) {
      const line = (await readline.question("documind> ")).trim();
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;
      if (line === "/help") {
        process.stdout.write("/new [标题]  /use <会话ID>  /kb <ID,ID>  /trace off|summary|full  /quit\n");
        continue;
      }
      if (line.startsWith("/new")) {
        conversationId = await service.createConversation(kbIds, line.slice(4).trim() || "CLI 交互会话");
        process.stdout.write(`新会话 ${conversationId}\n`);
        continue;
      }
      if (line.startsWith("/use ")) {
        conversationId = line.slice(5).trim();
        await api.getConversation(conversationId);
        process.stdout.write(`已切换会话 ${conversationId}\n`);
        continue;
      }
      if (line.startsWith("/kb ")) {
        kbIds = line.slice(4).split(",").map((item) => item.trim()).filter(Boolean);
        process.stdout.write(`知识库范围 ${kbIds.join(", ") || "全部授权知识库"}\n`);
        continue;
      }
      if (line.startsWith("/trace ")) {
        trace = parseTrace(line.slice(7).trim());
        process.stdout.write(`trace=${trace}\n`);
        continue;
      }
      if (line.startsWith("/")) {
        process.stdout.write("未知交互命令；输入 /help\n");
        continue;
      }
      const renderer = new LiveChatRenderer(false);
      const report = await service.send({
        content: line,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        kb_ids: kbIds,
      }, {
        onEvent: (event) => renderer.onEvent(event),
        onDelta: (text) => renderer.onDelta(text),
      });
      conversationId = report.request.conversation_id;
      printChatReport(report, { trace, quiet: false, streamed: true });
    }
  } finally {
    readline.close();
  }
  return 0;
}

async function runCommand(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const path = args.positionals[1];
  if (!path) throw new CliError("run 需要场景 JSON 文件路径，或 - 从 stdin 读取", 2);
  const scenario = await loadScenario(path);
  const report = await runScenario(new ChatService(api), scenario, (index, total, content) => {
    if (!json) process.stderr.write(`[${index + 1}/${total}] ${content}\n`);
  });
  const output = stringOption(args, "output");
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (json) printJson(report); else printScenarioReport(report);
  return report.passed ? 0 : 2;
}

async function conversationCommand(
  args: ParsedArgs,
  api: ApiClient,
  json: boolean,
): Promise<number> {
  const subcommand = args.positionals[1] ?? "list";
  if (subcommand === "list") {
    const result = await api.listConversations(numberOption(args, "limit", 20, { min: 1, max: 100 }));
    if (json) printJson(result);
    else printTable(
      ["ID", "标题", "最近消息", "更新时间"],
      result.items.map((item) => [
        item.conversation_id,
        item.title,
        item.last_message_preview ?? "",
        item.updated_at,
      ]),
    );
    return 0;
  }
  if (subcommand === "create") {
    const kbIds = listOption(args, "kb");
    const conversation = await api.createConversation(
      kbIds.length ? kbIds : api.config.chat.kb_ids,
      stringOption(args, "title"),
    );
    await api.saveLastConversation(conversation.conversation_id);
    if (json) printJson(conversation); else process.stdout.write(`${conversation.conversation_id}\n`);
    return 0;
  }
  const id = args.positionals[2] ?? stringOption(args, "conversation");
  if (!id) throw new CliError(`${subcommand} 需要会话 ID`, 2);
  if (subcommand === "delete") {
    const result = await api.deleteConversation(id);
    if (json) printJson(result); else process.stdout.write(`已删除会话 ${id}\n`);
    return 0;
  }
  if (subcommand === "show" || subcommand === "messages") {
    const [conversation, messages] = await Promise.all([api.getConversation(id), api.getMessages(id)]);
    const includeTraces = booleanOption(args, "traces") || subcommand === "show";
    const traces: MessageTraceResponse[] = [];
    if (includeTraces) {
      for (const message of messages.messages.filter((item) => item.role === "assistant")) {
        traces.push(await api.getMessageTrace(id, message.message_id));
      }
    }
    if (json) printJson({ conversation, ...messages, traces });
    else printConversation(messages.messages, traces);
    return 0;
  }
  throw new CliError(`未知 conversations 子命令: ${subcommand}`, 2);
}

function printConversation(
  messages: Awaited<ReturnType<ApiClient["getMessages"]>>["messages"],
  traces: MessageTraceResponse[],
): void {
  for (const message of messages) {
    process.stdout.write(`\n${message.role === "user" ? "USER" : "ASSISTANT"} ${message.message_id} [${message.status}]\n`);
    process.stdout.write(`${message.content}\n`);
    for (const citation of message.citations) {
      process.stdout.write(`  [${citation.index}] ${citation.doc_title} · ${citation.chunk_id}\n`);
    }
    const trace = traces.find((item) => item.message_id === message.message_id);
    if (trace) {
      process.stdout.write(
        `  trace: retrievals=${trace.retrieval_traces.length} ` +
        `mode=${trace.agent_trace?.mode ?? "-"} rewrite=${trace.query_trace?.rewritten_query ?? "-"}\n`,
      );
    }
  }
}

async function traceCommand(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const subcommand = args.positionals[1] ?? "show";
  if (subcommand !== "show") throw new CliError(`未知 traces 子命令: ${subcommand}`, 2);
  const conversationId = args.positionals[2] ?? stringOption(args, "conversation");
  const messageId = args.positionals[3] ?? stringOption(args, "message");
  if (!conversationId || !messageId) {
    throw new CliError("traces show 需要 <conversation-id> <assistant-message-id>", 2);
  }
  const trace = await api.getMessageTrace(conversationId, messageId);
  if (json) printJson(trace);
  else printJson(trace);
  return 0;
}

async function vectorCommand(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const subcommand = args.positionals[1] ?? "indexes";
  const diagnostics = new VectorDiagnostics(api);
  if (subcommand === "indexes") {
    const indexes = await diagnostics.indexes();
    if (json) printJson(indexes); else printVectorIndexes(indexes);
    return 0;
  }
  if (subcommand === "audit") {
    const audit = await diagnostics.audit();
    if (json) printJson(audit);
    else printTable(
      ["KB ID", "知识库", "PG chunks", "PG embedded", "ES chunks", "差值", "一致"],
      audit.items.map((item) => [
        item.kb_id,
        item.kb_name,
        item.postgres_chunks,
        item.postgres_embedded_chunks ?? "-",
        item.elasticsearch_chunks,
        item.delta,
        item.consistent ? "yes" : "NO",
      ]),
    );
    return audit.consistent ? 0 : 1;
  }
  const kbId = stringOption(args, "kb");
  const docId = stringOption(args, "doc");
  const options = {
    ...(kbId ? { kbId } : {}),
    ...(docId ? { docId } : {}),
    limit: numberOption(args, "limit", 20, { min: 1, max: 200 }),
    offset: numberOption(args, "offset", 0, { min: 0, max: 10_000 }),
    includeEmbedding: booleanOption(args, "include-embedding"),
  };
  if (subcommand === "count") {
    const count = await diagnostics.count(options);
    if (json) printJson({ count, scope: options }); else process.stdout.write(`${count}\n`);
    return 0;
  }
  if (subcommand === "list") {
    const result = await diagnostics.browse(options);
    printVectorResult(result, json, options.includeEmbedding);
    return 0;
  }
  if (subcommand === "search") {
    const query = args.positionals.slice(2).join(" ").trim() || stringOption(args, "query");
    if (!query) throw new CliError("vector search 需要查询文本", 2);
    const result = await diagnostics.search({ ...options, query });
    printVectorResult(result, json, options.includeEmbedding);
    return 0;
  }
  if (subcommand === "get") {
    const chunkId = args.positionals[2];
    if (!chunkId) throw new CliError("vector get 需要 chunk ID", 2);
    const hit = await diagnostics.get(chunkId, options.includeEmbedding);
    if (!hit) throw new CliError(`向量库中未找到 chunk: ${chunkId}`, 1);
    if (json) printJson(hit); else printVectorHit(hit, options.includeEmbedding);
    return 0;
  }
  throw new CliError(`未知 vector 子命令: ${subcommand}`, 2);
}

function traceOption(
  args: ParsedArgs,
  fallback: "off" | "summary" | "full",
): "off" | "summary" | "full" {
  const raw = stringOption(args, "trace");
  return raw ? parseTrace(raw) : fallback;
}

function parseTrace(value: string): "off" | "summary" | "full" {
  if (value === "off" || value === "summary" || value === "full") return value;
  throw new CliError("trace 必须是 off、summary 或 full", 2);
}

function normalizeCommand(command: string): string {
  if (command === "ask") return "chat";
  if (command === "conversation") return "conversations";
  if (command === "trace") return "traces";
  if (command === "document") return "documents";
  return command;
}

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
import { verifyExternalApi } from "./external_verify.ts";
import { printHelp } from "./help.ts";
import { adminCommand, invitationCommand, systemCommand } from "./management_commands.ts";
import {
  citationLocationSuffix,
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
import type { ChatRequest, Identity, MessageTraceResponse } from "./types.ts";
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
    case "external": return externalCommand(args, api, json);
    case "mcp": return mcpCommand(args, api, json);
    case "system": return systemCommand(args, api);
    case "admin": return adminCommand(args, api);
    case "invitation": return invitationCommand(args, api);
    case "api-clients": return apiClientsCommand(args, api, json);
    case "skills": return skillCommand(args, api, json);
    case "kb": return knowledgeBaseCommand(args, api, json);
    case "models": return modelsCommand(api, json);
    case "chat": return chatCommand(args, api, json);
    case "files": return fileCommand(args, api, json);
    case "run": return runCommand(args, api, json);
    case "conversations": return conversationCommand(args, api, json);
    case "share": return shareCommand(args, api, json);
    case "feedback": return feedbackCommand(args, api, json);
    case "traces": return traceCommand(args, api, json);
    case "documents": return documentCommand(args, api, json);
    case "vector": return vectorCommand(args, api, json);
    default:
      throw new CliError(`未知命令: ${command}。运行 documind help 查看帮助`, 2);
  }
}
async function shareCommand(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const subcommand = args.positionals[1] ?? "show";
  const value = args.positionals[2];
  if (!value) throw new CliError(`share ${subcommand} 需要会话 ID 或分享 token`, 2);
  if (subcommand === "show") {
    const result = await api.requestJson(`/api/shares/${encodeURIComponent(value)}`, {}, false, false);
    printJson(result);
    return 0;
  }
  if (subcommand !== "create") throw new CliError(`未知 share 子命令: ${subcommand}`, 2);
  const result = await api.requestJson<Record<string, unknown>>(
    `/api/conversations/${encodeURIComponent(value)}/share`,
    {
      method: "POST",
      body: JSON.stringify({ title: stringOption(args, "title") }),
    },
  );
  if (json) printJson(result);
  else process.stdout.write(`${String(result.share_url ?? "")}\n`);
  return 0;
}


async function feedbackCommand(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const subcommand = args.positionals[1] ?? "set";
  const conversationId = args.positionals[2];
  const messageId = args.positionals[3];
  if (!conversationId || !messageId) {
    throw new CliError(`feedback ${subcommand} 需要会话 ID 和回答消息 ID`, 2);
  }
  const path = `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/feedback`;
  if (subcommand === "clear") {
    const result = await api.requestJson(path, { method: "DELETE" });
    if (json) printJson(result);
    else process.stdout.write(`已清除回答 ${messageId} 的反馈\n`);
    return 0;
  }
  if (subcommand !== "set") throw new CliError(`未知 feedback 子命令: ${subcommand}`, 2);
  const rating = stringOption(args, "rating");
  if (rating !== "up" && rating !== "down") {
    throw new CliError("feedback set 需要 --rating up|down", 2);
  }
  const result = await api.requestJson(path, {
    method: "POST",
    body: JSON.stringify({
      rating,
      ...(stringOption(args, "reason") ? { reason: stringOption(args, "reason") } : {}),
      ...(stringOption(args, "comment") ? { comment: stringOption(args, "comment") } : {}),
      ...(stringOption(args, "correction") ? { correction: stringOption(args, "correction") } : {}),
    }),
  });
  if (json) printJson(result);
  else process.stdout.write(`已提交 ${rating === "up" ? "点赞" : "点踩"}反馈 · message=${messageId}\n`);
  return 0;
}


async function skillCommand(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const subcommand = args.positionals[1] ?? "list";
  if (subcommand === "list") {
    const result = await api.listSkills(stringOption(args, "search") ?? "");
    if (json) printJson(result);
    else {
      const rows = result.items
        .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
        .map((item) => [
          String(item.id ?? ""), String(item.display_name ?? ""), String(item.name ?? ""),
          `v${String(item.revision ?? "")}`, String(item.source ?? ""),
        ]);
      printTable(["ID", "名称", "标识", "版本", "来源"], rows);
    }
    return 0;
  }
  const value = args.positionals[2];
  if (subcommand === "files") {
    const action = value ?? "list";
    const id = args.positionals[3];
    const path = args.positionals[4];
    if (!id) throw new CliError("用法: skills files list|show|put|rename|delete <技能ID> [路径]", 2);
    const skill = await api.getSkill(id);
    const files = (skill.files ?? []) as Array<{ path: string; content: string; size_bytes: number }>;
    if (action === "list") {
      if (json) printJson({ items: files });
      else printTable(["路径", "字节数"], files.map((file) => [file.path, String(file.size_bytes)]));
      return 0;
    }
    if (!path) throw new CliError(`skills files ${action} 需要文件路径`, 2);
    const existing = files.find((file) => file.path === path);
    if (action === "show") {
      if (!existing) throw new CliError(`文件不存在: ${path}`, 2);
      const output = stringOption(args, "out");
      if (output) await writeFile(output, existing.content, "utf8");
      else if (json) printJson(existing);
      else process.stdout.write(existing.content);
      return 0;
    }
    let next = files;
    if (action === "put") {
      const source = stringOption(args, "content-file");
      if (!source) throw new CliError("skills files put 需要 --content-file <UTF-8 文本文件>", 2);
      if (existing && !booleanOption(args, "force")) throw new CliError("覆盖已有文件需要 --force", 2);
      const bytes = await readFile(source);
      if (bytes.byteLength > 256 * 1024) throw new CliError("附属文件不得超过 256 KB", 2);
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new CliError("文件须为 UTF-8 文本", 2); }
      next = [...files.filter((file) => file.path !== path), { path, content, size_bytes: Buffer.byteLength(content, "utf8") }];
    } else if (action === "rename") {
      const target = args.positionals[5];
      if (!existing || !target) throw new CliError("skills files rename <技能ID> <原路径> <新路径>", 2);
      if (files.some((file) => file.path === target && file !== existing)) throw new CliError(`文件已存在: ${target}`, 2);
      next = files.map((file) => file === existing ? { ...file, path: target } : file);
    } else if (action === "delete") {
      if (!existing) throw new CliError(`文件不存在: ${path}`, 2);
      if (!booleanOption(args, "force")) throw new CliError("skills files delete 需要 --force", 2);
      next = files.filter((file) => file.path !== path);
    } else throw new CliError(`未知文件操作: ${action}`, 2);
    printJson(await api.updateSkill(id, { ...skill, source: "editor", files: next }));
    return 0;
  }
  if (subcommand === "create" || subcommand === "update") {
    if (subcommand === "update" && !value) throw new CliError("skills update 需要技能 ID", 2);
    const current = subcommand === "update" ? await api.getSkill(value!) : {};
    const contentFile = stringOption(args, "content-file");
    let content = current.content;
    if (contentFile) {
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(contentFile)); }
      catch { throw new CliError("无法读取 SKILL.md，请提供有效的 UTF-8 文本文件", 2); }
    }
    const input = {
      name: stringOption(args, "name") ?? current.name,
      display_name: stringOption(args, "display-name") ?? current.display_name,
      description: stringOption(args, "description") ?? current.description,
      content,
      source: "editor",
      files: current.files ?? [],
    };
    if (!input.name || !input.display_name || !input.description || !input.content) {
      throw new CliError("skills create 需要 --name、--display-name、--description 和 --content-file", 2);
    }
    printJson(subcommand === "create" ? await api.createSkill(input) : await api.updateSkill(value!, input));
    return 0;
  }
  if (!value) throw new CliError(`skills ${subcommand} 需要参数`, 2);
  if (subcommand === "show") printJson(await api.getSkill(value));
  else if (subcommand === "delete") {
    if (!booleanOption(args, "force")) throw new CliError("skills delete 需要 --force", 2);
    printJson(await api.deleteSkill(value));
  } else if (subcommand === "upload") {
    printJson(await api.uploadSkill(Bun.file(value), value.split("/").pop() ?? "skill.zip"));
  } else if (subcommand === "import") printJson(await api.importSkill(value));
  else throw new CliError(`未知 skills 子命令: ${subcommand}`, 2);
  return 0;
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
  if (subcommand === "register") {
    const identity = await api.register();
    if (json) printJson(identity); else printIdentity(identity);
    return 0;
  }
  if (subcommand === "login") {
    const identity = await api.login(true, booleanOption(args, "platform"));
    if (json) printJson(identity); else printIdentity(identity);
    return 0;
  }
  if (subcommand === "whoami") {
    const identity = await api.me();
    if (json) printJson(identity); else printIdentity(identity);
    return 0;
  }
  if (subcommand === "profile") {
    const identity = await api.me();
    if (json) printJson(identity);
    else {
      process.stdout.write(`展示名称 ${identity.user.name || identity.user.email}\n`);
      process.stdout.write(`头像 ${identity.user.avatar_url || "未设置"}\n`);
    }
    return 0;
  }
  if (subcommand === "profile-update") {
    const current = await api.me();
    const avatarUrl = stringOption(args, "avatar-url");
    if (avatarUrl !== undefined && booleanOption(args, "clear-avatar")) {
      throw new CliError("--avatar-url 与 --clear-avatar 不能同时使用", 2);
    }
    const identity = await api.updateProfile(
      stringOption(args, "name") ?? current.user.name ?? current.user.email,
      booleanOption(args, "clear-avatar") ? null : avatarUrl ?? current.user.avatar_url ?? null,
    );
    if (json) printJson(identity); else printIdentity(identity);
    return 0;
  }
  if (subcommand === "logout") {
    await api.logout();
    if (json) printJson({ logged_out: true }); else process.stdout.write("已退出并清除本地 token\n");
    return 0;
  }
  if (subcommand === "tenants") {
    const result = await api.listTenants();
    if (json) printJson(result);
    else printTable(
      ["当前", "ID", "名称", "Slug"],
      result.items.map((tenant) => [
        tenant.id === result.active_tenant_id ? "✓" : "",
        tenant.id,
        tenant.name,
        tenant.slug,
      ]),
    );
    return 0;
  }
  if (subcommand === "switch") {
    const tenantId = args.positionals[2];
    if (!tenantId) throw new CliError("auth switch 需要 tenant-id", 2);
    const identity = await api.switchTenant(tenantId);
    if (json) printJson(identity); else printIdentity(identity);
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
  let identity: Identity | undefined;
  await doctorCheck(checks, "api.health", () => api.health());
  await doctorCheck(checks, "auth.identity", async () => {
    identity = await api.me();
    return identity;
  });
  if (identity?.roles.includes("super_admin")) {
    const detail = { skipped: "平台身份不进入租户知识空间" };
    checks.push({ name: "tenant.knowledge_bases", ok: true, detail });
    checks.push({ name: "vector.elasticsearch", ok: true, detail });
  } else {
    await doctorCheck(checks, "tenant.knowledge_bases", () => api.listKnowledgeBases());
    await doctorCheck(checks, "vector.elasticsearch", async () => ({
      count: await new VectorDiagnostics(api).count(),
    }));
  }
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

async function mcpCommand(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const subcommand = args.positionals[1] ?? "tools";
  if (subcommand === "tools") {
    const response = await api.mcpCall("tools/list");
    printJson(response);
    return 0;
  }
  if (subcommand === "verify") {
    const tools = await api.mcpCall("tools/list");
    const conversations = await api.mcpCall("tools/call", {
      name: "documind_conversation_list",
      arguments: { limit: 1 },
    });
    const report = { ok: true, tools, conversations };
    if (json) printJson(report);
    else {
      process.stdout.write("DocuMind MCP verify: PASS\n");
      printJson(report);
    }
    return 0;
  }
  if (subcommand === "ask") {
    const message = args.positionals.slice(2).join(" ").trim();
    if (!message) throw new CliError("mcp ask 需要问题", 2);
    const conversationId = stringOption(args, "conversation");
    const kbIds = listOption(args, "kb");
    const result = await api.mcpCall("tools/call", {
      name: "documind_chat",
      arguments: {
        message,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(kbIds.length ? { kb_ids: kbIds } : {}),
      },
    });
    printJson(result);
    return 0;
  }
  throw new CliError(`未知 mcp 子命令: ${subcommand}`, 2);
}


async function externalCommand(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const subcommand = args.positionals[1] ?? "doctor";
  if (subcommand === "verify") {
    const kbId = stringOption(args, "kb");
    const deniedKbId = stringOption(args, "denied-kb");
    const otherConfigPath = stringOption(args, "other-config");
    const report = await verifyExternalApi(api, {
      ...(kbId ? { kbId } : {}),
      ...(deniedKbId ? { deniedKbId } : {}),
      ...(otherConfigPath ? { otherConfigPath } : {}),
      question: stringOption(args, "question") ?? "这个知识库主要包含什么内容？请给出引用。",
    });
    if (json) printJson(report);
    else {
      process.stdout.write(`DocuMind external verify: ${report.ok === true ? "PASS" : "FAIL"}\n`);
      printJson(report);
    }
    return report.ok === true ? 0 : 1;
  }
  api.enableExternalMode();
  if (subcommand === "whoami") {
    const identity = await api.externalMe();
    if (json) printJson(identity);
    else process.stdout.write(`${identity.client_name} · tenant ${identity.tenant_id} · ${identity.scopes.join(", ")}\n`);
    return 0;
  }
  if (subcommand === "doctor") {
    const checks: Array<{ name: string; ok: boolean; detail?: unknown; error?: string }> = [];
    await doctorCheck(checks, "external.identity", () => api.externalMe());
    await doctorCheck(checks, "external.knowledge_bases", () => api.listKnowledgeBases());
    const ok = checks.every((check) => check.ok);
    if (json) printJson({ ok, server: api.baseUrl, checks });
    else {
      process.stdout.write(`DocuMind external doctor: ${ok ? "PASS" : "FAIL"}\n`);
      for (const check of checks) process.stdout.write(`${check.ok ? "✓" : "✗"} ${check.name}${check.error ? ` — ${check.error}` : ""}\n`);
    }
    return ok ? 0 : 1;
  }
  if (subcommand === "chat") {
    return chatCommand({ ...args, positionals: ["chat", ...args.positionals.slice(2)] }, api, json);
  }
  throw new CliError(`未知 external 子命令: ${subcommand}`, 2);
}

async function apiClientsCommand(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const subcommand = args.positionals[1] ?? "list";
  if (subcommand === "list") {
    const clients = await api.listApiClients();
    if (json) printJson(clients);
    else printTable(["ID", "名称", "状态", "知识库", "Token"], clients.map((client) => [client.id, client.name, client.status, String(client.kb_ids.length), String(client.tokens.length)]));
    return 0;
  }
  if (subcommand === "create") {
    const name = stringOption(args, "name") ?? args.positionals.slice(2).join(" ").trim();
    const kbIds = listOption(args, "kb");
    if (!name) throw new CliError("api-clients create 需要 --name", 2);
    if (!kbIds.length) throw new CliError("api-clients create 至少需要一个 --kb", 2);
    const description = stringOption(args, "description");
    const scopes = listOption(args, "scope");
    const created = await api.createApiClient({
      name,
      kb_ids: kbIds,
      ...(description ? { description } : {}),
      ...(scopes.length ? { scopes } : {}),
      expires_in_days: numberOption(args, "expires-in-days", 90, { min: 1, max: 365 }),
      rate_limit_per_minute: numberOption(args, "rate-limit", 60, { min: 1, max: 10_000 }),
    });
    if (json) printJson(created);
    else process.stdout.write(`已创建 ${created.client.name}\nToken 仅显示一次：${created.token}\n`);
    return 0;
  }
  const clientId = args.positionals[2];
  if (!clientId) throw new CliError(`api-clients ${subcommand} 需要 client-id`, 2);
  if (subcommand === "token") {
    const created = await api.createApiToken(
      clientId,
      numberOption(args, "expires-in-days", 90, { min: 1, max: 365 }),
    );
    if (json) printJson(created); else process.stdout.write(`Token 仅显示一次：${created.secret}\n`);
    return 0;
  }
  if (subcommand === "revoke") {
    const tokenId = args.positionals[3];
    if (!tokenId) throw new CliError("api-clients revoke 需要 client-id 和 token-id", 2);
    const result = await api.revokeApiToken(clientId, tokenId);
    if (json) printJson(result); else process.stdout.write(`已吊销 Token ${tokenId}\n`);
    return 0;
  }
  if (subcommand === "disable" || subcommand === "enable") {
    const result = await api.updateApiClientStatus(clientId, subcommand === "enable" ? "active" : "disabled");
    if (json) printJson(result); else process.stdout.write(`${result.name}: ${result.status}\n`);
    return 0;
  }
  throw new CliError(`未知 api-clients 子命令: ${subcommand}`, 2);
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

async function modelsCommand(api: ApiClient, json: boolean): Promise<number> {
  const catalog = await api.chatModels();
  if (json) printJson(catalog);
  else printTable(
    ["默认", "模型", "名称", "深度思考"],
    catalog.models.map((model) => [
      model.id === catalog.default_model_id ? "✓" : "",
      model.id,
      model.name,
      model.thinking_mode,
    ]),
  );
  return 0;
}

async function fileCommand(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const subcommand = args.positionals[1] ?? "list";
  if (subcommand === "list") {
    const result = await api.listUserFiles(stringOption(args, "conversation"));
    if (json) printJson(result);
    else printTable(
      ["ID", "路径", "类型", "字节", "来源", "会话"],
      result.items.map((file) => [
        file.id, file.path, file.mime_type, String(file.size_bytes),
        file.source, file.conversation_id ?? "",
      ]),
    );
    return 0;
  }
  const value = args.positionals[2];
  if (!value) throw new CliError(`files ${subcommand} 需要文件路径或文件 ID`, 2);
  if (subcommand === "upload") {
    const file = Bun.file(value);
    if (!await file.exists()) throw new CliError(`本地文件不存在: ${value}`, 2);
    const uploaded = await api.uploadUserFile(
      file,
      value.split("/").pop() ?? "file",
      stringOption(args, "path"),
      stringOption(args, "conversation"),
    );
    if (json) printJson(uploaded);
    else process.stdout.write(`已上传 ${uploaded.path} · ${uploaded.id}\n`);
    return 0;
  }
  if (subcommand === "show") {
    const file = await api.getUserFile(value);
    if (json) printJson(file);
    else printTable(["字段", "值"], Object.entries(file).map(([key, item]) => [key, String(item)]));
    return 0;
  }
  if (subcommand === "download") {
    const file = await api.getUserFile(value);
    const output = stringOption(args, "output") ?? file.name;
    if (await Bun.file(output).exists() && !booleanOption(args, "force")) {
      throw new CliError(`输出文件已存在: ${output}；使用 --force 覆盖`, 2);
    }
    await writeFile(output, await api.downloadUserFile(value));
    if (json) printJson({ file, output });
    else process.stdout.write(`已下载 ${file.path} -> ${output}\n`);
    return 0;
  }
  if (subcommand === "delete") {
    if (!booleanOption(args, "force")) throw new CliError("files delete 需要 --force", 2);
    const result = await api.deleteUserFile(value);
    if (json) printJson(result);
    else process.stdout.write(`已删除文件 ${value}\n`);
    return 0;
  }
  throw new CliError(`未知 files 子命令: ${subcommand}`, 2);
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
  const requestedFiles = listOption(args, "file-id");
  const fileIds = input.file_ids ?? requestedFiles;
  const title = input.title ?? stringOption(args, "title");
  const clientRequestId = input.client_request_id ?? stringOption(args, "request-id");
  const modelId = input.model_id ?? stringOption(args, "model");
  const thinkingEnabled = input.thinking_enabled ??
    ("thinking" in args.options ? booleanOption(args, "thinking") : undefined);
  return {
    content,
    ...(conversationId ? { conversation_id: conversationId } : {}),
    kb_ids: kbIds,
    file_ids: fileIds,
    ...(title ? { title } : {}),
    ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
    ...(modelId ? { model_id: modelId } : {}),
    ...(thinkingEnabled !== undefined ? { thinking_enabled: thinkingEnabled } : {}),
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
  const fileIds = listOption(args, "file-id");
  let conversationId = stringOption(args, "conversation");
  if (!conversationId && booleanOption(args, "continue")) conversationId = await api.lastConversationId();
  let trace = traceOption(args, api.config.chat.trace);
  const modelId = stringOption(args, "model");
  const thinkingEnabled = "thinking" in args.options
    ? booleanOption(args, "thinking")
    : undefined;
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
        file_ids: fileIds,
        ...(modelId ? { model_id: modelId } : {}),
        ...(thinkingEnabled !== undefined ? { thinking_enabled: thinkingEnabled } : {}),
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
  const fileIds = listOption(args, "file-id");
  const report = await runScenario(new ChatService(api), scenario, (index, total, content) => {
    if (!json) process.stderr.write(`[${index + 1}/${total}] ${content}\n`);
  }, fileIds);
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
  if (subcommand === "update") {
    const requestedKbIds = listOption(args, "kb");
    const selectAll = booleanOption(args, "all");
    if (requestedKbIds.length > 0 && selectAll) {
      throw new CliError("conversations update 的 --kb 与 --all 不能同时使用", 2);
    }
    if (requestedKbIds.length === 0 && !selectAll) {
      throw new CliError("conversations update 需要 --kb ID 或 --all", 2);
    }
    const kbIds = selectAll
      ? (await api.listKnowledgeBases()).map((kb) => kb.id)
      : requestedKbIds;
    const result = await api.updateConversation(id, { kb_ids: kbIds });
    if (json) printJson(result);
    else process.stdout.write(`会话 ${id} 已使用 ${result.kb_ids?.length ?? 0} 个知识库\n`);
    return 0;
  }
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
      process.stdout.write(
        `  [${citation.index}] ${citation.doc_title} · ${citation.chunk_id}` +
        `${citationLocationSuffix(citation)}\n`,
      );
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
      ["KB ID", "知识库", "PG 全部", "PG 可检索", "PG 已嵌入", "ES", "降级文档", "已排除", "差值", "一致"],
      audit.items.map((item) => [
        item.kb_id,
        item.kb_name,
        item.postgres_chunks,
        item.postgres_searchable_chunks,
        item.postgres_embedded_chunks,
        item.elasticsearch_chunks,
        item.degraded_documents,
        item.excluded_chunks,
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

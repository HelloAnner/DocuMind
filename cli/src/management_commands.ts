import type { ApiClient } from "./api.ts";
import { booleanOption, listOption, numberOption, type ParsedArgs, stringOption } from "./args.ts";
import { CliError } from "./errors.ts";
import { printJson } from "./render.ts";

export async function systemCommand(args: ParsedArgs, api: ApiClient): Promise<number> {
  const command = args.positionals[1] ?? "overview";
  let result: unknown;
  switch (command) {
    case "overview": result = await api.requestJson("/api/system/overview"); break;
    case "tenants": result = await api.requestJson("/api/system/tenants"); break;
    case "tenant": result = await api.requestJson(`/api/system/tenants/${id(args, command)}`); break;
    case "tenant-create": {
      const name = required(args, "name", "system tenant-create 需要 --name");
      const slug = stringOption(args, "slug");
      result = await api.requestJson("/api/system/tenants", {
        method: "POST",
        body: JSON.stringify({
          name,
          ...(slug ? { slug } : {}),
          plan: stringOption(args, "plan") ?? "trial",
          expires_in_days: numberOption(args, "expires-in-days", 7, { min: 1, max: 365 }),
        }),
      });
      break;
    }
    case "tenant-update": {
      const input = defined({
        name: stringOption(args, "name"),
        plan: stringOption(args, "plan"),
        status: stringOption(args, "status"),
      });
      if (Object.keys(input).length === 0) throw new CliError("system tenant-update 至少需要 --name、--plan 或 --status", 2);
      result = await api.requestJson(`/api/system/tenants/${id(args, command)}`, {
        method: "PATCH", body: JSON.stringify(input),
      });
      break;
    }
    case "tenant-delete": {
      requireForce(args, "租户将进入待删除状态");
      const slug = required(args, "slug", "system tenant-delete 需要 --slug 二次确认");
      result = await api.requestJson(`/api/system/tenants/${id(args, command)}?confirm_slug=${encodeURIComponent(slug)}`, { method: "DELETE" });
      break;
    }
    case "tenant-invite":
      result = await api.requestJson(`/api/system/tenants/${id(args, command)}/invitations/resend`, {
        method: "POST",
        body: JSON.stringify({ expires_in_days: numberOption(args, "expires-in-days", 7, { min: 1, max: 365 }) }),
      });
      break;
    case "users": result = await api.requestJson("/api/system/users"); break;
    case "models": result = await api.requestJson("/api/system/models"); break;
    case "jobs": result = await api.requestJson("/api/system/jobs"); break;
    case "audit": result = await api.requestJson(queryPath("/api/system/audit", args, ["q", "limit"])); break;
    case "settings": result = await api.requestJson("/api/system/settings"); break;
    case "settings-set": {
      const input = defined({
        auth_token_expire_hours: numberInput(args, "auth-token-expire-hours", 1, 720),
        object_storage_presign_expire_seconds: numberInput(args, "object-storage-presign-expire-seconds", 60, 86_400),
      });
      if (Object.keys(input).length === 0) throw new CliError("system settings-set 需要至少一个设置选项", 2);
      result = await api.requestJson("/api/system/settings", { method: "PUT", body: JSON.stringify(input) });
      break;
    }
    case "vectors": result = await api.requestJson("/api/system/vector-indexes"); break;
    case "vector-reconcile": result = await api.requestJson("/api/system/vector-indexes/reconcile"); break;
    case "vector-rebuild":
      requireForce(args, "全局向量索引将异步重建");
      result = await api.requestJson("/api/system/vector-indexes/rebuild", { method: "POST" });
      break;
    case "integrity": result = await api.requestJson("/api/system/tenant-integrity"); break;
    default: throw new CliError(`未知 system 子命令: ${command}`, 2);
  }
  printJson(result);
  return 0;
}

export async function adminCommand(args: ParsedArgs, api: ApiClient): Promise<number> {
  const command = args.positionals[1] ?? "overview";
  let result: unknown;
  switch (command) {
    case "overview": result = await api.requestJson("/api/admin/overview"); break;
    case "logs": result = await api.requestJson(queryPath("/api/admin/logs", args, ["range", "q", "limit"])); break;
    case "members": result = await api.requestJson("/api/admin/members"); break;
    case "member-update": {
      const input = defined({ role: stringOption(args, "role"), status: stringOption(args, "status") });
      if (Object.keys(input).length === 0) throw new CliError("admin member-update 需要 --role 或 --status", 2);
      result = await api.requestJson(`/api/admin/members/${id(args, command)}`, {
        method: "PATCH", body: JSON.stringify(input),
      });
      break;
    }
    case "member-remove":
      requireForce(args, "成员将从当前租户移除");
      result = await api.requestJson(`/api/admin/members/${id(args, command)}`, { method: "DELETE" });
      break;
    case "invitations": result = await api.requestJson("/api/admin/invitations"); break;
    case "invitation-create": {
      const roles = listOption(args, "role");
      result = await api.requestJson("/api/admin/invitations", {
        method: "POST",
        body: JSON.stringify({
          email: required(args, "email", "admin invitation-create 需要 --email"),
          ...(stringOption(args, "name") ? { name: stringOption(args, "name") } : {}),
          roles: roles.length ? roles : ["end_user"],
          expires_in_days: numberOption(args, "expires-in-days", 7, { min: 1, max: 365 }),
        }),
      });
      break;
    }
    case "invitation-resend":
      result = await api.requestJson(`/api/admin/invitations/${id(args, command)}/resend`, { method: "POST" });
      break;
    case "invitation-revoke":
      requireForce(args, "邀请将被撤销");
      result = await api.requestJson(`/api/admin/invitations/${id(args, command)}/revoke`, { method: "POST" });
      break;
    case "permissions": result = await api.requestJson("/api/admin/permissions"); break;
    case "permission-matrix": result = await api.requestJson("/api/v1/permission/matrix"); break;
    case "permission-grant":
      result = await api.requestJson("/api/admin/permissions", {
        method: "POST",
        body: JSON.stringify({
          kb_id: required(args, "kb", "admin permission-grant 需要 --kb"),
          subject_type: required(args, "subject-type", "admin permission-grant 需要 --subject-type"),
          subject_id: required(args, "subject", "admin permission-grant 需要 --subject"),
          permission: required(args, "permission", "admin permission-grant 需要 --permission"),
        }),
      });
      break;
    case "permission-revoke":
      requireForce(args, "知识库授权将被撤销");
      result = await api.requestJson(`/api/admin/permissions/${id(args, command)}`, { method: "DELETE" });
      break;
    case "runtime-config": result = await api.requestJson("/api/admin/runtime-config"); break;
    case "chunking":
    case "search":
    case "embedding":
    case "llm": {
      const config = await api.requestJson<Record<string, unknown>>("/api/admin/runtime-config");
      result = { read_only: config.read_only, source: config.source, environment: config.environment, [command]: config[command] };
      break;
    }
    default: throw new CliError(`未知 admin 子命令: ${command}`, 2);
  }
  printJson(result);
  return 0;
}

function id(args: ParsedArgs, command: string): string {
  const value = args.positionals[2];
  if (!value) throw new CliError(`${command} 需要 ID`, 2);
  return encodeURIComponent(value);
}

function required(args: ParsedArgs, name: string, message: string): string {
  const value = stringOption(args, name);
  if (!value) throw new CliError(message, 2);
  return value;
}

function numberInput(args: ParsedArgs, name: string, min: number, max: number): number | undefined {
  if (stringOption(args, name) === undefined) return undefined;
  return numberOption(args, name, min, { min, max });
}

function defined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function queryPath(path: string, args: ParsedArgs, names: string[]): string {
  const query = new URLSearchParams();
  for (const name of names) {
    const value = stringOption(args, name);
    if (value !== undefined) query.set(name, value);
  }
  return query.size ? `${path}?${query}` : path;
}

function requireForce(args: ParsedArgs, message: string): void {
  if (!booleanOption(args, "force")) throw new CliError(`${message}；确认后请添加 --force`, 2);
}

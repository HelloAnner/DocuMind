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
    case "quality-summary":
      result = await api.requestJson("/api/admin/answer-quality/summary");
      break;
    case "quality-cases":
      result = await api.requestJson(queryPath(
        "/api/admin/answer-quality/cases", args,
        ["status", "root-cause", "kb", "q", "limit", "cursor"],
      ).replace("root-cause=", "root_cause=").replace("kb=", "kb_id="));
      break;
    case "quality-case":
      result = await api.requestJson(`/api/admin/answer-quality/cases/${id(args, command)}`);
      break;
    case "quality-diagnose":
      result = await api.requestJson(`/api/admin/answer-quality/cases/${id(args, command)}/diagnose`, {
        method: "POST",
      });
      break;
    case "quality-update": {
      const input = defined({
        status: stringOption(args, "status"),
        root_cause: stringOption(args, "root-cause"),
        resolution_note: stringOption(args, "resolution-note"),
      });
      if (Object.keys(input).length === 0) {
        throw new CliError("admin quality-update 需要 --status、--root-cause 或 --resolution-note", 2);
      }
      result = await api.requestJson(`/api/admin/answer-quality/cases/${id(args, command)}`, {
        method: "PATCH", body: JSON.stringify(input),
      });
      break;
    }
    case "corrections":
      result = await api.requestJson(queryPath("/api/admin/answer-corrections", args, ["status", "q", "limit"]));
      break;
    case "correction":
      result = await api.requestJson(`/api/admin/answer-corrections/${id(args, command)}`);
      break;
    case "correction-create":
      result = await api.requestJson("/api/admin/answer-corrections", {
        method: "POST", body: JSON.stringify(correctionInput(args, true)),
      });
      break;
    case "correction-update":
      result = await api.requestJson(`/api/admin/answer-corrections/${id(args, command)}`, {
        method: "PATCH", body: JSON.stringify(correctionInput(args, false)),
      });
      break;
    case "correction-publish":
      result = await api.requestJson(`/api/admin/answer-corrections/${id(args, command)}/publish`, {
        method: "POST",
      });
      break;
    case "correction-archive":
      result = await api.requestJson(`/api/admin/answer-corrections/${id(args, command)}/archive`, {
        method: "POST",
      });
      break;
    case "correction-match":
      result = await api.requestJson("/api/admin/answer-corrections/match-preview", {
        method: "POST",
        body: JSON.stringify({
          question: required(args, "question", "admin correction-match 需要 --question"),
          kb_ids: listOption(args, "kb"),
        }),
      });
      break;
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
export async function invitationCommand(args: ParsedArgs, api: ApiClient): Promise<number> {
  const command = args.positionals[1] ?? "list";
  const expiresInDays = () => numberOption(args, "expires-in-days", 7, { min: 1, max: 30 });
  let result: unknown;
  switch (command) {
    case "list":
      result = await api.requestJson("/api/v1/tenant/invitations");
      break;
    case "create": {
      const roles = listOption(args, "role");
      result = await api.requestJson("/api/v1/tenant/invitations", {
        method: "POST",
        body: JSON.stringify({
          invitee_username: required(args, "username", "invitation create 需要 --username"),
          roles: roles.length ? roles : ["end_user"],
          expires_in_days: expiresInDays(),
        }),
      });
      break;
    }
    case "resend":
      result = await api.requestJson(`/api/v1/tenant/invitations/${id(args, command)}/resend`, {
        method: "POST",
        body: JSON.stringify({ expires_in_days: expiresInDays() }),
      });
      break;
    case "revoke":
      requireForce(args, "邀请将被撤销");
      result = await api.requestJson(`/api/v1/tenant/invitations/${id(args, command)}/revoke`, {
        method: "POST",
      });
      break;
    case "validate":
      result = await api.requestJson("/api/v1/invitations/validate", {
        method: "POST",
        body: JSON.stringify({ token: required(args, "token", "invitation validate 需要 --token") }),
      }, false, false);
      break;
    case "accept":
      result = await api.acceptInvitation(required(args, "token", "invitation accept 需要 --token"));
      break;
    case "owner-create":
    case "owner-resend": {
      const tenantId = id(args, command);
      const suffix = command === "owner-resend" ? "/resend" : "";
      result = await api.requestJson(
        `/api/v1/system/tenants/${tenantId}/owner-invitation${suffix}`,
        { method: "POST", body: JSON.stringify({ expires_in_days: expiresInDays() }) },
      );
      break;
    }
    case "owner-revoke":
      requireForce(args, "租户所有者邀请将被撤销");
      result = await api.requestJson(
        `/api/v1/system/tenants/${id(args, command)}/owner-invitation/revoke`,
        { method: "POST" },
      );
      break;
    default:
      throw new CliError(`未知 invitation 子命令: ${command}`, 2);
  }
  printJson(result);

  return 0;
}
function correctionInput(args: ParsedArgs, create: boolean): Record<string, unknown> {
  const question = stringOption(args, "question");
  const answer = stringOption(args, "answer");
  if (create && (!question || !answer)) {
    throw new CliError("admin correction-create 需要 --question 和 --answer", 2);
  }
  const input = defined({
    source_case_id: stringOption(args, "case"),
    canonical_question: question,
    answer_markdown: answer,
    valid_until: stringOption(args, "valid-until"),
    change_note: stringOption(args, "change-note"),
  });
  if ("alias" in args.options) input.aliases = listOption(args, "alias");
  if ("kb" in args.options) input.required_kb_ids = listOption(args, "kb");
  const sourceJson = stringOption(args, "source-json");
  if (sourceJson !== undefined) {
    try {
      const sources: unknown = JSON.parse(sourceJson);
      if (!Array.isArray(sources)) throw new Error("not an array");
      input.sources = sources;
    } catch {
      throw new CliError("--source-json 必须是 JSON 数组", 2);
    }
  }
  if (!create && Object.keys(input).length === 0) {
    throw new CliError("admin correction-update 至少需要一个修改选项", 2);
  }
  return input;
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

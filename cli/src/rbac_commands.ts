import type { ApiClient } from "./api.ts";
import { booleanOption, type ParsedArgs, stringOption } from "./args.ts";
import { CliError } from "./errors.ts";
import { printJson, printTable } from "./render.ts";

interface RbacAction {
  key: string;
  label: string;
}

interface RbacEntity {
  type: string;
  id: string;
  label: string;
  actions: string[];
  parent_id?: string;
}

interface RbacCatalog {
  system: string;
  actions: RbacAction[];
  entities: RbacEntity[];
}

interface RbacSubject {
  id: string;
  username: string;
  name: string;
  role: string;
  roles?: string[];
  status: string;
  portal_user_id?: string | null;
  managed?: boolean;
}

interface RbacCell {
  type: string;
  id: string;
  action: string;
  allow: boolean;
  source: "role" | "allow" | "deny";
}

interface RbacGate {
  type: string;
  id?: string;
  action: string;
  allow: boolean;
}

interface RbacMatrix {
  subject: RbacSubject;
  baseline_label: string;
  cells: RbacCell[];
  gates?: RbacGate[];
}

const SRC_LABEL: Record<string, string> = {
  role: "角色默认",
  allow: "个人允许",
  deny: "个人拒绝",
};

function required(args: ParsedArgs, name: string, message: string): string {
  const value = stringOption(args, name);
  if (!value) throw new CliError(message, 2);
  return value;
}

async function subjects(api: ApiClient): Promise<RbacSubject[]> {
  return (await api.rbacSubjects()).items;
}

async function resolveSubject(api: ApiClient, value: string): Promise<RbacSubject> {
  const items = await subjects(api);
  const found = items.find(
    (item) => item.id === value || item.username === value || item.name === value,
  );
  if (!found) throw new CliError(`找不到成员: ${value}`, 2);
  return found;
}

function effectArg(args: ParsedArgs): "allow" | "deny" | "reset" {
  const raw = stringOption(args, "effect") ?? "allow";
  if (raw === "allow" || raw === "deny" || raw === "reset") return raw;
  throw new CliError("--effect 只能是 allow | deny | reset", 2);
}

export async function permCommand(args: ParsedArgs, api: ApiClient, json: boolean): Promise<number> {
  const action = args.positionals[1] ?? "catalog";
  if (action === "catalog") {
    const catalog = await api.rbacCatalog<RbacCatalog>();
    if (json) {
      printJson(catalog);
      return 0;
    }
    printTable(
      ["类型", "ID", "名称", "动作"],
      catalog.entities.map((entity) => [entity.type, entity.id, entity.label, entity.actions.join("/")]),
    );
    return 0;
  }
  if (action === "subjects") {
    const result = await api.rbacSubjects<{ items: RbacSubject[] }>();
    if (json) {
      printJson(result);
      return 0;
    }
    printTable(
      ["ID", "账号", "姓名", "角色", "状态", "Portal"],
      result.items.map((item) => [
        item.id, item.username, item.name, item.role, item.status,
        item.managed === false ? "仅本系统" : "已映射",
      ]),
    );
    return 0;
  }
  if (action === "matrix") {
    const subject = await resolveSubject(api, required(args, "user", "perm matrix 需要 --user"));
    const matrix = await api.rbacMatrix<RbacMatrix>(subject.id);
    if (json) {
      printJson(matrix);
      return 0;
    }
    const catalog = await api.rbacCatalog<RbacCatalog>();
    const labels = new Map(catalog.entities.map((entity) => [`${entity.type}:${entity.id}`, entity.label]));
    printTable(
      ["实体", "动作", "有效", "来源"],
      matrix.cells.map((cell) => [
        `${cell.type}:${labels.get(`${cell.type}:${cell.id}`) ?? cell.id}`,
        cell.action,
        cell.allow ? "开" : "关",
        SRC_LABEL[cell.source] ?? cell.source,
      ]),
    );
    process.stdout.write(`${matrix.subject.name || matrix.subject.username} · ${matrix.baseline_label}\n`);
    return 0;
  }
  if (action === "set") {
    const subject = await resolveSubject(api, required(args, "user", "perm set 需要 --user"));
    const type = required(args, "type", "perm set 需要 --type");
    const id = required(args, "id", "perm set 需要 --id");
    const act = required(args, "action", "perm set 需要 --action");
    const effect = effectArg(args);
    const result = await api.rbacSetCell<{ cell: RbacCell }>({
      subject_id: subject.id,
      type,
      id,
      action: act,
      effect: effect === "reset" ? null : effect,
    });
    if (json) printJson(result);
    else {
      process.stdout.write(
        `${subject.name || subject.username} · ${type}:${id} · ${act} → ${result.cell.allow ? "开" : "关"}（${SRC_LABEL[result.cell.source] ?? result.cell.source}）\n`,
      );
    }
    return 0;
  }
  if (action === "reset") {
    const subject = await resolveSubject(api, required(args, "user", "perm reset 需要 --user"));
    const result = await api.rbacReset<{ removed: number }>(subject.id);
    if (json) printJson(result);
    else process.stdout.write(`已恢复 ${result.removed} 项个人设置\n`);
    return 0;
  }
  if (action === "check") {
    const subject = await resolveSubject(api, required(args, "user", "perm check 需要 --user"));
    const type = required(args, "type", "perm check 需要 --type");
    const id = required(args, "id", "perm check 需要 --id");
    const act = required(args, "action", "perm check 需要 --action");
    const matrix = await api.rbacMatrix<RbacMatrix>(subject.id);
    const cell = matrix.cells.find((item) => item.type === type && item.id === id && item.action === act);
    const gate = matrix.gates?.find(
      (item) => item.type === type && (item.id === undefined || item.id === id) && item.action === act,
    );
    const result = {
      subject: subject.username,
      type,
      id,
      action: act,
      allow: cell?.allow ?? false,
      source: cell?.source ?? "role",
      gate: gate?.allow ?? true,
    };
    if (json) printJson(result);
    else {
      process.stdout.write(
        `${result.subject} · ${type}:${id} · ${act} → ${result.allow ? "允许" : "拒绝"}（${SRC_LABEL[result.source] ?? result.source}）${result.gate ? "" : " · 功能闸门关闭"}\n`,
      );
    }
    return result.allow ? 0 : 1;
  }
  if (action === "migrate-legacy") {
    const result = await api.rbacMigrate<{ dry_run: boolean; candidates: number; migrated: number }>(booleanOption(args, "dry-run"));
    if (json) printJson(result);
    else process.stdout.write(`${result.dry_run ? "试运行" : "已迁移"}：候选 ${result.candidates}，写入 ${result.migrated}\n`);
    return 0;
  }
  if (action === "prune") {
    const result = await api.rbacPrune<{ dry_run: boolean; stale: number; removed: number }>(booleanOption(args, "dry-run"));
    if (json) printJson(result);
    else process.stdout.write(`${result.dry_run ? "试运行" : "已清理"}：孤儿 ${result.stale}，删除 ${result.removed}\n`);
    return 0;
  }
  throw new CliError("perm 支持 catalog|subjects|matrix|set|reset|check|migrate-legacy|prune", 2);
}

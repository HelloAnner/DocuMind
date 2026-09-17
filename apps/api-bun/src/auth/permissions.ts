// 移植自 apps/api-rs/src/auth.rs 的 derive_permissions / role_matrix / require_*
import { AppError } from '../errors.ts';
import type { CurrentActor } from '../models/identity.ts';

const ROLE_PERMISSIONS: Record<string, string[]> = {
  super_admin: [
    'tenant.read', 'tenant.write', 'tenant.delete', 'user.read', 'user.write', 'user.delete',
    'model.read', 'model.write', 'model.delete', 'job.read', 'job.write', 'audit.read',
  ],
  tenant_admin: [
    'tenant.read', 'tenant.write', 'user.read', 'user.write', 'kb.read', 'kb.create', 'kb.write',
    'kb.manage', 'document.upload', 'document.delete', 'document.reprocess', 'config.read',
    'config.write', 'member.read', 'member.write', 'member.delete', 'audit.read', 'chat.ask',
    'answer.feedback', 'api_client.read', 'api_client.write', 'api_client.revoke',
  ],
  team_admin: [
    'kb.read', 'kb.write', 'document.upload', 'document.reprocess', 'member.read', 'audit.read',
    'chat.ask', 'answer.feedback',
  ],
  data_admin: [
    'kb.read', 'kb.write', 'document.upload', 'document.reprocess', 'member.read', 'audit.read',
    'chat.ask', 'answer.feedback',
  ],
  end_user: ['kb.read', 'chat.ask', 'answer.feedback'],
  viewer: ['kb.read'],
};

export function normalizeRole(role: string): string {
  switch (role) {
    case 'enterprise_admin':
    case 'team_admin':
    case 'data_admin':
    case 'tenant_owner':
      return 'tenant_admin';
    case 'user':
    case 'analyst':
    case 'viewer':
      return 'end_user';
    default:
      return role;
  }
}

export function derivePermissions(roles: string[]): string[] {
  const perms: string[] = [];
  for (const role of roles) {
    const normalized = normalizeRole(role);
    if (normalized === 'team_admin' || normalized === 'data_admin') {
      perms.push(...ROLE_PERMISSIONS.team_admin!);
    } else {
      perms.push(...(ROLE_PERMISSIONS[normalized] ?? []));
    }
  }
  return [...new Set(perms)].sort();
}

export function roleMatrix(): Record<string, string[]> {
  const roles = [
    'super_admin', 'enterprise_admin', 'team_admin', 'data_admin', 'user',
    'viewer', 'tenant_owner', 'tenant_admin', 'end_user',
  ];
  const matrix: Record<string, string[]> = {};
  for (const role of roles) matrix[role] = derivePermissions([role]);
  return matrix;
}

export function isDocumindAdmin(roles: string[]): boolean {
  return roles.some((role) =>
    ['enterprise_admin', 'tenant_owner', 'tenant_admin', 'team_admin', 'data_admin'].includes(role));
}

export function requireSuperAdmin(actor: CurrentActor): void {
  if (!actor.is_super_admin) throw AppError.forbidden();
}
export function requireTenantAdmin(actor: CurrentActor): void {
  if (actor.is_super_admin || !isDocumindAdmin(actor.roles)) throw AppError.forbidden();
}
export function requirePermission(actor: CurrentActor, permission: string): void {
  if (!actor.permissions.includes(permission)) throw AppError.forbidden();
}
export function requireKbPermission(actor: CurrentActor, kbId: string, permission: string): void {
  const required = permission === 'read' ? 'kb.read'
    : permission === 'write' ? 'kb.write'
    : permission === 'manage' ? 'kb.manage' : permission;
  if (!actor.permissions.includes(required)) throw AppError.forbidden();
  if (!actor.allowed_kb_ids.includes(kbId)) throw AppError.kbScopeDenied();
}

/** 对应 Rust normalized_actor_roles */
export function normalizedActorRoles(membershipRoles: string[], includeSuperAdmin: boolean): string[] {
  if (includeSuperAdmin) return ['super_admin'];
  const mapped = membershipRoles.flatMap((role) => {
    switch (role) {
      case 'super_admin': return []; // 平台权限不隐含租户权限
      case 'enterprise_admin':
      case 'team_admin':
      case 'data_admin':
      case 'tenant_owner':
      case 'tenant_admin':
        return ['tenant_admin'];
      case 'user':
      case 'analyst':
      case 'viewer':
      case 'end_user':
        return ['end_user'];
      default:
        return [];
    }
  });
  return [...new Set(mapped)].sort();
}

/** 对应 Rust effective_permissions_for_membership */
export function effectivePermissionsForMembership(roles: string[], attributes: unknown): string[] {
  const local = derivePermissions(roles);
  if (typeof attributes !== 'object' || attributes === null) return local;
  const effective = (attributes as Record<string, unknown>).effective_permissions;
  if (!Array.isArray(effective)) return local;
  const clamped = effective
    .filter((value): value is string => typeof value === 'string' && local.includes(value));
  return [...new Set(clamped)].sort();
}

// 移植自 apps/api-rs/src/auth.rs 的 record_audit_event
import type { Sql } from 'postgres';
import { AppError } from '../errors.ts';
import type { CurrentActor } from '../models/identity.ts';

export async function recordAuditEvent(
  sql: Sql | null,
  actor: CurrentActor | null,
  action: string,
  resourceType: string | null,
  resourceId: string | null,
  detail: unknown,
): Promise<void> {
  if (!sql) return;
  const tenantId = actor?.tenant_id ?? null;
  const actorUserId = actor?.user_id ?? null;
  const actorRole = actor?.roles[0] ?? 'anonymous';
  try {
    await sql`
      INSERT INTO audit_log (
        tenant_id, actor_user_id, actor_role, action, resource_type,
        resource_id, detail
      )
      VALUES (${tenantId}, ${actorUserId}, ${actorRole}, ${action}, ${resourceType},
        ${resourceId}, ${sql.json((detail ?? {}) as import('postgres').JSONValue)})
    `;
  } catch (error) {
    throw AppError.internal((error as Error).message);
  }
}

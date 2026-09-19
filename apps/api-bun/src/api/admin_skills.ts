import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import JSZip from 'jszip';
import { Hono, type Context } from 'hono';
import type { Sql } from 'postgres';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import { newUuid } from '../infra/uuid.ts';
import type { CurrentActor } from '../models/identity.ts';

const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 256 * 1024;
const MAX_FILES = 100;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillSummary {
  id: string;
  name: string;
  display_name: string;
  description: string;
  revision: number;
  source: 'editor' | 'upload' | 'import' | 'conversation';
  source_url: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface SkillRecord extends SkillSummary {
  content: string;
  content_sha256: string;
  files: Array<{ path: string; content: string; size_bytes: number }>;
}

export interface SkillInput {
  name: string;
  display_name: string;
  description: string;
  content: string;
  source?: SkillRecord['source'];
  source_url?: string | null;
  files?: SkillRecord['files'];
}

export function adminSkillsRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/admin/skills', listSkillsHttp);
  router.post('/api/admin/skills', createSkillHttp);
  router.post('/api/admin/skills/upload', uploadSkillHttp);
  router.post('/api/admin/skills/import', importSkillHttp);
  router.get('/api/admin/skills/:id', getSkillHttp);
  router.put('/api/admin/skills/:id', updateSkillHttp);
  router.delete('/api/admin/skills/:id', deleteSkillHttp);
  return router;
}

export async function listSkills(sql: Sql, tenantId: string, search = ''): Promise<SkillSummary[]> {
  const value = search.trim();
  const rows = await sql`
    SELECT id, name, display_name, description, revision, source, source_url,
           created_by, updated_by, created_at, updated_at
    FROM skill
    WHERE tenant_id = ${tenantId}
      AND (${value} = '' OR display_name ILIKE '%' || ${value} || '%' OR name ILIKE '%' || ${value} || '%' OR description ILIKE '%' || ${value} || '%')
    ORDER BY updated_at DESC
  `;
  return rows.map(skillSummary);
}

export async function getSkill(sql: Sql, tenantId: string, idOrName: string): Promise<SkillRecord> {
  const rows = await sql`
    SELECT id, name, display_name, description, content, revision, content_sha256, source,
           source_url, created_by, updated_by, created_at, updated_at
    FROM skill WHERE tenant_id = ${tenantId} AND (id::text = ${idOrName} OR name = ${idOrName}) LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw skillNotFound();
  const fileRows = await sql`
    SELECT path, content, size_bytes FROM skill_file WHERE skill_id = ${String(row.id)} ORDER BY path
  `;
  return {
    ...skillSummary(row),
    content: String(row.content),
    content_sha256: String(row.content_sha256),
    files: fileRows.map((file) => ({
      path: String(file.path), content: String(file.content), size_bytes: Number(file.size_bytes),
    })),
  };
}

export async function saveSkill(
  sql: Sql, tenantId: string, userId: string, input: SkillInput, skillId?: string,
): Promise<SkillRecord> {
  const value = validateSkillInput(input);
  const id = skillId ?? newUuid();
  const digest = createHash('sha256').update(value.content).digest('hex');
  await sql.begin(async (tx) => {
    if (skillId) {
      const result = await tx`
        UPDATE skill SET name = ${value.name}, display_name = ${value.display_name},
          description = ${value.description}, content = ${value.content}, content_sha256 = ${digest},
          revision = revision + 1, source = ${value.source}, source_url = ${value.source_url},
          updated_by = ${userId}, updated_at = NOW()
        WHERE id = ${id} AND tenant_id = ${tenantId}
      `;
      if (result.count === 0) throw skillNotFound();
    } else {
      await tx`
        INSERT INTO skill
          (id, tenant_id, name, display_name, description, content, content_sha256, source,
           source_url, created_by, updated_by)
        VALUES (${id}, ${tenantId}, ${value.name}, ${value.display_name}, ${value.description},
          ${value.content}, ${digest}, ${value.source}, ${value.source_url}, ${userId}, ${userId})
      `;
    }
    if (value.files !== undefined) {
      await tx`DELETE FROM skill_file WHERE skill_id = ${id}`;
      for (const file of value.files) {
        await tx`
          INSERT INTO skill_file (id, skill_id, path, content, size_bytes)
          VALUES (${newUuid()}, ${id}, ${file.path}, ${file.content}, ${file.size_bytes})
        `;
      }
    }
  });
  return getSkill(sql, tenantId, id);
}

export async function deleteSkill(sql: Sql, tenantId: string, id: string): Promise<void> {
  const result = await sql`DELETE FROM skill WHERE tenant_id = ${tenantId} AND id = ${id}`;
  if (result.count === 0) throw skillNotFound();
}

export function formatSkillsForSystemPrompt(skills: SkillSummary[]): string {
  if (skills.length === 0) return '当前租户未配置技能。';
  return [
    '<tenant_skills>',
    '以下技能自动对当前会话可用。先根据名称和说明判断是否适用；需要执行时调用 skill_read 加载完整指令。不得编造未读取的技能内容。',
    ...skills.map((skill) => `- ${skill.name}: ${skill.display_name} — ${skill.description}`),
    '</tenant_skills>',
  ].join('\n');
}

function requireSkillManager(actor: CurrentActor): void {
  if (actor.is_super_admin) return;
  if (!actor.roles.some((role) => ['tenant_owner', 'tenant_admin', 'enterprise_admin'].includes(role))) {
    throw AppError.forbidden();
  }
}

async function requestContext(c: Context<AppEnv>): Promise<{ sql: Sql; actor: CurrentActor }> {
  const actor = c.get('actor');
  requireSkillManager(actor);
  const sql = c.get('appState').sql;
  if (!sql) throw AppError.badRequest('DATABASE_REQUIRED', '技能管理需要 PostgreSQL');
  return { sql, actor };
}

async function listSkillsHttp(c: Context<AppEnv>) {
  const { sql, actor } = await requestContext(c);
  return c.json({ items: await listSkills(sql, actor.tenant_id, c.req.query('q') ?? '') });
}
async function getSkillHttp(c: Context<AppEnv>) {
  const { sql, actor } = await requestContext(c);
  return c.json(await getSkill(sql, actor.tenant_id, c.req.param('id')!));
}
async function createSkillHttp(c: Context<AppEnv>) {
  const { sql, actor } = await requestContext(c);
  return c.json(await saveSkill(sql, actor.tenant_id, actor.user_id, await c.req.json() as SkillInput), 201);
}
async function updateSkillHttp(c: Context<AppEnv>) {
  const { sql, actor } = await requestContext(c);
  return c.json(await saveSkill(sql, actor.tenant_id, actor.user_id, await c.req.json() as SkillInput, c.req.param('id')!));
}
async function deleteSkillHttp(c: Context<AppEnv>) {
  const { sql, actor } = await requestContext(c);
  const id = c.req.param('id')!;
  await deleteSkill(sql, actor.tenant_id, id);
  return c.json({ id, status: 'deleted' });
}
async function uploadSkillHttp(c: Context<AppEnv>) {
  const { sql, actor } = await requestContext(c);
  const form = await c.req.formData();
  const archive = form.get('file');
  if (archive === null || typeof archive === 'string') throw invalidSkill('请选择技能包');
  const input = await parseSkillPackage(new Uint8Array(await archive.arrayBuffer()), archive.name, 'upload');
  return c.json(await saveSkill(sql, actor.tenant_id, actor.user_id, input), 201);
}
async function importSkillHttp(c: Context<AppEnv>) {
  const { sql, actor } = await requestContext(c);
  const body = await c.req.json() as { url?: string };
  const url = body.url?.trim() ?? '';
  if (!url) throw invalidSkill('url is required');
  const response = await fetchPublicUrl(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw invalidSkill('技能包不得超过 5 MB');
  const filename = new URL(response.url).pathname.split('/').pop() || 'SKILL.md';
  const input = await parseSkillPackage(bytes, filename, 'import', response.url);
  return c.json(await saveSkill(sql, actor.tenant_id, actor.user_id, input), 201);
}

function validateSkillInput(input: SkillInput): Required<SkillInput> {
  const name = String(input.name ?? '').trim().toLowerCase();
  const displayName = String(input.display_name ?? '').trim();
  const description = String(input.description ?? '').trim();
  const content = String(input.content ?? '').trim();
  if (!NAME_PATTERN.test(name) || name.length > 64) throw invalidSkill('技能名称须为 1-64 位小写字母、数字或连字符');
  if (!displayName || displayName.length > 100) throw invalidSkill('显示名称须为 1-100 个字符');
  if (!description || description.length > 500) throw invalidSkill('技能说明须为 1-500 个字符');
  if (!content) throw invalidSkill('SKILL.md 内容不能为空');
  if (new TextEncoder().encode(content).byteLength > MAX_CONTENT_BYTES) throw invalidSkill('SKILL.md 不得超过 64 KB');
  const files = input.files ?? [];
  if (files.length > MAX_FILES) throw invalidSkill('参考文件不得超过 100 个');
  for (const file of files) {
    if (!safeArchivePath(file.path)) throw invalidSkill(`非法文件路径: ${file.path}`);
    if (file.size_bytes > MAX_REFERENCE_BYTES) throw invalidSkill(`参考文件不得超过 256 KB: ${file.path}`);
  }
  const source = input.source ?? 'editor';
  if (!['editor', 'upload', 'import', 'conversation'].includes(source)) throw invalidSkill('无效技能来源');
  return { name, display_name: displayName, description, content, source, source_url: input.source_url ?? null, files };
}

async function parseSkillPackage(
  bytes: Uint8Array, filename: string, source: 'upload' | 'import', sourceUrl: string | null = null,
): Promise<SkillInput> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw invalidSkill('技能包不得超过 5 MB');
  if (!filename.toLowerCase().endsWith('.zip')) {
    const markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ...parseSkillMarkdown(markdown), source, source_url: sourceUrl };
  }
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_FILES + 1) throw invalidSkill('技能包文件不得超过 101 个');
  for (const entry of entries) if (!safeArchivePath(entry.name)) throw invalidSkill(`非法文件路径: ${entry.name}`);
  const manifests = entries.filter((entry) => entry.name.split('/').pop()?.toLowerCase() === 'skill.md');
  if (manifests.length !== 1) throw invalidSkill('技能包必须且只能包含一个 SKILL.md');
  const manifest = manifests[0]!;
  const root = manifest.name.slice(0, -'SKILL.md'.length);
  const files: SkillRecord['files'] = [];
  for (const entry of entries) {
    if (entry === manifest || !entry.name.startsWith(root)) continue;
    const path = entry.name.slice(root.length);
    const data = await entry.async('uint8array');
    if (data.byteLength > MAX_REFERENCE_BYTES) throw invalidSkill(`参考文件不得超过 256 KB: ${path}`);
    files.push({ path, content: new TextDecoder('utf-8', { fatal: true }).decode(data), size_bytes: data.byteLength });
  }
  return { ...parseSkillMarkdown(await manifest.async('string')), source, source_url: sourceUrl, files };
}

function parseSkillMarkdown(markdown: string): Omit<SkillInput, 'source'> {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) throw invalidSkill('SKILL.md 缺少 YAML frontmatter');
  const values: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const pair = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (pair) values[pair[1]!] = pair[2]!.trim().replace(/^['"]|['"]$/g, '');
  }
  const name = values.name ?? '';
  return {
    name, display_name: values.display_name || values.title || name,
    description: values.description ?? '', content: match[2]!.trim(), source_url: null, files: [],
  };
}

function safeArchivePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..');
}

async function fetchPublicUrl(initialUrl: string): Promise<Response> {
  let current = initialUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    await assertPublicHttpsUrl(current);
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw invalidSkill('导入地址重定向无效');
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw invalidSkill(`下载技能失败: HTTP ${response.status}`);
    if (Number(response.headers.get('content-length') ?? 0) > MAX_ARCHIVE_BYTES) throw invalidSkill('技能包不得超过 5 MB');
    return response;
  }
  throw invalidSkill('导入地址重定向过多');
}

async function assertPublicHttpsUrl(value: string): Promise<void> {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidSkill('导入地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw invalidSkill('仅支持无凭据的标准 HTTPS 地址');
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) throw invalidSkill('导入地址必须解析到公网 IP');
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) || parts[0]! >= 224;
}

function skillSummary(row: Record<string, unknown>): SkillSummary {
  return {
    id: String(row.id), name: String(row.name), display_name: String(row.display_name), description: String(row.description),
    revision: Number(row.revision), source: String(row.source) as SkillSummary['source'],
    source_url: row.source_url ? String(row.source_url) : null,
    created_by: String(row.created_by), updated_by: String(row.updated_by),
    created_at: new Date(row.created_at as string | Date).toISOString(),
    updated_at: new Date(row.updated_at as string | Date).toISOString(),
  };
}
function invalidSkill(message: string): AppError { return AppError.badRequest('SKILL_INVALID', message); }
function skillNotFound(): AppError { return AppError.notFound('SKILL_NOT_FOUND', '技能不存在'); }

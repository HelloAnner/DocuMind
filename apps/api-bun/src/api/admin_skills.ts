import { createHash } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';

// ponytail: 服务器 IPv6 出网不可达，Bun fetch 默认 verbatim 会先试 IPv6 导致 10s 超时
setDefaultResultOrder('ipv4first');
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
      if (value.files === undefined) {
        const sizes = await tx`SELECT COALESCE(SUM(octet_length(content)), 0) AS bytes FROM skill_file WHERE skill_id = ${id}`;
        if (Number(sizes[0]?.bytes ?? 0) + Buffer.byteLength(value.content, 'utf8') > MAX_ARCHIVE_BYTES) {
          throw invalidSkill('技能文本总大小不得超过 5 MB');
        }
      }
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
  }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw AppError.conflictWith('SKILL_NAME_EXISTS', '当前企业已存在同名技能，请修改技能名称');
    }
    throw error;
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

async function requestContext(c: Context<AppEnv>, writable = true): Promise<{ sql: Sql; actor: CurrentActor }> {
  const actor = c.get('actor');
  if (writable) requireSkillManager(actor);
  else if (!actor.is_super_admin && !actor.roles.some((role) => ['tenant_owner', 'tenant_admin', 'enterprise_admin', 'team_admin', 'data_admin'].includes(role))) {
    throw AppError.forbidden();
  }
  const sql = c.get('appState').sql;
  if (!sql) throw AppError.badRequest('DATABASE_REQUIRED', '技能管理需要 PostgreSQL');
  return { sql, actor };
}

async function listSkillsHttp(c: Context<AppEnv>) {
  const { sql, actor } = await requestContext(c, false);
  return c.json({ items: await listSkills(sql, actor.tenant_id, c.req.query('q') ?? '') });
}
async function getSkillHttp(c: Context<AppEnv>) {
  const { sql, actor } = await requestContext(c, false);
  return c.json(await getSkill(sql, actor.tenant_id, c.req.param('id')!));
}
async function createSkillHttp(c: Context<AppEnv>) {
  const { sql, actor } = await requestContext(c);
  return c.json(await saveSkill(sql, actor.tenant_id, actor.user_id, await readSkillJson(c) as SkillInput), 201);
}
async function updateSkillHttp(c: Context<AppEnv>) {
  const { sql, actor } = await requestContext(c);
  return c.json(await saveSkill(sql, actor.tenant_id, actor.user_id, await readSkillJson(c) as SkillInput, c.req.param('id')!));
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
  if (archive.size > MAX_ARCHIVE_BYTES) throw invalidSkill('技能包不得超过 5 MB');
  const input = await parseSkillPackage(new Uint8Array(await archive.arrayBuffer()), archive.name, 'upload');
  return c.json(await saveSkill(sql, actor.tenant_id, actor.user_id, input), 201);
}
async function importSkillHttp(c: Context<AppEnv>) {
  const { sql, actor } = await requestContext(c);
  const body = await readSkillJson(c) as { url?: unknown };
  const url = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!url) throw invalidSkill('url is required');
  const response = await fetchPublicUrl(url);
  if (!response.body) throw invalidSkill('技能包为空');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ARCHIVE_BYTES) throw invalidSkill('技能包不得超过 5 MB');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidSkill('下载技能包失败，请检查地址或稍后重试');
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const filename = new URL(response.url).pathname.split('/').pop() || 'SKILL.md';
  const input = await parseSkillPackage(bytes, filename, 'import', response.url);
  return c.json(await saveSkill(sql, actor.tenant_id, actor.user_id, input), 201);
}

async function readSkillJson(c: Context<AppEnv>): Promise<unknown> {
  try { return await c.req.json(); }
  catch { throw invalidSkill('请求须为有效 JSON'); }
}

function validateSkillInput(input: SkillInput): SkillInput & { source: SkillRecord['source']; source_url: string | null } {
  if (!input || typeof input !== 'object') throw invalidSkill('技能数据须为对象');
  for (const key of ['name', 'display_name', 'description', 'content'] as const) {
    if (typeof input[key] !== 'string') throw invalidSkill(`${key} 须为文本`);
  }
  const name = input.name.trim().toLowerCase();
  const displayName = input.display_name.trim();
  const description = input.description.trim();
  const content = input.content;
  if (!NAME_PATTERN.test(name) || name.length > 64) throw invalidSkill('技能名称须为 1-64 位小写字母、数字或连字符');
  if (!displayName || displayName.length > 100) throw invalidSkill('显示名称须为 1-100 个字符');
  if (!description || description.length > 500) throw invalidSkill('技能说明须为 1-500 个字符');
  textSize(displayName, '显示名称');
  textSize(description, '技能说明');
  if (!content.trim()) throw invalidSkill('SKILL.md 内容不能为空');
  let totalBytes = textSize(content, 'SKILL.md');
  if (totalBytes > MAX_CONTENT_BYTES) throw invalidSkill('SKILL.md 不得超过 64 KB');
  let files: SkillRecord['files'] | undefined;
  if (input.files !== undefined) {
    if (!Array.isArray(input.files)) throw invalidSkill('files 须为文件数组');
    if (input.files.length > MAX_FILES) throw invalidSkill('附属文件不得超过 100 个');
    const paths = new Set<string>();
    files = input.files.map((file) => {
      if (!file || typeof file.path !== 'string' || !safeArchivePath(file.path) || file.path.split('/').pop()?.toLowerCase() === 'skill.md') {
        throw invalidSkill('文件须使用安全的相对路径，且不能命名为 SKILL.md');
      }
      if (paths.has(file.path)) throw invalidSkill(`文件路径重复: ${file.path}`);
      paths.add(file.path);
      const size = textSize(file.content, file.path);
      if (size > MAX_REFERENCE_BYTES) throw invalidSkill(`附属文件不得超过 256 KB: ${file.path}`);
      totalBytes += size;
      return { path: file.path, content: file.content, size_bytes: size };
    });
  }
  if (totalBytes > MAX_ARCHIVE_BYTES) throw invalidSkill('技能文本总大小不得超过 5 MB');
  const source = input.source ?? 'editor';
  if (!['editor', 'upload', 'import', 'conversation'].includes(source)) throw invalidSkill('无效技能来源');
  if (input.source_url != null && (typeof input.source_url !== 'string' || input.source_url.length > 2048)) {
    throw invalidSkill('无效来源地址');
  }
  if (input.source_url) textSize(input.source_url, '来源地址');
  return { name, display_name: displayName, description, content, source, source_url: input.source_url ?? null, files };
}

function textSize(content: string, path: string): number {
  if (typeof content !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) {
    throw invalidSkill(`文件须为 UTF-8 文本: ${path}`);
  }
  const bytes = new TextEncoder().encode(content);
  if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) !== content) throw invalidSkill(`文件编码无效: ${path}`);
  return bytes.byteLength;
}

function decodeText(bytes: Uint8Array, path: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw invalidSkill(`文件须为 UTF-8 文本: ${path}`); }
}

async function parseSkillPackage(
  bytes: Uint8Array, filename: string, source: 'upload' | 'import', sourceUrl: string | null = null,
): Promise<SkillInput> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw invalidSkill('技能包不得超过 5 MB');
  if (!filename.toLowerCase().endsWith('.zip')) {
    if (!filename.toLowerCase().endsWith('.md')) throw invalidSkill('仅支持 .zip 或 Markdown 技能包');
    return { ...parseSkillMarkdown(decodeText(bytes, filename)), source, source_url: sourceUrl };
  }
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); }
  catch { throw invalidSkill('无法读取 ZIP，请上传有效且未加密的技能包'); }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_FILES + 1) throw invalidSkill('技能包文件不得超过 101 个');
  for (const entry of entries) {
    const original = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    if (!safeArchivePath(original) || original !== entry.name) throw invalidSkill(`非法文件路径: ${original}`);
  }
  const manifests = entries.filter((entry) => entry.name.split('/').pop()?.toLowerCase() === 'skill.md');
  if (manifests.length !== 1) throw invalidSkill('技能包必须且只能包含一个 SKILL.md');
  const manifest = manifests[0]!;
  const root = manifest.name.slice(0, -'SKILL.md'.length);
  const files: SkillRecord['files'] = [];
  let markdown = '';
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith(root)) throw invalidSkill(`文件不在 SKILL.md 所在目录: ${entry.name}`);
    const path = entry.name.slice(root.length);
    const limit = entry === manifest ? MAX_CONTENT_BYTES : MAX_REFERENCE_BYTES;
    const chunks: Uint8Array[] = [];
    let size = 0;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const stream = entry.nodeStream();
    stream.on('data', (raw: string | Buffer) => {
      if (typeof raw === 'string') { stream.pause(); reject(invalidSkill(`ZIP 文件损坏: ${path}`)); return; }
      size += raw.byteLength;
      totalBytes += raw.byteLength;
      if (size > limit || totalBytes > MAX_ARCHIVE_BYTES) {
        stream.pause();
        reject(invalidSkill(`文件或解压总大小超出限制: ${path}`));
        return;
      }
      chunks.push(raw);
    });
    stream.on('error', () => reject(invalidSkill(`ZIP 文件损坏: ${path}`)));
    stream.on('end', () => resolve());
    stream.resume();
    await promise;
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    const content = decodeText(data, path);
    if (entry === manifest) markdown = content;
    else files.push({ path, content, size_bytes: size });
  }
  return { ...parseSkillMarkdown(markdown), source, source_url: sourceUrl, files };
}

function parseSkillMarkdown(markdown: string): Omit<SkillInput, 'source'> {
  const match = markdown.replace(/\r\n/g, '\n').match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/);
  if (!match) throw invalidSkill('SKILL.md 缺少 YAML frontmatter');
  let values: Record<string, unknown>;
  try {
    const parsed = Bun.YAML.parse(match[1]!);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    values = parsed as Record<string, unknown>;
  } catch { throw invalidSkill('SKILL.md 的 YAML frontmatter 无效'); }
  for (const key of ['name', 'display_name', 'title', 'description']) {
    if (values[key] !== undefined && typeof values[key] !== 'string') throw invalidSkill(`frontmatter ${key} 须为文本`);
  }
  const name = values.name as string ?? '';
  return {
    name, display_name: (values.display_name || values.title || name) as string,
    description: values.description as string ?? '', content: match[2]!, source_url: null, files: [],
  };
}

function safeArchivePath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !/[\\:\u0000-\u001f\u007f]/.test(path)
    && path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' && part.trim() === part);
}

async function fetchPublicUrl(initialUrl: string): Promise<Response> {
  let current = initialUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    await assertPublicHttpsUrl(current);
    let response: Response;
    try { response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }); }
    catch { throw invalidSkill('下载技能失败，请检查公网 HTTPS 地址或稍后重试'); }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
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
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: Array<{ address: string }>;
  try { addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true }); }
  catch { throw invalidSkill('导入地址无法解析'); }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) throw invalidSkill('导入地址必须解析到公网 IP');
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  // Only global-unicast IPv6 is eligible; this also excludes mapped private IPv4.
  if (isIP(normalized) === 6) return !/^[23][0-9a-f]{0,3}:/.test(normalized) || normalized.startsWith('2001:db8:');
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return true;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
    (parts[0] === 192 && (parts[1] === 168 || parts[1] === 0)) ||
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) || parts[0]! >= 224;
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

// A2A 对话附件：解析 message.parts 里的 kind=file，按 Portal 票据下载并落库为本地 user_file。
//
// 契约来源：Portal /chat 的 ask_agent 工具会把用户上传的文件放进 message.parts：
//   { "kind":"file", "file":{ "name":"销售数据.xlsx", "mimeType":"...", "url":"http://.../api/a2a/files?token=<uuid>:<secret>" } }
// token 即凭据（无需额外请求头，120s 有效、TTL 内可重试），系统端不保存 token，下载一次即落库。
//
// 失败一律降级：下载/校验/落库失败的附件只记一条 status-update 提示，不阻断文本问答。
import { posix } from 'node:path';
import type { Sql } from 'postgres';
import { AppError } from '../errors.ts';
import { newUuid } from '../infra/uuid.ts';
import type { CurrentActor } from '../models/identity.ts';
import type { ObjectStorage } from '../storage/types.ts';
import { isExtractableUserFileName } from '../files/extract.ts';
import {
  createStoredUserFile,
  normalizeUserFilePath,
  prepareMessageFiles,
  safeFileName,
  type PreparedMessageFiles,
} from '../files/service.ts';

/** 单条消息最多 5 个附件（与 Portal 上传上限一致）。 */
export const A2A_MAX_ATTACHMENTS = 5;
/** 单附件上限 20MB（Portal 上传上限 50MB，这里收紧以避免拉爆对话）。 */
export const A2A_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
/** 单个附件下载超时；Portal 票据 TTL 120s，单文件 30s 足够。 */
export const A2A_ATTACHMENT_TIMEOUT_MS = 30_000;

/** 扩展名 -> 落库时使用的规范 MIME。 */
const ATTACHMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Portal uploads 白名单（forum.ts allowed 的文档/文本/图片子集）。 */
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

export interface A2AFilePart {
  name: string;
  mimeType: string;
  url: string;
}

export interface DownloadedAttachment {
  part: A2AFilePart;
  /** 按扩展名规范化的 MIME，落库与抽取都以它为准。 */
  mimeType: string;
  extension: string;
  bytes: Uint8Array;
}

export type AttachmentFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** 附件级失败：只影响该附件，调用方降级为一条 status-update。 */
export class A2AAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'A2AAttachmentError';
  }
}

export interface AttachmentStore {
  store(input: { name: string; mimeType: string; bytes: Uint8Array }): Promise<{ id: string }>;
}

export interface AttachmentPreparer {
  prepare(fileIds: string[]): Promise<PreparedMessageFiles>;
}

export interface ReceiveA2AAttachmentsOptions {
  sql: Sql | null;
  storage: ObjectStorage;
  actor: CurrentActor;
  conversationId: string;
  fetchImpl?: AttachmentFetch;
  /** 测试注入：默认写本地 user_files 与对象存储。 */
  store?: AttachmentStore;
  /** 测试注入：默认调用 prepareMessageFiles 抽取 fileContext。 */
  prepare?: AttachmentPreparer;
}

export interface A2AAttachmentResult {
  /** 可纳入本轮上下文的 user_file id（已透传给 runAgentPipeline.fileIds）。 */
  fileIds: string[];
  /** <user_files> 包裹的文件正文 */
  fileContext: string;
  /** 需要以 status-update 下发的降级提示 */
  notices: string[];
}

const EMPTY_RESULT: A2AAttachmentResult = { fileIds: [], fileContext: '', notices: [] };

/** 抽取 parts 里的 file part（text part 由 partsText 处理，这里只认 kind=file）；最多 5 个。 */
export function extractFileParts(parts: unknown): A2AFilePart[] {
  if (!Array.isArray(parts)) return [];
  const out: A2AFilePart[] = [];
  for (const part of parts) {
    if (out.length >= A2A_MAX_ATTACHMENTS) break;
    if (part === null || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (record.kind !== 'file') continue;
    const file = record.file;
    if (file === null || typeof file !== 'object') continue;
    const raw = file as Record<string, unknown>;
    const rawName = typeof raw.name === 'string' ? raw.name.trim() : '';
    const name = rawName === '' ? '' : safeFileName(rawName);
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    const mimeType = typeof raw.mimeType === 'string'
      ? raw.mimeType.split(';', 1)[0]!.trim().toLowerCase()
      : '';
    if (name === '' || url === '') continue;
    if (!/^https?:\/\//iu.test(url)) continue;
    out.push({ name, mimeType, url });
  }
  return out;
}

/** 下载单个附件：校验 MIME 白名单、Content-Length/实际大小上限、内容签名。 */
export async function downloadA2AAttachment(
  part: A2AFilePart,
  options: { fetchImpl?: AttachmentFetch; maxBytes?: number; timeoutMs?: number } = {},
): Promise<DownloadedAttachment> {
  const maxBytes = options.maxBytes ?? A2A_ATTACHMENT_MAX_BYTES;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const extension = fileExtension(part.name);
  const canonicalMime = ATTACHMENT_TYPES[extension];
  if (canonicalMime === undefined) throw new A2AAttachmentError('格式不受支持');
  if (part.mimeType !== '' && !ALLOWED_MIME.has(part.mimeType)) {
    throw new A2AAttachmentError('格式不受支持');
  }

  const response = await fetchWithTimeout(fetchImpl, part.url, options.timeoutMs ?? A2A_ATTACHMENT_TIMEOUT_MS);
  if (!response.ok) throw new A2AAttachmentError('下载失败');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new A2AAttachmentError('超过 20MB 限制');
  }
  const bytes = await readBoundedBody(response, maxBytes);
  if (bytes.byteLength === 0) throw new A2AAttachmentError('下载失败');
  verifyAttachmentContent(extension, bytes);
  return { part, mimeType: canonicalMime, extension, bytes };
}

/**
 * A2A 附件接收入口：下载 -> 落库 user_file -> 抽取 fileContext。
 * 任何单附件失败都只产生 notices，不影响返回的 fileIds/fileContext。
 */
export async function receiveA2AAttachments(
  parts: unknown,
  options: ReceiveA2AAttachmentsOptions,
): Promise<A2AAttachmentResult> {
  const fileParts = extractFileParts(parts);
  if (fileParts.length === 0) return { ...EMPTY_RESULT };
  if (options.sql === null) {
    return {
      fileIds: [], fileContext: '',
      notices: [`收到 ${fileParts.length} 个附件，但本系统未启用用户文件存储，已忽略`],
    };
  }
  const sql = options.sql;
  const store = options.store
    ?? localAttachmentStore(sql, options.storage, options.actor, options.conversationId);
  const prepare = options.prepare ?? {
    prepare: (fileIds: string[]) => prepareMessageFiles(
      sql, options.storage, options.actor.tenant_id, options.actor.user_id,
      options.conversationId, fileIds),
  };

  const notices: string[] = [];
  const contextIds: string[] = [];
  for (const part of fileParts) {
    let downloaded: DownloadedAttachment;
    try {
      downloaded = await downloadA2AAttachment(part, { fetchImpl: options.fetchImpl });
    } catch (error) {
      notices.push(`附件 ${part.name} ${attachmentReason(error)}，已忽略`);
      continue;
    }
    let storedId: string;
    try {
      storedId = (await store.store({
        name: part.name, mimeType: downloaded.mimeType, bytes: downloaded.bytes,
      })).id;
    } catch {
      notices.push(`附件 ${part.name} 保存失败，已忽略`);
      continue;
    }
    if (isExtractableUserFileName(part.name)) {
      contextIds.push(storedId);
    } else {
      notices.push(`附件 ${part.name} 类型暂不支持解读，已保存但未纳入本轮回答`);
    }
  }
  if (contextIds.length === 0) return { fileIds: [], fileContext: '', notices };
  try {
    const prepared = await prepare.prepare(contextIds);
    return { fileIds: prepared.file_ids, fileContext: prepared.context, notices };
  } catch {
    notices.push('附件内容解析失败，已忽略');
    return { fileIds: [], fileContext: '', notices };
  }
}

/** 把附件写进当前 actor 的 user_files（等价于用户在后台上传）。重名时加一层随机目录避免唯一键冲突。 */
export function localAttachmentStore(
  sql: Sql,
  storage: ObjectStorage,
  actor: CurrentActor,
  conversationId: string,
): AttachmentStore {
  const insert = async (path: string, mimeType: string, bytes: Uint8Array) => {
    const file = await createStoredUserFile(sql, storage, {
      tenantId: actor.tenant_id,
      userId: actor.user_id,
      conversationId,
      path,
      mimeType,
      source: 'upload',
      bytes,
    });
    return { id: file.id };
  };
  return {
    async store({ name, mimeType, bytes }) {
      try {
        return await insert(normalizeUserFilePath(null, name), mimeType, bytes);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'FILE_PATH_EXISTS') throw error;
        // 同一用户重复上传同名文件时保留原文件名，仅路径加一层随机目录。
        return await insert(`${newUuid().slice(0, 8)}/${safeFileName(name)}`, mimeType, bytes);
      }
    },
  };
}

async function fetchWithTimeout(
  fetchImpl: AttachmentFetch,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { method: 'GET', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new A2AAttachmentError('超过 20MB 限制');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new A2AAttachmentError('超过 20MB 限制');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** 内容签名校验（对齐 Portal forum.ts validFile）：MIME 可伪造，落库前再核一遍。 */
function verifyAttachmentContent(extension: string, bytes: Uint8Array): void {
  const ok = (() => {
    switch (extension) {
      case 'pdf':
        return ascii(bytes, 0, 5) === '%PDF-';
      case 'docx':
      case 'xlsx':
      case 'pptx':
        return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
      case 'png':
        return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      case 'jpg':
      case 'jpeg':
        return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      case 'gif':
        return ascii(bytes, 0, 4) === 'GIF8';
      case 'webp':
        return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP';
      default:
        return isDecodableText(extension, bytes);
    }
  })();
  if (!ok) throw new A2AAttachmentError('内容校验失败');
}

function isDecodableText(extension: string, bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (text.includes('\u0000')) return false;
  if (extension === 'json') {
    try {
      JSON.parse(text);
    } catch {
      return false;
    }
  }
  return true;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let index = start; index < end; index += 1) {
    out += String.fromCharCode(bytes[index] ?? 0);
  }
  return out;
}

function attachmentReason(error: unknown): string {
  return error instanceof A2AAttachmentError ? error.message : '下载失败';
}

function fileExtension(name: string): string {
  const base = posix.basename(name);
  return base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
}

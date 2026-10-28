// A2A 附件测试：file part 解析、下载失败降级、成功时 fileIds 透传（全部走 stub，不碰真实网络）。
import { describe, expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import type { CurrentActor } from '../models/identity.ts';
import type { ObjectStorage } from '../storage/types.ts';
import { isExtractableUserFileName } from '../files/extract.ts';
import {
  A2A_ATTACHMENT_MAX_BYTES, A2A_MAX_ATTACHMENTS,
  A2AAttachmentError,
  downloadA2AAttachment,
  extractFileParts,
  receiveA2AAttachments,
  type AttachmentFetch,
  type AttachmentPreparer,
  type AttachmentStore,
} from './attachments.ts';

const actor = { tenant_id: 't-1', user_id: 'u-1' } as unknown as CurrentActor;
const storage = {} as ObjectStorage;
const sql = (() => Promise.resolve([])) as unknown as Sql;

const XLSX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

function filePart(name: string, mimeType: string, url = 'http://portal.test/api/a2a/files?token=x:y') {
  return { kind: 'file', file: { name, mimeType, url } };
}

function stubFetch(bytes: Uint8Array, init: ResponseInit = {}): AttachmentFetch {
  return (async () => new Response(bytes, init)) as AttachmentFetch;
}

function fakeResponse(options: {
  ok?: boolean; status?: number; contentLength?: string; bytes?: Uint8Array;
}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: new Headers(options.contentLength === undefined ? {} : { 'content-length': options.contentLength }),
    body: null,
    arrayBuffer: async () => options.bytes ?? new Uint8Array(0),
  } as unknown as Response;
}

describe('extractFileParts', () => {
  test('只取 kind=file，忽略 text part 与畸形 part', () => {
    const parts = [
      { kind: 'text', text: '帮我看这份表' },
      filePart('销售数据.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      { kind: 'file', file: { name: '', mimeType: 'text/plain', url: 'http://p/x' } },
      { kind: 'file', file: { name: 'a.txt', mimeType: 'text/plain', url: 'ftp://p/x' } },
      null,
      { kind: 'file' },
    ];
    expect(extractFileParts(parts)).toEqual([
      {
        name: '销售数据.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        url: 'http://portal.test/api/a2a/files?token=x:y',
      },
    ]);
  });

  test('单条消息最多 5 个附件', () => {
    const parts = Array.from({ length: 8 }, (_, index) => filePart(`f${index}.txt`, 'text/plain'));
    expect(extractFileParts(parts)).toHaveLength(A2A_MAX_ATTACHMENTS);
  });

  test('非数组返回空', () => {
    expect(extractFileParts(undefined)).toEqual([]);
    expect(extractFileParts('file')).toEqual([]);
  });
});

describe('downloadA2AAttachment', () => {
  test('成功下载并规范化 MIME', async () => {
    const downloaded = await downloadA2AAttachment(
      { name: '销售数据.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', url: 'http://p/x' },
      { fetchImpl: stubFetch(XLSX_BYTES, { headers: { 'content-length': String(XLSX_BYTES.byteLength) } }) },
    );
    expect(downloaded.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(downloaded.extension).toBe('xlsx');
    expect([...downloaded.bytes]).toEqual([...XLSX_BYTES]);
  });

  test('MIME 白名单外直接拒绝', async () => {
    await expect(downloadA2AAttachment(
      { name: 'movie.mp4', mimeType: 'video/mp4', url: 'http://p/x' },
      { fetchImpl: stubFetch(new Uint8Array([1])) },
    )).rejects.toBeInstanceOf(A2AAttachmentError);
  });

  test('Content-Length 超限拒绝', async () => {
    await expect(downloadA2AAttachment(
      { name: 'big.txt', mimeType: 'text/plain', url: 'http://p/x' },
      { fetchImpl: (async () => fakeResponse({ contentLength: String(A2A_ATTACHMENT_MAX_BYTES + 1) })) as AttachmentFetch },
    )).rejects.toThrow('超过 20MB 限制');
  });

  test('实际字节超限拒绝', async () => {
    await expect(downloadA2AAttachment(
      { name: 'big.txt', mimeType: 'text/plain', url: 'http://p/x' },
      { fetchImpl: (async () => fakeResponse({ bytes: new Uint8Array(8) })) as AttachmentFetch, maxBytes: 4 },
    )).rejects.toThrow('超过 20MB 限制');
  });

  test('内容签名不符拒绝', async () => {
    await expect(downloadA2AAttachment(
      { name: '合同.pdf', mimeType: 'application/pdf', url: 'http://p/x' },
      { fetchImpl: stubFetch(new TextEncoder().encode('not a pdf')) },
    )).rejects.toThrow('内容校验失败');
  });

  test('HTTP 非 2xx 视为下载失败', async () => {
    await expect(downloadA2AAttachment(
      { name: 'a.txt', mimeType: 'text/plain', url: 'http://p/x' },
      { fetchImpl: (async () => fakeResponse({ ok: false, status: 404 })) as AttachmentFetch },
    )).rejects.toThrow('下载失败');
  });
});

describe('receiveA2AAttachments', () => {
  const store: AttachmentStore = { store: async ({ name }) => ({ id: `file:${name}` }) };
  const prepare: AttachmentPreparer = {
    prepare: async (fileIds) => ({ file_ids: fileIds, files: [], context: `<user_files>${fileIds.join(',')}</user_files>` }),
  };

  test('下载失败降级为提示，不抛错、无 fileIds', async () => {
    const result = await receiveA2AAttachments([filePart('a.txt', 'text/plain')], {
      sql, storage, actor, conversationId: 'c-1', store, prepare,
      fetchImpl: (async () => fakeResponse({ ok: false, status: 500 })) as AttachmentFetch,
    });
    expect(result.fileIds).toEqual([]);
    expect(result.fileContext).toBe('');
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain('附件 a.txt');
    expect(result.notices[0]).toContain('已忽略');
  });

  test('成功时 fileIds / fileContext 透传', async () => {
    const result = await receiveA2AAttachments([
      filePart('销售数据.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      filePart('说明.txt', 'text/plain'),
    ], {
      sql, storage, actor, conversationId: 'c-1', store, prepare,
      fetchImpl: stubFetch(XLSX_BYTES),
    });
    expect(result.fileIds).toEqual(['file:销售数据.xlsx', 'file:说明.txt']);
    expect(result.fileContext).toBe('<user_files>file:销售数据.xlsx,file:说明.txt</user_files>');
    expect(result.notices).toEqual([]);
  });

  test('图片可落库但不纳入本轮上下文', async () => {
    const stored: string[] = [];
    const result = await receiveA2AAttachments([filePart('图表.png', 'image/png')], {
      sql, storage, actor, conversationId: 'c-1', prepare,
      store: { store: async ({ name }) => { stored.push(name); return { id: `file:${name}` }; } },
      fetchImpl: stubFetch(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])),
    });
    expect(stored).toEqual(['图表.png']);
    expect(result.fileIds).toEqual([]);
    expect(result.notices[0]).toContain('类型暂不支持解读');
  });

  test('未启用用户文件存储时只提示', async () => {
    const result = await receiveA2AAttachments([filePart('a.txt', 'text/plain')], {
      sql: null, storage, actor, conversationId: 'c-1',
      fetchImpl: stubFetch(new TextEncoder().encode('hi')),
    });
    expect(result.fileIds).toEqual([]);
    expect(result.notices[0]).toContain('未启用用户文件存储');
  });

  test('无 file part 时无提示、无副作用', async () => {
    const result = await receiveA2AAttachments([{ kind: 'text', text: '你好' }], {
      sql: null, storage, actor, conversationId: 'c-1',
    });
    expect(result).toEqual({ fileIds: [], fileContext: '', notices: [] });
  });
});

describe('isExtractableUserFileName', () => {
  test('pdf/docx/xlsx 可抽取，图片不可抽取', () => {
    expect(isExtractableUserFileName('合同.pdf')).toBeTrue();
    expect(isExtractableUserFileName('表.xlsx')).toBeTrue();
    expect(isExtractableUserFileName('文.docx')).toBeTrue();
    expect(isExtractableUserFileName('笔记.md')).toBeTrue();
    expect(isExtractableUserFileName('图表.png')).toBeFalse();
    expect(isExtractableUserFileName('photo.jpg')).toBeFalse();
  });
});

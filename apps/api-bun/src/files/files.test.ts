import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import type { Sql } from 'postgres';
import type { ObjectStorage } from '../storage/types.ts';
import { boundedMultipartFormData } from '../api/files.ts';
import {
  extractUserFileText, MAX_FILE_CONTEXT_CHARS, validateUserUpload,
} from './extract.ts';
import {
  getOwnedUserFile, normalizeUserFilePath, prepareMessageFiles, userFileStorageKey,
} from './service.ts';

const FILE_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_ID = '00000000-0000-4000-8000-000000000002';
const USER_ID = '00000000-0000-4000-8000-000000000003';

function fileSql(conversationId: string | null = null): Sql {
  const row = {
    id: FILE_ID,
    tenant_id: TENANT_ID,
    user_id: USER_ID,
    conversation_id: conversationId,
    name: 'private.txt',
    path: 'private.txt',
    mime_type: 'text/plain',
    size_bytes: 7,
    source: 'upload',
    storage_key: userFileStorageKey(
      TENANT_ID, USER_ID, FILE_ID, '00000000-0000-4000-8000-000000000004', 'private.txt',
    ),
    extracted_text: null,
    extraction_truncated: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
  return {
    unsafe: async (query: string, values: unknown[]) => {
      if (query.includes('id = ANY')) {
        return values[0] === TENANT_ID && values[1] === USER_ID
          && Array.isArray(values[2]) && values[2].includes(FILE_ID) ? [row] : [];
      }
      return values[0] === FILE_ID && values[1] === TENANT_ID && values[2] === USER_ID ? [row] : [];
    },
  } as unknown as Sql;
}

describe('private user files', () => {
  test('owner scope hides files from another tenant or user', async () => {
    const sql = fileSql();
    expect((await getOwnedUserFile(sql, TENANT_ID, USER_ID, FILE_ID)).path).toBe('private.txt');
    await expect(getOwnedUserFile(sql, TENANT_ID, crypto.randomUUID(), FILE_ID))
      .rejects.toMatchObject({ code: 'FILE_NOT_FOUND', httpStatus: 404 });
    await expect(getOwnedUserFile(sql, crypto.randomUUID(), USER_ID, FILE_ID))
      .rejects.toMatchObject({ code: 'FILE_NOT_FOUND', httpStatus: 404 });
  });


  test('a file already bound to another conversation is hidden', async () => {
    const originalConversation = crypto.randomUUID();
    await expect(prepareMessageFiles(
      fileSql(originalConversation),
      {} as ObjectStorage,
      TENANT_ID,
      USER_ID,
      crypto.randomUUID(),
      [FILE_ID],
    )).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', httpStatus: 404 });
  });
  test('virtual paths stay relative and traversal-free', () => {
    expect(normalizeUserFilePath('reports/2026/', 'result.docx')).toBe('reports/2026/result.docx');
    for (const path of ['/etc/passwd', '../secret', 'reports/../../secret', 'C:\\secret', 'a\\b']) {
      expect(() => normalizeUserFilePath(path, 'fallback.txt')).toThrow();
    }
  });
  test('bounds multipart bodies before and during parsing', async () => {
    const oversized = new Request('http://localhost/api/files', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=test',
        'Content-Length': '9',
      },
      body: new Uint8Array([1]),
    });
    await expect(boundedMultipartFormData(oversized, 8))
      .rejects.toMatchObject({ code: 'UPLOAD_REQUEST_TOO_LARGE', httpStatus: 413 });

    const chunked = new Request('http://localhost/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=test' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(9));
          controller.close();
        },
      }),
    });
    await expect(boundedMultipartFormData(chunked, 8))
      .rejects.toMatchObject({ code: 'UPLOAD_REQUEST_TOO_LARGE' });
  });

  test('allowlists extensions, validates packages, and returns canonical MIME', async () => {
    expect(await validateUserUpload(
      'notes.txt', 'notes.txt', new TextEncoder().encode('ok'),
    )).toBe('text/plain; charset=utf-8');
    await expect(validateUserUpload(
      'notes.txt', 'notes.txt', new Uint8Array([0xff]),
    )).rejects.toThrow();
    await expect(validateUserUpload(
      'report.pdf', 'report.pdf', new Uint8Array([1, 2, 3]),
    )).rejects.toThrow();
    await expect(validateUserUpload(
      'fake.docx', 'fake.docx', new Uint8Array([0x50, 0x4b, 3, 4]),
    )).rejects.toThrow();

    const zip = new JSZip();
    await expect(validateUserUpload(
      'bad.json', 'bad.json', new TextEncoder().encode('{'),
    )).rejects.toThrow();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('xl/workbook.xml', '<workbook/>');
    zip.file('xl/worksheets/sheet1.xml', '<worksheet/>');
    expect(await validateUserUpload(
      'table.xlsx', 'table.xlsx', await zip.generateAsync({ type: 'uint8array' }),
    )).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await expect(validateUserUpload(
      'table.xlsx', 'renamed.csv', new TextEncoder().encode('value'),
    )).rejects.toThrow('filename_path_extension_mismatch:xlsx:csv');
  });

  test('extracts bounded text and XLSX table cells', async () => {
    const long = await extractUserFileText(
      'notes.txt', 'text/plain', new TextEncoder().encode('甲'.repeat(MAX_FILE_CONTEXT_CHARS + 100)),
    );
    expect(long.truncated).toBeTrue();
    expect(long.text.length).toBe(MAX_FILE_CONTEXT_CHARS);
    expect(long.text).toEndWith('字符]');

    const zip = new JSZip();
    zip.file('xl/worksheets/sheet1.xml',
      '<?xml version="1.0"?><worksheet><sheetData><row>' +
      '<c t="inlineStr"><is><t>项目</t></is></c><c><v>42</v></c>' +
      '</row></sheetData></worksheet>');
    const xlsx = await extractUserFileText(
      'table.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      await zip.generateAsync({ type: 'uint8array' }),
    );
    expect(xlsx).toEqual({ text: '## sheet1.xml\n项目\t42', truncated: false });
  });
});

import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentDisposition } from '../http/content_disposition.ts';
import type { AppState } from '../state.ts';
import type { DocumentRecord } from './documents_types.ts';
import { downloadDocumentContent, downloadOfficePreviewPdf } from './documents_office.ts';

test('Chinese PDF/Office full responses and ranged reads remain valid HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'documind-preview-'));
  const bytes = new TextEncoder().encode('%PDF-1.4\npreview');
  const state = {
    config: { blobStorageDir: join(root, 'blobs') },
    storage: { size: async () => bytes.length, get: async () => bytes, getRange: async (_: string, start: number, end: number) => bytes.slice(start, end) },
  } as unknown as AppState;
  const doc = { id: 'file', title: '《中文制度》', file_name: '《中文制度》.pdf', file_type: 'pdf', storage_key: 'test', file_sha256: 'version', latest_parse_job_id: null } as DocumentRecord;
  try {
    const dir = join(root, 'preview_cache', 'office_pdfs', doc.id, doc.file_sha256);
    await mkdir(dir, { recursive: true }); await Bun.write(join(dir, 'converted.pdf'), bytes);
    for (const response of [
      await downloadDocumentContent(state, doc, new Headers(), true),
      await downloadDocumentContent(state, doc, new Headers(), false),
      await downloadOfficePreviewPdf(state, { ...doc, file_type: 'docx' }, new Headers()),
    ]) {
      expect(response.status).toBe(200);
      const header = response.headers.get('content-disposition')!;
      expect(header).toContain("filename*=UTF-8''"); expect(header).not.toMatch(/[^\x20-\x7e]/);
      expect(decodeURIComponent(header.split("filename*=UTF-8''")[1]!)).toBe(doc.file_name);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    }
    const ranged = await downloadOfficePreviewPdf(state, { ...doc, file_type: 'docx' }, new Headers({ range: 'bytes=0-4' }));
    expect(ranged.status).toBe(206); expect(await ranged.text()).toBe('%PDF-');
    for (const name of ['bad"\r\n/\\报告.pdf', "报价(草稿)'🚀.pdf", '\ud800.pdf']) {
      const header = contentDisposition(name);
      expect(header).not.toMatch(/[^\x20-\x7e]/);
      expect(() => new Response('', { headers: { 'Content-Disposition': header } })).not.toThrow();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

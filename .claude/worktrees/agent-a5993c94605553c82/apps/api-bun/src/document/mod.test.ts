// 移植自 apps/api-rs/src/api/documents.rs 的类型判定 / zip 安全 / 端到端用例
import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';

import { detectFileType, parseDocument } from './mod.ts';
import { hexSha256 } from './text_utils.ts';
import { MAX_OFFICE_XML_DEPTH, MAX_OFFICE_ZIP_ENTRIES } from './types.ts';

async function zipWithEntries(entries: Array<[string, string]>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, entryContent] of entries) {
    zip.file(name, entryContent);
  }
  return await zip.generateAsync({ type: 'uint8array' });
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const encoder = new TextEncoder();

describe('detectFileType', () => {
  test('detects office formats from the zip header even without extension', async () => {
    const bytes = await zipWithEntries([['word/document.xml', '<w:document/>']]);

    expect(await detectFileType('noext', 'application/octet-stream', bytes)).toBe('docx');
  });

  test('rejects extension / header mismatch', async () => {
    const bytes = encoder.encode('%PDF-1.4\ntrailer\n%%EOF\n');

    await expect(detectFileType('contract.docx', 'application/pdf', bytes)).rejects.toThrow('file_type_mismatch');
  });

  test('rejects declared mime / header mismatch', async () => {
    await expect(detectFileType('notes.txt', 'application/pdf', encoder.encode('hello')))
      .rejects.toThrow('file_type_mismatch');
  });

  test('rejects unsupported or corrupt files', async () => {
    await expect(detectFileType('blob.bin', 'application/octet-stream', new Uint8Array([0x00, 0x01, 0x02, 0x03])))
      .rejects.toThrow('unsupported_or_corrupt_file');
  });

  test('detects plain text and markdown by extension', async () => {
    expect(await detectFileType('notes.txt', 'text/plain', encoder.encode('第一段\n\n第二段'))).toBe('txt');
    expect(await detectFileType('README.md', 'text/markdown', encoder.encode('# 标题'))).toBe('md');
  });
});

describe('office zip safety', () => {
  test('rejects office zip with too many entries', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    for (let index = 1; index < MAX_OFFICE_ZIP_ENTRIES + 1; index += 1) {
      zip.file(`docProps/empty-${index}.xml`, '');
    }
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    await expect(detectFileType('oversized.docx', DOCX_MIME, bytes)).rejects.toThrow('zip_entry_count_exceeded');
  });

  test('rejects office zip with unsafe entry name', async () => {
    // 注：JSZip 会把 '../outside.xml' 归一化为 'outside.xml'，这里用绝对路径与冒号两种非法名（Rust 同样拒绝）
    for (const unsafeName of ['/absolute.xml', 'a:b.xml']) {
      const bytes = await zipWithEntries([
        ['word/document.xml', '<w:document/>'],
        [unsafeName, 'malicious'],
      ]);

      await expect(detectFileType('unsafe.docx', DOCX_MIME, bytes)).rejects.toThrow('zip_entry_name_unsafe');
    }
  });

  test('rejects excessively nested office xml without crashing', async () => {
    const depth = MAX_OFFICE_XML_DEPTH + 1;
    const xml = `<w:document xmlns:w="urn:test"><w:body>${'<w:sdt>'.repeat(depth)}${'</w:sdt>'.repeat(depth)}</w:body></w:document>`;
    const bytes = await zipWithEntries([['word/document.xml', xml]]);

    await expect(parseDocument(crypto.randomUUID(), crypto.randomUUID(), 'deep.docx', DOCX_MIME, bytes))
      .rejects.toThrow('office_xml_nesting_exceeded');
  });
});

describe('parseDocument (plain text / markdown)', () => {
  test('builds chunks from blocks', async () => {
    const text = '# 付款条款\n\n合同签署后支付首付款30%。\n\n验收通过后支付60%。';
    const bundle = await parseDocument(
      crypto.randomUUID(),
      crypto.randomUUID(),
      'terms.md',
      'text/markdown',
      encoder.encode(text),
    );

    expect(bundle.chunks.length).toBe(1);
    expect(bundle.chunks[0]!.content).toContain('付款条款');
    expect(bundle.chunks[0]!.block_ids.length).toBe(3);
  });

  test('keeps parse identity fields consistent', async () => {
    const bytes = encoder.encode('付款节点包括首付款、验收款和质保金。'.repeat(80));
    const docId = crypto.randomUUID();
    const parseJobId = crypto.randomUUID();
    const bundle = await parseDocument(docId, parseJobId, 'terms.txt', 'text/plain', bytes);

    expect(bundle.file_type).toBe('txt');
    expect(bundle.file_sha256).toBe(hexSha256(bytes));
    expect(bundle.parsed.doc_id).toBe(docId);
    expect(bundle.parsed.parse_job_id).toBe(parseJobId);
    expect(bundle.parsed.title).toBe('terms');
    expect(bundle.parsed.quality_score).toBeGreaterThan(0);
    expect(bundle.chunks.every((chunk) => chunk.block_ids.length > 0)).toBe(true);
    expect(bundle.chunks.every((chunk) => chunk.anchor_ids.length > 0)).toBe(true);
  });

  test('scanned pdf warning helper input: no chunks for empty text', async () => {
    const bundle = await parseDocument(crypto.randomUUID(), crypto.randomUUID(), 'empty.txt', 'text/plain', encoder.encode(''));

    expect(bundle.parsed.blocks.length).toBe(0);
    expect(bundle.chunks.length).toBe(0);
  });
});

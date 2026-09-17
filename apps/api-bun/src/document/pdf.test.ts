// PDF 解析测试（对照 apps/api-rs/src/api/documents.rs 的 pdf 用例）
import { describe, expect, test } from 'bun:test';

import { parseDocument } from './mod.ts';
import { MAX_PDF_PAGES, MAX_PDF_PAGE_TEXT_CHARS } from './types.ts';

function buildPdf(objects: string[]): Uint8Array {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** 对齐 Rust blank_pdf_with_pages：N 页空白 PDF（无文本层） */
function blankPdfWithPages(pageCount: number): Uint8Array {
  const kids = Array.from({ length: pageCount }, (_, index) => `${4 + index} 0 R`);
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`,
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  for (let index = 0; index < pageCount; index += 1) {
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents 3 0 R >>');
  }
  return buildPdf(objects);
}

/**
 * 对齐 Rust single_page_pdf_with_text；可选字号 / MediaBox。
 * 注意 pdfjs 会把超出页面范围的字形丢弃（Rust 的 pdf_extract 不会），
 * 因此「超过单页字符上限」的用例用超宽 MediaBox + 小字号。
 */
function singlePagePdfWithText(
  text: string,
  options: { fontSize?: number; mediaBox?: string } = {},
): Uint8Array {
  const fontSize = options.fontSize ?? 12;
  const mediaBox = options.mediaBox ?? '0 0 595 842';
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT\n/F1 ${fontSize} Tf\n72 720 Td\n(${escaped}) Tj\nET`;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  return buildPdf(objects);
}

describe('parseDocument (pdf)', () => {
  test('extracts the text layer into paragraph blocks', async () => {
    const bundle = await parseDocument(
      crypto.randomUUID(),
      crypto.randomUUID(),
      'report.pdf',
      'application/pdf',
      singlePagePdfWithText('Q1 sales target 1200 units.'),
    );

    expect(bundle.file_type).toBe('pdf');
    expect(bundle.parsed.pages).toBe(1);
    expect(bundle.parsed.blocks.length).toBe(1);
    expect(bundle.parsed.blocks[0]!.block_type).toBe('paragraph');
    expect(bundle.parsed.blocks[0]!.text).toContain('1200 units');
    expect(bundle.parsed.blocks[0]!.page_start).toBe(1);
    expect(bundle.parsed.blocks[0]!.anchor_ids.length).toBe(1);
    expect(bundle.parsed.anchors.length).toBe(1);
    expect(bundle.parsed.anchors[0]!.anchor_quality).toBe('page');
    expect(bundle.chunks.length).toBe(1);
    expect(bundle.chunks[0]!.content).toContain('页码：1');
  });

  test('rejects pdf with too many pages', async () => {
    await expect(parseDocument(
      crypto.randomUUID(),
      crypto.randomUUID(),
      'large.pdf',
      'application/pdf',
      blankPdfWithPages(MAX_PDF_PAGES + 1),
    )).rejects.toThrow('pdf_page_count_exceeded');
  });

  test('rejects pdf page with too much text', async () => {
    await expect(parseDocument(
      crypto.randomUUID(),
      crypto.randomUUID(),
      'dense.pdf',
      'application/pdf',
      singlePagePdfWithText('A'.repeat(MAX_PDF_PAGE_TEXT_CHARS + 1), {
        fontSize: 1,
        mediaBox: '0 0 100000 1000',
      }),
    )).rejects.toThrow('pdf_page_text_chars_exceeded');
  });

  test('scanned pdf without text layer reports warnings and yields no chunks', async () => {
    const bundle = await parseDocument(
      crypto.randomUUID(),
      crypto.randomUUID(),
      'scanned.pdf',
      'application/pdf',
      blankPdfWithPages(1),
    );

    expect(bundle.parsed.pages).toBe(1);
    expect(bundle.parsed.blocks.length).toBe(0);
    expect(bundle.parsed.warnings).toContain('pdf_page_1_no_text_layer');
    expect(bundle.parsed.warnings).toContain('scanned_pdf_no_text_layer');
    expect(bundle.chunks.length).toBe(0);
  });
});

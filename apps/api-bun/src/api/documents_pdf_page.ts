// 移植自 apps/api-rs/src/api/documents.rs 的 pdf_page_count / extract_single_page_pdf —— 写出侧
// 依赖 documents_pdf.ts 的最小 PDF 对象层；用增量更新追加新的 Catalog/Pages。
import { asciiBytes, bytesOfString, hexOf, PdfDocument } from './documents_pdf.ts';
import type { PdfDict, PdfValue } from './documents_pdf.ts';

// ---------------------------------------------------------------------------
// 串行化（增量更新用）
// ---------------------------------------------------------------------------

function serialize(value: PdfValue): string {
  switch (value.kind) {
    case 'name': return '/' + value.value;
    case 'string': return '<' + hexOf(bytesOfString(value) ?? new Uint8Array()) + '>';
    case 'number': return Number.isInteger(value.value) ? String(value.value) : String(value.value);
    case 'bool': return value.value ? 'true' : 'false';
    case 'null': return 'null';
    case 'ref': return `${value.num} ${value.gen} R`;
    case 'array': return '[' + value.items.map(serialize).join(' ') + ']';
    case 'dict': {
      const parts: string[] = [];
      for (const [key, entry] of value.map) parts.push('/' + key, serialize(entry));
      return '<< ' + parts.join(' ') + ' >>';
    }
  }
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

export function pdfPageCount(bytes: Uint8Array): number {
  return PdfDocument.load(bytes).collectPages().length;
}

export function extractSinglePagePdf(pdfBytes: Uint8Array, page: number): { bytes: Uint8Array; totalPages: number } {
  if (!Number.isInteger(page) || page < 1) throw new Error(`page ${page} out of range`);
  const doc = PdfDocument.load(pdfBytes);
  const pages = doc.collectPages();
  const total = pages.length;
  if (page > total) throw new Error(`page ${page} out of range (1-${total})`);
  const target = pages[page - 1]!;

  const catalog = doc.resolve(doc.rootRef === null ? null : doc.rootRef);
  if (catalog === null || catalog.kind !== 'dict') throw new Error('pdf catalog is not a dictionary');
  const catalogNum = doc.maxObjectNumber() + 1;
  const pagesNum = catalogNum + 1;

  const newCatalog: PdfDict = { kind: 'dict', map: new Map(catalog.map), stream: null };
  newCatalog.map.set('Pages', { kind: 'ref', num: pagesNum, gen: 0 });
  const newPages: PdfDict = {
    kind: 'dict',
    map: new Map<string, PdfValue>([
      ['Type', { kind: 'name', value: 'Pages' }],
      ['Kids', { kind: 'array', items: [{ kind: 'ref', num: target.num, gen: target.gen }] }],
      ['Count', { kind: 'number', value: 1 }],
    ]),
    stream: null,
  };

  const objects: Array<[number, PdfDict]> = [[catalogNum, newCatalog], [pagesNum, newPages]];
  let body = '';
  const offsets = new Map<number, number>();
  let base = pdfBytes.length;
  const needsNewline = base > 0 && pdfBytes[base - 1] !== 0x0a;
  if (needsNewline) base += 1;
  let cursor = base;
  for (const [num, dict] of objects) {
    const text = `${num} 0 obj\n${serialize(dict)}\nendobj\n`;
    offsets.set(num, cursor);
    body += text;
    cursor += text.length;
  }

  const trailerParts: string[] = [
    `/Size ${pagesNum + 1}`,
    `/Root ${catalogNum} 0 R`,
    `/Prev ${doc.startXrefOffset}`,
  ];
  const trailer = doc.trailer;
  if (trailer !== null) {
    for (const key of ['Info', 'ID', 'Encrypt']) {
      const entry = trailer.map.get(key);
      if (entry !== undefined) trailerParts.push(`/${key} ${serialize(entry)}`);
    }
  }

  const xrefOffset = cursor;
  let xref = 'xref\n0 1\n0000000000 65535 f \n';
  for (const [num] of objects) {
    const offset = offsets.get(num) ?? 0;
    xref += `${num} 1\n${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< ${trailerParts.join(' ')} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  const appended = asciiBytes((needsNewline ? '\n' : '') + body + xref);
  const out = new Uint8Array(pdfBytes.length + appended.length);
  out.set(pdfBytes, 0);
  out.set(appended, pdfBytes.length);
  return { bytes: out, totalPages: total };
}

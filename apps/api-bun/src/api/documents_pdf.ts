// 移植自 apps/api-rs/src/api/documents.rs 的 pdf_page_count / extract_single_page_pdf —— 文档层
//
// Rust 使用 lopdf；Bun 侧没有等价库（pdfjs-dist 只能读不能写），因此这里实现最小 PDF 对象层：
// 解析 xref（经典交叉表、xref 流、对象流）→ 按页树顺序定位目标页 → 在 documents_pdf_page.ts
// 里以“增量更新”方式追加新的 Catalog/Pages，使 /Pages 只包含目标页。
//
// 新 trailer 带 /Prev 指向原 xref，原文件字节全部可达，目标页的 /Contents、/Resources
// 以及通过 /Parent 继承的 MediaBox 都能正常解析；代价是体积比 Rust 的 prune 版本大。
import {
  Reader, asciiBytes, decodeStream, dictGet, intOf, latin1, nameOf,
} from './documents_pdf_reader.ts';
import type { PdfDict, PdfRef, PdfValue } from './documents_pdf_reader.ts';
export { asciiBytes, bytesOfString, hexOf } from './documents_pdf_reader.ts';
export type { PdfDict, PdfValue } from './documents_pdf_reader.ts';

interface NormalEntry { type: 'normal'; offset: number; gen: number }
interface CompressedEntry { type: 'compressed'; objStm: number; index: number }
type XrefEntry = NormalEntry | CompressedEntry;

// ---------------------------------------------------------------------------
// 文档：xref 链 + 对象缓存 + 页树
// ---------------------------------------------------------------------------

export class PdfDocument {
  private readonly bytes: Uint8Array;
  private readonly xref = new Map<number, XrefEntry>();
  private readonly cache = new Map<number, PdfValue | null>();
  private readonly loading = new Set<number>();
  trailer: PdfDict | null = null;
  rootRef: PdfRef | null = null;
  startXrefOffset = 0;

  private constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  static load(bytes: Uint8Array): PdfDocument {
    const doc = new PdfDocument(bytes);
    doc.readStartXref();
    doc.readXrefChain(doc.startXrefOffset, new Set<number>());
    if (doc.rootRef === null) throw new Error('pdf trailer is missing /Root');
    return doc;
  }

  private readStartXref(): void {
    const tailStart = Math.max(0, this.bytes.length - 2048);
    const tail = latin1(this.bytes.subarray(tailStart));
    const match = /startxref\s+(\d+)\s*%%EOF\s*$/s.exec(tail);
    if (match === null) throw new Error('pdf is missing trailing startxref');
    this.startXrefOffset = Number.parseInt(match[1]!, 10);
  }

  private readXrefChain(offset: number, seen: Set<number>): void {
    if (seen.has(offset) || offset <= 0 || offset >= this.bytes.length) return;
    seen.add(offset);
    const reader = new Reader(this.bytes, offset);
    reader.skipWs();
    let trailer: PdfDict | null = null;
    if (reader.matchKeyword('xref')) {
      trailer = this.readXrefTable(reader);
    } else {
      const parsed = this.parseIndirectObjectAt(offset);
      if (parsed.value.kind !== 'dict') throw new Error('pdf xref stream is not a dictionary');
      this.readXrefStream(parsed.value);
      trailer = parsed.value;
    }
    if (this.trailer === null && trailer !== null) {
      this.trailer = trailer;
      const root = dictGet(trailer, 'Root');
      if (root !== null && root.kind === 'ref') this.rootRef = root;
    }
    const prev = intOf(dictGet(trailer, 'Prev'));
    if (prev !== null) this.readXrefChain(prev, seen);
    const xrefStm = intOf(dictGet(trailer, 'XRefStm'));
    if (xrefStm !== null) this.readXrefChain(xrefStm, seen);
  }

  private readXrefTable(reader: Reader): PdfDict {
    for (;;) {
      reader.skipWs();
      if (reader.matchKeyword('trailer')) {
        const trailer = reader.parseValue();
        if (trailer.kind !== 'dict') throw new Error('pdf trailer is not a dictionary');
        return trailer;
      }
      const first = intOf(reader.parseValue());
      const count = intOf(reader.parseValue());
      if (first === null || count === null) throw new Error('invalid pdf xref subsection header');
      reader.skipWs();
      for (let i = 0; i < count; i += 1) {
        const lineStart = reader.pos;
        while (reader.pos < this.bytes.length && this.bytes[reader.pos] !== 0x0a) reader.pos += 1;
        const line = latin1(this.bytes.subarray(lineStart, reader.pos)).trim();
        reader.pos += 1;
        const parts = line.split(/\s+/);
        if (parts.length < 3) throw new Error(`invalid pdf xref entry: ${line}`);
        const num = first + i;
        if (parts[2] === 'n' && !this.xref.has(num)) {
          this.xref.set(num, { type: 'normal', offset: Number.parseInt(parts[0]!, 10), gen: Number.parseInt(parts[1]!, 10) });
        }
      }
    }
  }

  private readXrefStream(dict: PdfDict): void {
    const widths = dictGet(dict, 'W');
    if (widths === null || widths.kind !== 'array') throw new Error('pdf xref stream is missing /W');
    const w = widths.items.map((item) => intOf(item) ?? 0);
    const size = intOf(dictGet(dict, 'Size')) ?? 0;
    const index = dictGet(dict, 'Index');
    const pairs: number[] = index !== null && index.kind === 'array'
      ? index.items.map((item) => intOf(item) ?? 0)
      : [0, size];
    const data = decodeStream(dict);
    const w0 = w[0] ?? 0;
    const w1 = w[1] ?? 0;
    const w2 = w[2] ?? 0;
    const rowWidth = w0 + w1 + w2;
    if (rowWidth <= 0) throw new Error('pdf xref stream has zero-width entries');
    let pos = 0;
    const readField = (width: number): number => {
      let value = 0;
      for (let i = 0; i < width; i += 1) {
        value = value * 256 + (pos < data.length ? data[pos]! : 0);
        pos += 1;
      }
      return value;
    };
    for (let p = 0; p + 1 < pairs.length; p += 2) {
      const first = pairs[p]!;
      const count = pairs[p + 1]!;
      for (let i = 0; i < count; i += 1) {
        const type = w0 === 0 ? 1 : readField(w0);
        const field1 = readField(w1);
        const field2 = readField(w2);
        const num = first + i;
        if (this.xref.has(num)) continue;
        if (type === 1) this.xref.set(num, { type: 'normal', offset: field1, gen: field2 });
        else if (type === 2) this.xref.set(num, { type: 'compressed', objStm: field1, index: field2 });
      }
    }
  }

  private parseIndirectObjectAt(offset: number): { num: number; value: PdfValue } {
    const reader = new Reader(this.bytes, offset);
    reader.skipWs();
    const num = intOf(reader.parseValue());
    const gen = intOf(reader.parseValue());
    if (num === null || gen === null) throw new Error(`invalid pdf object header at ${offset}`);
    reader.skipWs();
    if (!reader.matchKeyword('obj')) throw new Error(`missing obj keyword at ${offset}`);
    const value = reader.parseValue();
    if (value.kind === 'dict') {
      const saved = reader.pos;
      reader.skipWs();
      if (reader.matchKeyword('stream')) {
        let streamStart = reader.pos;
        if (reader.peek() === 0x0d) streamStart += 1;
        if (reader.peek() === 0x0a) streamStart += 1;
        else if (this.bytes[reader.pos] === 0x0d) streamStart += 1;
        const length = intOf(dictGet(value, 'Length'));
        let streamEnd: number | null = null;
        if (length !== null && streamStart + length <= this.bytes.length) {
          const after = latin1(this.bytes.subarray(streamStart + length, Math.min(this.bytes.length, streamStart + length + 20)));
          if (/^\s*endstream/.test(after)) streamEnd = streamStart + length;
        }
        if (streamEnd === null) {
          const keyword = asciiBytes('endstream');
          for (let i = streamStart; i + keyword.length <= this.bytes.length; i += 1) {
            let matched = true;
            for (let j = 0; j < keyword.length; j += 1) {
              if (this.bytes[i + j] !== keyword[j]) { matched = false; break; }
            }
            if (matched) { streamEnd = i; break; }
          }
        }
        if (streamEnd === null) throw new Error('pdf stream is missing endstream');
        value.stream = this.bytes.subarray(streamStart, streamEnd);
      } else {
        reader.pos = saved;
      }
    }
    return { num, value };
  }

  getObject(num: number): PdfValue | null {
    if (this.cache.has(num)) return this.cache.get(num) ?? null;
    const entry = this.xref.get(num);
    if (entry === undefined) return null;
    if (this.loading.has(num)) return null;
    this.loading.add(num);
    let value: PdfValue | null = null;
    if (entry.type === 'normal') {
      value = this.parseIndirectObjectAt(entry.offset).value;
    } else {
      this.loadObjectStream(entry.objStm);
      value = this.cache.get(num) ?? null;
    }
    this.loading.delete(num);
    if (value !== null) this.cache.set(num, value);
    return value;
  }

  private loadObjectStream(objStmNum: number): void {
    if (this.cache.has(objStmNum)) return;
    const container = this.getObject(objStmNum);
    if (container === null || container.kind !== 'dict') return;
    const count = intOf(dictGet(container, 'N')) ?? 0;
    const first = intOf(dictGet(container, 'First')) ?? 0;
    const data = decodeStream(container);
    const header = new Reader(data, 0);
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < count; i += 1) {
      const objNum = intOf(header.parseValue());
      const relOffset = intOf(header.parseValue());
      if (objNum === null || relOffset === null) break;
      pairs.push([objNum, relOffset]);
    }
    for (const [objNum, relOffset] of pairs) {
      if (this.cache.has(objNum)) continue;
      const value = new Reader(data, first + relOffset).parseValue();
      this.cache.set(objNum, value);
    }
    this.cache.set(objStmNum, container);
  }

  resolve(value: PdfValue | null): PdfValue | null {
    if (value === null) return null;
    if (value.kind === 'ref') return this.getObject(value.num);
    return value;
  }

  collectPages(): PdfRef[] {
    if (this.rootRef === null) throw new Error('pdf trailer is missing /Root');
    const catalog = this.getObject(this.rootRef.num);
    if (catalog === null || catalog.kind !== 'dict') throw new Error('pdf catalog is not a dictionary');
    const pages: PdfRef[] = [];
    this.walkPages(dictGet(catalog, 'Pages'), pages, new Set<number>(), 0);
    return pages;
  }

  private walkPages(node: PdfValue | null, out: PdfRef[], seen: Set<number>, depth: number): void {
    if (node === null || depth > 64) return;
    const ref = node.kind === 'ref' ? node : null;
    if (ref !== null) {
      if (seen.has(ref.num)) return;
      seen.add(ref.num);
    }
    const dict = this.resolve(node);
    if (dict === null || dict.kind !== 'dict') return;
    const type = nameOf(dictGet(dict, 'Type'));
    const kids = dictGet(dict, 'Kids');
    if (type === 'Pages' || (type === null && kids !== null && kids.kind === 'array')) {
      if (kids !== null && kids.kind === 'array') {
        for (const kid of kids.items) this.walkPages(kid, out, seen, depth + 1);
      }
      return;
    }
    if (ref !== null) out.push(ref);
  }

  maxObjectNumber(): number {
    let max = 0;
    for (const num of this.xref.keys()) if (num > max) max = num;
    return max;
  }
}

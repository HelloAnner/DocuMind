// 移植自 apps/api-rs/src/api/documents.rs —— PDF 词法/语法与 xref 解析层（文档加载见 documents_pdf.ts）
// 原始注释：// 移植自 apps/api-rs/src/api/documents.rs 的 pdf_page_count / extract_single_page_pdf。
//
// Rust 使用 lopdf 裁剪单页 PDF；Bun 侧没有等价库（pdfjs-dist 只能读不能写），因此这里实现
// 一个最小 PDF 对象层：解析 xref（经典交叉表、xref 流、对象流）→ 按页树顺序定位目标页 →
// 以“增量更新”方式在文件尾部追加新的 Catalog/Pages，使 /Pages 只包含目标页。
//
// 为什么可以不裁剪旧对象：新 trailer 里带 /Prev 指向原 xref，原文件全部字节仍然可达，
// 目标页的 /Contents、/Resources 以及通过 /Parent 继承的 MediaBox 都能正常解析。
// 代价是输出体积比 Rust 的 prune 版本大，但渲染结果一致。

export type PdfName = { kind: 'name'; value: string };
export type PdfString = { kind: 'string'; value: string };
export type PdfNumber = { kind: 'number'; value: number };
export type PdfBool = { kind: 'bool'; value: boolean };
export type PdfNull = { kind: 'null' };
export type PdfRef = { kind: 'ref'; num: number; gen: number };
export type PdfArray = { kind: 'array'; items: PdfValue[] };
export type PdfDict = { kind: 'dict'; map: Map<string, PdfValue>; stream: Uint8Array | null };
export type PdfValue = PdfName | PdfString | PdfNumber | PdfBool | PdfNull | PdfRef | PdfArray | PdfDict;

interface NormalEntry { type: 'normal'; offset: number; gen: number }
interface CompressedEntry { type: 'compressed'; objStm: number; index: number }
export type XrefEntry = NormalEntry | CompressedEntry;

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

export function isWs(byte: number): boolean { return WS.has(byte); }
export function isDelimiter(byte: number): boolean {
  return byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e || byte === 0x5b
    || byte === 0x5d || byte === 0x7b || byte === 0x7d || byte === 0x2f || byte === 0x25;
}
export function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}
export function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
export function hexOf(data: Uint8Array): string {
  let out = '';
  for (const byte of data) out += byte.toString(16).padStart(2, '0');
  return out;
}

// ---------------------------------------------------------------------------
// 词法/语法解析
// ---------------------------------------------------------------------------

export class Reader {
  readonly bytes: Uint8Array;
  pos: number;

  constructor(bytes: Uint8Array, pos: number) {
    this.bytes = bytes;
    this.pos = pos;
  }

  private byteAt(index: number): number {
    return index >= 0 && index < this.bytes.length ? this.bytes[index]! : -1;
  }

  peek(): number { return this.byteAt(this.pos); }

  skipWs(): void {
    for (;;) {
      const byte = this.peek();
      if (byte < 0) return;
      if (isWs(byte)) { this.pos += 1; continue; }
      if (byte === 0x25) {
        while (this.pos < this.bytes.length && this.byteAt(this.pos) !== 0x0a) this.pos += 1;
        continue;
      }
      return;
    }
  }

  matchKeyword(keyword: string): boolean {
    const target = asciiBytes(keyword);
    if (this.pos + target.length > this.bytes.length) return false;
    for (let i = 0; i < target.length; i += 1) {
      if (this.bytes[this.pos + i] !== target[i]) return false;
    }
    const after = this.byteAt(this.pos + target.length);
    if (after >= 0 && !isWs(after) && !isDelimiter(after)) return false;
    this.pos += target.length;
    return true;
  }

  parseValue(): PdfValue {
    this.skipWs();
    const byte = this.peek();
    if (byte < 0) throw new Error('unexpected end of pdf file');
    if (byte === 0x2f) return this.parseName();
    if (byte === 0x28) return this.parseLiteralString();
    if (byte === 0x3c) return this.parseDictOrHexString();
    if (byte === 0x5b) return this.parseArray();
    if (byte === 0x74) { if (this.matchKeyword('true')) return { kind: 'bool', value: true }; }
    if (byte === 0x66) { if (this.matchKeyword('false')) return { kind: 'bool', value: false }; }
    if (byte === 0x6e) { if (this.matchKeyword('null')) return { kind: 'null' }; }
    if (byte === 0x2b || byte === 0x2d || byte === 0x2e || (byte >= 0x30 && byte <= 0x39)) {
      return this.parseNumberOrRef();
    }
    throw new Error(`unexpected pdf token byte ${byte}`);
  }

  private parseName(): PdfName {
    this.pos += 1;
    let value = '';
    while (this.pos < this.bytes.length) {
      const byte = this.byteAt(this.pos);
      if (byte < 0 || isWs(byte) || isDelimiter(byte)) break;
      value += String.fromCharCode(byte);
      this.pos += 1;
    }
    return { kind: 'name', value };
  }

  private parseLiteralString(): PdfString {
    this.pos += 1;
    let depth = 1;
    let value = '';
    while (this.pos < this.bytes.length) {
      let byte = this.byteAt(this.pos);
      this.pos += 1;
      if (byte === 0x5c) {
        const next = this.byteAt(this.pos);
        this.pos += 1;
        switch (next) {
          case 0x6e: value += '\n'; break;
          case 0x72: value += '\r'; break;
          case 0x74: value += '\t'; break;
          case 0x62: value += '\b'; break;
          case 0x66: value += '\f'; break;
          case 0x0a: break;
          default:
            if (next >= 0x30 && next <= 0x37) {
              let octal = String.fromCharCode(next);
              for (let i = 0; i < 2; i += 1) {
                const digit = this.byteAt(this.pos);
                if (digit >= 0x30 && digit <= 0x37) { octal += String.fromCharCode(digit); this.pos += 1; }
                else break;
              }
              value += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
            } else if (next >= 0) {
              value += String.fromCharCode(next);
            }
        }
        continue;
      }
      if (byte === 0x28) depth += 1;
      if (byte === 0x29) {
        depth -= 1;
        if (depth === 0) break;
      }
      value += String.fromCharCode(byte);
    }
    return { kind: 'string', value };
  }

  private parseDictOrHexString(): PdfValue {
    if (this.byteAt(this.pos + 1) === 0x3c) {
      this.pos += 2;
      const map = new Map<string, PdfValue>();
      for (;;) {
        this.skipWs();
        if (this.peek() < 0) throw new Error('unterminated pdf dictionary');
        if (this.peek() === 0x3e && this.byteAt(this.pos + 1) === 0x3e) { this.pos += 2; break; }
        const key = this.parseName().value;
        map.set(key, this.parseValue());
      }
      return { kind: 'dict', map, stream: null };
    }
    this.pos += 1;
    let hex = '';
    while (this.pos < this.bytes.length) {
      const byte = this.byteAt(this.pos);
      this.pos += 1;
      if (byte === 0x3e) break;
      if (isWs(byte)) continue;
      hex += String.fromCharCode(byte);
    }
    if (hex.length % 2 === 1) hex += '0';
    let value = '';
    for (let i = 0; i < hex.length; i += 2) {
      value += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16) & 0xff);
    }
    return { kind: 'string', value };
  }

  private parseArray(): PdfArray {
    this.pos += 1;
    const items: PdfValue[] = [];
    for (;;) {
      this.skipWs();
      if (this.peek() < 0) throw new Error('unterminated pdf array');
      if (this.peek() === 0x5d) { this.pos += 1; break; }
      items.push(this.parseValue());
    }
    return { kind: 'array', items };
  }

  private parseNumberOrRef(): PdfValue {
    const start = this.pos;
    while (this.pos < this.bytes.length) {
      const byte = this.byteAt(this.pos);
      if (byte < 0 || isWs(byte) || isDelimiter(byte)) break;
      this.pos += 1;
    }
    const raw = latin1(this.bytes.subarray(start, this.pos));
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      if (Number.isNaN(value)) throw new Error(`invalid pdf number ${raw}`);
      return { kind: 'number', value };
    }
    const afterFirst = this.pos;
    this.skipWs();
    const genStart = this.pos;
    while (this.pos < this.bytes.length) {
      const byte = this.byteAt(this.pos);
      if (byte < 0 || isWs(byte) || isDelimiter(byte)) break;
      this.pos += 1;
    }
    const genRaw = latin1(this.bytes.subarray(genStart, this.pos));
    if (/^\d+$/.test(genRaw)) {
      this.skipWs();
      if (this.matchKeyword('R')) {
        return { kind: 'ref', num: value, gen: Number(genRaw) };
      }
    }
    this.pos = afterFirst;
    return { kind: 'number', value };
  }
}

export function dictGet(dict: PdfDict | null, key: string): PdfValue | null {
  if (dict === null) return null;
  return dict.map.get(key) ?? null;
}
export function nameOf(value: PdfValue | null): string | null {
  return value !== null && value.kind === 'name' ? value.value : null;
}
export function intOf(value: PdfValue | null): number | null {
  return value !== null && value.kind === 'number' ? value.value : null;
}
export function bytesOfString(value: PdfValue | null): Uint8Array | null {
  if (value === null || value.kind !== 'string') return null;
  const out = new Uint8Array(value.value.length);
  for (let i = 0; i < value.value.length; i += 1) out[i] = value.value.charCodeAt(i) & 0xff;
  return out;
}

export function inflate(data: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(Bun.inflateSync(data));
  } catch (error) {
    throw new Error(`failed to inflate pdf stream: ${(error as Error).message}`);
  }
}

export function decodeStream(dict: PdfDict): Uint8Array {
  const data = dict.stream;
  if (data === null) throw new Error('pdf object has no stream bytes');
  const filter = dict.map.get('Filter') ?? null;
  if (filter === null || filter.kind === 'null') return data;
  const names: string[] = filter.kind === 'name' ? [filter.value]
    : filter.kind === 'array' ? filter.items.map((item) => nameOf(item) ?? '') : [];
  if (names.length === 1 && names[0] === 'FlateDecode') return inflate(data);
  throw new Error(`unsupported pdf stream filter: ${names.join(',')}`);
}


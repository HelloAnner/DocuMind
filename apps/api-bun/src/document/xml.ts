// 移植自 apps/api-rs/src/document/shared.rs（roxmltree 用法） —— 行为对齐 Rust 原版，错误信息保持一致

// 极简 XML 解析器，语义对齐 roxmltree：本地名（去命名空间前缀）、文本节点、祖先链。
// Office XML 解析前都经过 validateXmlNesting 深度校验（<=256），递归深度有界。

import { MAX_OFFICE_XML_DEPTH } from './types.ts';

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: Array<XmlElement | string>;
  parent: XmlElement | null;
}

export type XmlNodeRef =
  | { kind: 'element'; element: XmlElement }
  | { kind: 'text'; text: string };

export function parseXml(xml: string): XmlElement {
  return new XmlParser(xml).parseDocument();
}

/** 对齐 roxmltree Node::descendants：包含自身，文档序，元素与文本节点 */
export function descendants(element: XmlElement): XmlNodeRef[] {
  const out: XmlNodeRef[] = [{ kind: 'element', element }];
  for (const child of element.children) {
    if (typeof child === 'string') {
      out.push({ kind: 'text', text: child });
    } else {
      out.push(...descendants(child));
    }
  }
  return out;
}

/** 元素子节点（roxmltree children() 过滤 is_element） */
export function childElements(element: XmlElement): XmlElement[] {
  return element.children.filter((child): child is XmlElement => typeof child !== 'string');
}

export function attr(element: XmlElement, localName: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(element.attrs, localName)
    ? element.attrs[localName]
    : undefined;
}

export function attrI32(element: XmlElement, localName: string): number | undefined {
  const value = attr(element, localName);
  if (value === undefined) return undefined;
  if (!/^[+-]?\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (parsed < -2147483648 || parsed > 2147483647) return undefined;
  return parsed;
}

function localName(rawName: string): string {
  const idx = rawName.lastIndexOf(':');
  return idx >= 0 ? rawName.slice(idx + 1) : rawName;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  let out = '';
  let pos = 0;
  for (;;) {
    const amp = raw.indexOf('&', pos);
    if (amp < 0) { out += raw.slice(pos); break; }
    out += raw.slice(pos, amp);
    const semi = raw.indexOf(';', amp + 1);
    if (semi < 0) throw new XmlParseError('invalid_entity');
    const body = raw.slice(amp + 1, semi);
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const codePoint = Number.parseInt(body.slice(2), 16);
      out += decodeCodePoint(codePoint, body);
    } else if (body.startsWith('#')) {
      const codePoint = Number.parseInt(body.slice(1), 10);
      out += decodeCodePoint(codePoint, body);
    } else {
      const named = NAMED_ENTITIES[body];
      if (named === undefined) throw new XmlParseError('unknown_entity:' + body);
      out += named;
    }
    pos = semi + 1;
  }
  return out;
}

function decodeCodePoint(codePoint: number, body: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    throw new XmlParseError('invalid_character_reference:' + body);
  }
  return String.fromCodePoint(codePoint);
}

function normalizeAttrValue(raw: string): string {
  return raw.replace(/[\t\n\r]/g, ' ');
}

const XML_SPACE = new Set([' ', '\t', '\n', '\r']);

class XmlParser {
  private pos = 0;

  constructor(private readonly xml: string) {}

  parseDocument(): XmlElement {
    if (this.xml.startsWith('\uFEFF')) this.pos = 1;
    this.skipMisc();
    if (this.pos >= this.xml.length) throw new XmlParseError('xml_root_element_missing');
    const ch = this.xml[this.pos]!;
    if (ch !== '<' || this.peek(1) === '/' || this.peek(1) === '!' || this.peek(1) === '?') {
      throw new XmlParseError('xml_root_element_missing');
    }
    const root = this.parseElement(null);
    this.skipMisc();
    if (this.pos < this.xml.length) throw new XmlParseError('xml_trailing_content');
    return root;
  }

  private parseElement(parent: XmlElement | null): XmlElement {
    this.expect('<');
    const rawName = this.readName();
    const element: XmlElement = { name: localName(rawName), attrs: {}, children: [], parent };
    for (;;) {
      this.skipWhitespace();
      if (this.eof()) throw new XmlParseError('unclosed_element:' + rawName);
      const ch = this.xml[this.pos]!;
      if (ch === '>') { this.pos += 1; break; }
      if (ch === '/') {
        this.expect('/');
        this.expect('>');
        return element;
      }
      const attrRawName = this.readName();
      this.skipWhitespace();
      this.expect('=');
      this.skipWhitespace();
      const quote = this.xml[this.pos];
      if (quote !== '"' && quote !== "'") throw new XmlParseError('unquoted_attribute:' + attrRawName);
      this.pos += 1;
      const valueEnd = this.xml.indexOf(quote, this.pos);
      if (valueEnd < 0) throw new XmlParseError('unclosed_attribute:' + attrRawName);
      const attrLocal = localName(attrRawName);
      if (Object.prototype.hasOwnProperty.call(element.attrs, attrLocal)) {
        throw new XmlParseError('duplicate_attribute:' + attrLocal);
      }
      element.attrs[attrLocal] = decodeEntities(normalizeAttrValue(this.xml.slice(this.pos, valueEnd)));
      this.pos = valueEnd + 1;
    }
    for (;;) {
      if (this.eof()) throw new XmlParseError('unclosed_element:' + rawName);
      if (this.xml.startsWith('</', this.pos)) {
        this.pos += 2;
        const closeName = this.readName();
        this.skipWhitespace();
        this.expect('>');
        if (localName(closeName) !== element.name) {
          throw new XmlParseError('mismatched_close_tag:' + closeName);
        }
        return element;
      }
      if (this.xml.startsWith('<!--', this.pos)) { this.skipComment(); continue; }
      if (this.xml.startsWith('<![CDATA[', this.pos)) {
        this.pos += '<![CDATA['.length;
        const end = this.xml.indexOf(']]>', this.pos);
        if (end < 0) throw new XmlParseError('unclosed_cdata');
        element.children.push(this.xml.slice(this.pos, end));
        this.pos = end + 3;
        continue;
      }
      if (this.xml.startsWith('<?', this.pos)) { this.skipPi(); continue; }
      if (this.xml[this.pos] === '<') throw new XmlParseError('invalid_markup');
      const lt = this.xml.indexOf('<', this.pos);
      const textEnd = lt < 0 ? this.xml.length : lt;
      const text = this.xml.slice(this.pos, textEnd);
      if (text.length > 0) element.children.push(decodeEntities(text));
      this.pos = textEnd;
    }
  }

  private skipMisc(): void {
    for (;;) {
      while (this.pos < this.xml.length && XML_SPACE.has(this.xml[this.pos]!)) this.pos += 1;
      if (this.xml.startsWith('<!--', this.pos)) { this.skipComment(); continue; }
      if (this.xml.startsWith('<?', this.pos)) { this.skipPi(); continue; }
      if (this.xml.startsWith('<!', this.pos)) { this.skipDoctype(); continue; }
      return;
    }
  }

  private skipComment(): void {
    const end = this.xml.indexOf('-->', this.pos + 4);
    if (end < 0) throw new XmlParseError('unclosed_comment');
    this.pos = end + 3;
  }

  private skipPi(): void {
    const end = this.xml.indexOf('?>', this.pos + 2);
    if (end < 0) throw new XmlParseError('unclosed_pi');
    this.pos = end + 2;
  }

  private skipDoctype(): void {
    let i = this.pos + 2;
    let bracketDepth = 0;
    let quote = '';
    for (; i < this.xml.length; i += 1) {
      const ch = this.xml[i]!;
      if (quote.length > 0) { if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '[') { bracketDepth += 1; continue; }
      if (ch === ']') { bracketDepth -= 1; continue; }
      if (ch === '>' && bracketDepth <= 0) { this.pos = i + 1; return; }
    }
    throw new XmlParseError('unclosed_doctype');
  }

  private readName(): string {
    const start = this.pos;
    while (this.pos < this.xml.length) {
      const ch = this.xml[this.pos]!;
      if (XML_SPACE.has(ch) || ch === '/' || ch === '>' || ch === '=') break;
      this.pos += 1;
    }
    if (this.pos === start) throw new XmlParseError('expected_name');
    return this.xml.slice(start, this.pos);
  }

  private skipWhitespace(): void {
    while (this.pos < this.xml.length && XML_SPACE.has(this.xml[this.pos]!)) this.pos += 1;
  }

  private expect(ch: string): void {
    if (this.eof() || this.xml[this.pos] !== ch) throw new XmlParseError('expected:' + ch);
    this.pos += 1;
  }

  private peek(offset: number): string | undefined {
    return this.xml[this.pos + offset];
  }

  private eof(): boolean {
    return this.pos >= this.xml.length;
  }
}

/**
 * 对齐 Rust shared::validate_xml_nesting（quick_xml 事件流）：
 * 深度超限/嵌套非法时报 office_xml_nesting_exceeded / invalid_office_xml_nesting。
 */
export function validateXmlNesting(xml: string): void {
  let depth = 0;
  let pos = 0;
  const length = xml.length;
  while (pos < length) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) throw new Error('invalid_office_xml:unclosed_comment');
      pos = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) throw new Error('invalid_office_xml:unclosed_cdata');
      pos = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) throw new Error('invalid_office_xml:unclosed_pi');
      pos = end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      let i = lt + 2;
      let bracketDepth = 0;
      let quote = '';
      for (; i < length; i += 1) {
        const ch = xml[i]!;
        if (quote.length > 0) { if (ch === quote) quote = ''; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '[') { bracketDepth += 1; continue; }
        if (ch === ']') { bracketDepth -= 1; continue; }
        if (ch === '>' && bracketDepth <= 0) break;
      }
      if (i >= length) throw new Error('invalid_office_xml:unclosed_doctype');
      pos = i + 1;
      continue;
    }
    if (xml.startsWith('</', lt)) {
      const gt = xml.indexOf('>', lt + 2);
      if (gt < 0) throw new Error('invalid_office_xml:unclosed_end_tag');
      depth -= 1;
      if (depth < 0) throw new Error('invalid_office_xml_nesting');
      pos = gt + 1;
      continue;
    }
    let i = lt + 1;
    let quote = '';
    for (; i < length; i += 1) {
      const ch = xml[i]!;
      if (quote.length > 0) { if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '>') break;
    }
    if (i >= length) throw new Error('invalid_office_xml:unclosed_start_tag');
    let j = i - 1;
    while (j > lt && XML_SPACE.has(xml[j]!)) j -= 1;
    const selfClosing = xml[j] === '/';
    if (!selfClosing) {
      depth += 1;
      if (depth > MAX_OFFICE_XML_DEPTH) {
        throw new Error('office_xml_nesting_exceeded:' + depth + '>' + MAX_OFFICE_XML_DEPTH);
      }
    }
    pos = i + 1;
  }
  if (depth !== 0) throw new Error('invalid_office_xml_nesting');
}

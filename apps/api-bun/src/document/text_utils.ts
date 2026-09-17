// 移植自 apps/api-rs/src/document/text_utils.rs —— 行为对齐 Rust 原版，错误信息保持一致

// 文本工具：token 估算、文件名标题、sha256、zip 头识别、多编码文本解码

/** Rust char::is_whitespace 覆盖的 Unicode White_Space 集合（JS \s 额外包含 \uFEFF，需区分） */
const RUST_WS = /[\t-\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

export function isRustWhitespace(ch: string): boolean {
  return RUST_WS.test(ch);
}

/** 对齐 Rust str::split_whitespace：按空白切分，丢弃空片段 */
export function splitWhitespace(value: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of value) {
    if (RUST_WS.test(ch)) {
      if (current.length > 0) { out.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** 对齐 Rust str::trim（Unicode White_Space） */
export function trimRust(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && RUST_WS.test(value[start]!)) start += 1;
  while (end > start && RUST_WS.test(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
}

/** 对齐 Rust str::lines()：按 \n 切分，去掉末尾空行，行尾 \r 一并去除 */
export function rustLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** 对齐 Rust split_inclusive('\n')：保留换行符在片段末尾 */
export function splitInclusiveNewline(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Unicode 码点数量（对齐 Rust chars().count()） */
export function charCount(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

export function estimateTokens(content: string): number {
  let cjk = 0;
  let asciiText = 0;
  let otherText = 0;
  let punctuation = 0;
  for (const ch of content) {
    const codePoint = ch.codePointAt(0)!;
    if (isCjk(codePoint)) {
      cjk += 1;
    } else if (isAsciiAlphanumeric(codePoint)) {
      asciiText += 1;
    } else if (/\p{L}|\p{N}/u.test(ch)) {
      otherText += 1;
    } else if (!RUST_WS.test(ch)) {
      punctuation += 1;
    }
  }
  const estimate = cjk + Math.ceil(asciiText / 4) + Math.ceil(otherText / 2) + Math.ceil(punctuation / 2);
  return Math.max(estimate, 1);
}

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x20000 && codePoint <= 0x2ffff)
    || (codePoint >= 0x3040 && codePoint <= 0x30ff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
  );
}

function isAsciiAlphanumeric(codePoint: number): boolean {
  return (codePoint >= 0x30 && codePoint <= 0x39)
    || (codePoint >= 0x41 && codePoint <= 0x5a)
    || (codePoint >= 0x61 && codePoint <= 0x7a);
}

export function titleFromFileName(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  const name = idx >= 0 ? fileName.slice(0, idx) : fileName;
  return trimRust(name);
}

export function hexSha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

export function looksLikeZip(bytes: Uint8Array): boolean {
  return startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])
    || startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06])
    || startsWithBytes(bytes, [0x50, 0x4b, 0x07, 0x08]);
}

function startsWithBytes(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/** 对齐 Rust decode_text：UTF-8 BOM / UTF-16LE / UTF-16BE / UTF-8 / GBK，逐级回退，失败抛错 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3));
    } catch {
      throw new Error('invalid_utf8_text');
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    try {
      return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    } catch {
      throw new Error('invalid_utf16le_text');
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    } catch {
      throw new Error('invalid_utf16be_text');
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // 继续尝试 GBK
  }
  try {
    return new TextDecoder('gbk', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('unsupported_text_encoding');
  }
}

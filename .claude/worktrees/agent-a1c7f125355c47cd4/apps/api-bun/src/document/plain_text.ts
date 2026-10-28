// 移植自 apps/api-rs/src/document/plain_text.rs —— 行为对齐 Rust 原版，错误信息保持一致

// 纯文本解析：段落切分（含字符范围）与文本定位

import type { SourceAnchor } from '../models/source_anchor.ts';
import { sourceAnchorStructural } from '../models/source_anchor.ts';
import { newUuid } from '../infra/uuid.ts';
import { decodeText, rustLines, splitInclusiveNewline, trimRust } from './text_utils.ts';
import { finalizeParsed } from './shared.ts';
import type { ParsedBlock, ParsedDocument } from './types.ts';
import { NIL_UUID } from './types.ts';

export function parsePlainText(
  docId: string,
  parseJobId: string,
  title: string,
  bytes: Uint8Array,
): ParsedDocument {
  const text = safeDecode(bytes);
  const blocks: ParsedBlock[] = [];
  const anchors: SourceAnchor[] = [];
  for (const [paragraph, start, end] of splitParagraphsWithRanges(text)) {
    const blockId = newUuid();
    const anchor = sourceAnchorStructural(
      docId,
      parseJobId,
      NIL_UUID,
      'txt',
      'paragraph',
      blockId,
      null,
      null,
      { format: 'txt', index: blocks.length },
      paragraph,
    );
    anchor.char_range = { start, end };
    const anchorId = anchor.anchor_id;
    anchors.push(anchor);
    blocks.push({
      block_id: blockId,
      block_index: blocks.length,
      block_type: 'paragraph',
      text: paragraph,
      heading_level: null,
      heading_path: [],
      page_start: null,
      page_end: null,
      slide_index: null,
      table_id: null,
      bbox: null,
      anchor_ids: [anchorId],
      source_ref: { format: 'txt', index: blocks.length },
      metadata: { format: 'txt' },
    });
  }
  return finalizeParsed(docId, parseJobId, 'txt', title, null, blocks, [], anchors);
}

/** decode_text 的 "invalid_text_encoding" 上下文包装（对齐 Rust .context） */
function safeDecode(bytes: Uint8Array): string {
  try {
    return decodeText(bytes);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error('invalid_text_encoding:' + error.message);
    }
    throw error;
  }
}

export function splitParagraphs(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split('\n\n')) {
    const clean = rustLines(part)
      .map((line) => trimRust(line))
      .filter((line) => line.length > 0)
      .join(' ');
    if (clean.length > 0) out.push(clean);
  }
  return out;
}

/** 段落在 UTF-16 索引上切分，返回码点级字符范围（对齐 Rust i32 范围） */
function splitParagraphsWithRanges(text: string): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  let paragraphStart: number | null = null;
  let lineStart = 0;
  for (const line of splitInclusiveNewline(text)) {
    const raw = line.endsWith('\n') ? line.slice(0, -1) : line;
    const rawNoCr = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (trimRust(rawNoCr).length === 0) {
      if (paragraphStart !== null) {
        pushParagraphWithRange(text, paragraphStart, lineStart, out);
        paragraphStart = null;
      }
    } else if (paragraphStart === null) {
      paragraphStart = lineStart;
    }
    lineStart += line.length;
  }
  if (paragraphStart !== null) {
    pushParagraphWithRange(text, paragraphStart, lineStart, out);
  }
  return out;
}

function pushParagraphWithRange(
  fullText: string,
  partStart: number,
  partEnd: number,
  out: Array<[string, number, number]>,
): void {
  const part = fullText.slice(partStart, partEnd);
  const cleanLines: string[] = [];
  let firstLineStart: number | null = null;
  let lastLineEnd: number | null = null;
  let lineByteStart = partStart;
  for (const line of splitInclusiveNewline(part)) {
    const rawLine = line.endsWith('\n') ? line.slice(0, -1) : line;
    const leading = rawLine.length - trimStartLen(rawLine);
    const trimmed = trimRust(rawLine);
    if (trimmed.length > 0) {
      const start = lineByteStart + leading;
      const end = start + trimmed.length;
      if (firstLineStart === null) firstLineStart = start;
      lastLineEnd = end;
      cleanLines.push(trimmed);
    }
    lineByteStart += line.length;
  }
  if (cleanLines.length === 0) return;
  const start = firstLineStart ?? partStart;
  const end = lastLineEnd ?? start;
  out.push([
    cleanLines.join(' '),
    charIndexAt(fullText, start),
    charIndexAt(fullText, end),
  ]);
}

function trimStartLen(value: string): number {
  let count = 0;
  while (count < value.length && /\s/u.test(value[count]!)) count += 1;
  return count;
}

export interface CharCursor {
  pos: number;
}

/** 对齐 Rust find_text_char_range：从 cursor 起查找 needle（含换行折叠重试），返回码点范围并推进 cursor */
export function findTextCharRange(
  fullText: string,
  needle: string,
  cursor: CharCursor,
): [number, number] | null {
  const trimmed = trimRust(needle);
  if (trimmed.length === 0) return null;
  const haystack = fullText.slice(cursor.pos);
  let found = haystack.indexOf(trimmed);
  if (found < 0) {
    found = haystack.indexOf(trimmed.split('\n').join(' '));
  }
  if (found < 0) return null;
  const start = cursor.pos + found;
  const end = start + trimmed.length;
  cursor.pos = end;
  return [charIndexAt(fullText, start), charIndexAt(fullText, end)];
}

/** UTF-16 索引之前（含）的 Unicode 码点数量（对齐 Rust char_index_at_byte 的字符语义） */
function charIndexAt(text: string, index: number): number {
  const bounded = Math.min(index, text.length);
  let count = 0;
  for (let i = 0; i < bounded; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0xd800 || code > 0xdbff) count += 1;
  }
  return count;
}

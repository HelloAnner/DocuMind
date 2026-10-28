// 移植自 apps/api-rs/src/document/cleaning.rs —— 行为对齐 Rust 原版，错误信息保持一致

// 文本清洗：通用规范化 + 格式特定清理 + 删除判定（页眉页脚/注释/页码噪声/目录等）

import type { FileType, ParsedBlock } from './types.ts';
import { charCount, rustLines, splitWhitespace, trimRust } from './text_utils.ts';

export const CLEANER_VERSION = 'documind-cleaner@0.2.0';

export interface CleanedBlock {
  block: ParsedBlock;
  cleaned_text: string;
  is_removed: boolean;
  remove_reason: string | null;
  cleaning_ops: string[];
}

export interface CleanStats {
  input_blocks: number;
  output_blocks: number;
  removed_blocks: number;
  ops_top: string[];
}

export function cleanBlocks(
  fileType: FileType,
  blocks: ParsedBlock[],
): [CleanedBlock[], CleanStats] {
  const cleaned: CleanedBlock[] = [];
  const opCounts = new Map<string, number>();
  const pdfNoise = repeatedPdfNoise(fileType, blocks);

  for (const block of blocks) {
    const [textBase, opsBase] = commonClean(block.text);
    const text = { value: textBase };
    const ops = { value: opsBase };
    formatSpecificClean(fileType, block, text, ops);

    const [isRemoved, removeReason] = removalReason(fileType, block, text.value, pdfNoise);
    for (const op of ops.value) {
      opCounts.set(op, (opCounts.get(op) ?? 0) + 1);
    }
    cleaned.push({
      block,
      cleaned_text: text.value,
      is_removed: isRemoved,
      remove_reason: removeReason,
      cleaning_ops: ops.value,
    });
  }

  const removedBlocks = cleaned.filter((entry) => entry.is_removed).length;
  const outputBlocks = cleaned.length - removedBlocks;
  const opsTop = [...opCounts.entries()].sort(
    (a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]),
  );
  return [
    cleaned,
    {
      input_blocks: blocks.length,
      output_blocks: outputBlocks,
      removed_blocks: removedBlocks,
      ops_top: opsTop.slice(0, 8).map(([op]) => op),
    },
  ];
}

export function cleanedBlockMetadata(block: CleanedBlock): Record<string, unknown> {
  return {
    cleaner_version: CLEANER_VERSION,
    cleaning_ops: block.cleaning_ops,
    is_removed: block.is_removed,
    remove_reason: block.remove_reason,
    source_ref: block.block.source_ref,
    source_metadata: block.block.metadata,
  };
}

function commonClean(input: string): [string, string[]] {
  const ops: string[] = [];
  let text = input;

  if (text.startsWith('\uFEFF')) {
    text = text.replace(/^\uFEFF+/, '');
    ops.push('remove_bom');
  }

  if (text.includes('\r\n') || text.includes('\r')) {
    text = text.split('\r\n').join('\n').split('\r').join('\n');
    ops.push('normalize_line_endings');
  }

  const beforeSpace = text;
  text = filterSpecialChars(text);
  if (text !== beforeSpace) {
    ops.push('normalize_space');
    ops.push('remove_control_chars');
  }

  const beforeNfc = text;
  text = text.normalize('NFC');
  if (text !== beforeNfc) {
    ops.push('unicode_nfc');
  }

  const beforeCollapse = text;
  text = collapseEmptyLines(normalizeHorizontalSpace(text));
  if (text !== beforeCollapse && !ops.includes('normalize_space')) {
    ops.push('normalize_space');
  }

  const trimmed = trimRust(text);
  if (trimmed !== text) {
    ops.push('trim');
    text = trimmed;
  }

  return [text, dedupeOps(ops)];
}

/** 对齐 Rust filter_map：NBSP/全角空格 -> 空格；零宽/控制字符删除；tab -> 空格 */
function filterSpecialChars(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '\u00a0' || ch === '\u3000') {
      out += ' ';
    } else if (ch === '\u200b' || ch === '\u200c' || ch === '\u200d' || ch === '\u2060' || ch === '\ufffc') {
      // 删除
    } else if (ch === '\t') {
      out += ' ';
    } else if (ch === '\n') {
      out += '\n';
    } else if (isControlChar(ch)) {
      // 删除
    } else {
      out += ch;
    }
  }
  return out;
}

function isControlChar(ch: string): boolean {
  const codePoint = ch.codePointAt(0)!;
  return (codePoint >= 0x00 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function formatSpecificClean(
  fileType: FileType,
  block: ParsedBlock,
  text: { value: string },
  ops: { value: string[] },
): void {
  switch (fileType) {
    case 'pdf':
      cleanPdfText(block, text, ops);
      break;
    case 'docx':
      cleanWordText(block, text, ops);
      break;
    case 'pptx':
      cleanPptText(block, text, ops);
      break;
    case 'md':
      cleanMarkdownText(block, text, ops);
      break;
    case 'txt':
      break;
  }
}

function cleanPdfText(block: ParsedBlock, text: { value: string }, ops: { value: string[] }): void {
  if (block.block_type === 'paragraph') {
    const before = text.value;
    text.value = mergePdfLineBreaks(text.value);
    if (text.value !== before) {
      ops.value.push('merge_pdf_line_break');
    }
  }
  if (looksLikePageNumber(text.value)) {
    ops.value.push('remove_pdf_noise');
  }
}

function cleanWordText(block: ParsedBlock, text: { value: string }, ops: { value: string[] }): void {
  if (block.block_type === 'paragraph' && looksLikeTocEntry(text.value)) {
    ops.value.push('remove_toc_entry');
  }
  if (block.block_type === 'header_footer') {
    ops.value.push('remove_header_footer');
  }
}

function cleanPptText(block: ParsedBlock, text: { value: string }, ops: { value: string[] }): void {
  const lowered = text.value.toLowerCase();
  if (lowered.includes('click to add') || lowered.includes('单击此处')) {
    ops.value.push('remove_placeholder');
  }
  if (block.block_type === 'slide_note') {
    ops.value.push('preserve_slide_note');
  }
}

function cleanMarkdownText(block: ParsedBlock, text: { value: string }, ops: { value: string[] }): void {
  if (block.block_type === 'html' && isScriptOrStyle(text.value)) {
    ops.value.push('remove_script_style');
  }
  if (block.block_type === 'comment' || trimRust(text.value).startsWith('<!--')) {
    ops.value.push('remove_comment');
  }
  if (block.block_type === 'image') {
    const alt = markdownImageAlt(text.value);
    if (alt !== null) {
      text.value = alt;
      ops.value.push('extract_alt_text');
    }
  }
}

function removalReason(
  fileType: FileType,
  block: ParsedBlock,
  text: string,
  repeatedPdfNoise: Set<string>,
): [boolean, string | null] {
  const trimmed = trimRust(text);
  if (trimmed.length === 0) {
    return [true, 'empty_block'];
  }
  if (block.block_type === 'header_footer') {
    return [true, 'header_footer'];
  }
  if (block.block_type === 'comment') {
    return [true, 'comment'];
  }
  if (block.block_type === 'html' && isScriptOrStyle(trimmed)) {
    return [true, 'script_style'];
  }
  if (fileType === 'pdf'
    && (looksLikePageNumber(trimmed) || repeatedPdfNoise.has(noiseKey(trimmed)))) {
    return [true, 'page_noise'];
  }
  if (fileType === 'docx'
    && block.block_type === 'paragraph'
    && looksLikeTocEntry(trimmed)) {
    return [true, 'toc_entry'];
  }
  return [false, null];
}

function normalizeHorizontalSpace(text: string): string {
  return rustLines(text).map((line) => splitWhitespace(line).join(' ')).join('\n');
}

function collapseEmptyLines(text: string): string {
  let out = '';
  let emptyCount = 0;
  for (const line of rustLines(text)) {
    if (trimRust(line).length === 0) {
      emptyCount += 1;
      if (emptyCount <= 2) {
        out += '\n';
      }
    } else {
      emptyCount = 0;
      if (out.length > 0 && !out.endsWith('\n')) {
        out += '\n';
      }
      out += line;
    }
  }
  return out;
}

function mergePdfLineBreaks(text: string): string {
  let out = '';
  for (const line of text.split('\n').map((raw) => trimRust(raw))) {
    if (line.length === 0) continue;
    if (out.endsWith('-')) {
      out = out.slice(0, -1) + line;
    } else {
      if (out.length > 0) {
        out += ' ';
      }
      out += line;
    }
  }
  return out;
}

function looksLikePageNumber(text: string): boolean {
  const trimmed = trimRust(text);
  if (charCount(trimmed) > 24 || trimmed.length === 0) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  const englishPage = lower.startsWith('page ')
    && [...trimRust(lower.slice('page '.length))].every((ch) => ch >= '0' && ch <= '9');
  const chinesePage = (() => {
    if (!trimmed.startsWith('第')) return false;
    const tail = trimmed.slice(1);
    if (!tail.endsWith('页')) return false;
    const number = tail.slice(0, -1);
    if (number.length === 0) return false;
    return [...number].every((ch) => (ch >= '0' && ch <= '9') || '一二三四五六七八九十百千'.includes(ch));
  })();
  return englishPage || chinesePage;
}

function looksLikeTocEntry(text: string): boolean {
  const trimmed = trimRust(text);
  return (trimmed.includes('.....') || trimmed.includes('……')) && charCount(trimmed) < 200;
}

function repeatedPdfNoise(fileType: FileType, blocks: ParsedBlock[]): Set<string> {
  if (fileType !== 'pdf') return new Set();
  const pagesByText = new Map<string, Set<number>>();
  for (const block of blocks) {
    if (block.page_start === null) continue;
    const text = trimRust(block.text);
    if (text.length === 0 || charCount(text) > 120) continue;
    const key = noiseKey(text);
    const pages = pagesByText.get(key);
    if (pages) {
      pages.add(block.page_start);
    } else {
      pagesByText.set(key, new Set([block.page_start]));
    }
  }
  const out = new Set<string>();
  for (const [text, pages] of pagesByText) {
    if (pages.size >= 3) out.add(text);
  }
  return out;
}

function noiseKey(text: string): string {
  return splitWhitespace(text).join(' ').toLowerCase();
}

function isScriptOrStyle(text: string): boolean {
  const lower = trimRust(text).toLowerCase();
  return lower.startsWith('<script') || lower.startsWith('<style');
}

function markdownImageAlt(text: string): string | null {
  const start = text.indexOf('![');
  if (start < 0) return null;
  const end = text.indexOf(']', start + 2);
  if (end < 0) return null;
  const alt = trimRust(text.slice(start + 2, end));
  return alt.length > 0 ? alt : null;
}

function dedupeOps(ops: string[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if (!out.includes(op)) out.push(op);
  }
  return out;
}

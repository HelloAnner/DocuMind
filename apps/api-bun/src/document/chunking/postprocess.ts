// 移植自 apps/api-rs/src/document/chunking/postprocess.rs —— 行为对齐 Rust 原版

// 切片后处理：表格按行拆分（重复表头）、过小相邻切片合并、按 token 上限硬切

import type { ChunkConfig } from '../chunking.ts';
import { estimateTokens, isRustWhitespace, rustLines } from '../text_utils.ts';
import type { ChunkDraft } from '../types.ts';

export function splitTableText(text: string, cfg: ChunkConfig): string[] {
  const lines = rustLines(text);
  const maxRows = Math.max(cfg.max_table_rows_per_chunk, 1);
  const maxTokens = Math.max(Math.min(cfg.max_table_token_per_chunk, cfg.max_chunk_tokens), 1);
  if (lines.length <= maxRows + 2 && estimateTokens(text) <= maxTokens) {
    return [text];
  }

  const second = lines[1];
  const headerLen = second !== undefined
    && second.includes('---')
    && /^[|\-: ]*$/.test(second)
    ? 2
    : Math.min(1, lines.length);
  const header = lines.slice(0, headerLen).join('\n');
  const parts: string[] = [];
  let rows: string[] = [];
  for (const line of lines.slice(headerLen)) {
    const candidateRows = [...rows, line];
    const candidate = header + '\n' + candidateRows.join('\n');
    if (rows.length > 0 && (candidateRows.length > maxRows || estimateTokens(candidate) > maxTokens)) {
      parts.push(header + '\n' + rows.join('\n'));
      rows = [];
    }
    const singleRowCandidate = header + '\n' + line;
    if (rows.length === 0 && estimateTokens(singleRowCandidate) > maxTokens) {
      const rowBudget = Math.max(maxTokens - estimateTokens(header) - 1, 1);
      for (const fragment of splitByTokenLimit(line, rowBudget)) {
        parts.push(header + '\n' + fragment);
      }
      continue;
    }
    rows.push(line);
  }
  if (rows.length > 0) {
    parts.push(header + '\n' + rows.join('\n'));
  }
  return parts.length === 0 ? splitByTokenLimit(text, maxTokens) : parts;
}

export function mergeSmallAdjacentChunks(chunks: ChunkDraft[], cfg: ChunkConfig): void {
  if (chunks.length < 2 || cfg.min_chunk_tokens <= 0) return;
  const merged: ChunkDraft[] = [];
  for (const chunk of chunks) {
    const previous = merged[merged.length - 1];
    const canMerge = previous !== undefined
      && chunk.token_count < cfg.min_chunk_tokens
      && previous.token_count + chunk.token_count <= cfg.max_chunk_tokens
      && compatible(previous, chunk);
    if (canMerge && previous !== undefined) {
      mergeChunk(previous, chunk);
    } else {
      merged.push(chunk);
    }
  }
  chunks.length = 0;
  chunks.push(...merged);
}

function compatible(left: ChunkDraft, right: ChunkDraft): boolean {
  if (left.source_type === 'table' || right.source_type === 'table') return false;
  if (left.slide_end !== null && right.slide_start !== null && left.slide_end !== right.slide_start) {
    return false;
  }
  const leftH1 = left.heading_path[0];
  const rightH1 = right.heading_path[0];
  return leftH1 === undefined || rightH1 === undefined || leftH1 === rightH1;
}

function mergeChunk(left: ChunkDraft, right: ChunkDraft): void {
  left.content = left.content.trim() + '\n\n' + right.content.trim();
  left.token_count = estimateTokens(left.content);
  left.page_start = minOption(left.page_start, right.page_start);
  left.page_end = maxOption(left.page_end, right.page_end);
  left.slide_start = minOption(left.slide_start, right.slide_start);
  left.slide_end = maxOption(left.slide_end, right.slide_end);
  extendUnique(left.block_ids, right.block_ids);
  extendUnique(left.table_ids, right.table_ids);
  extendUnique(left.anchor_ids, right.anchor_ids);
  if (isRecord(left.metadata)) {
    left.metadata['split_reason'] = 'min_chunk_merge';
  }
}

export function splitByTokenLimit(text: string, maxTokens: number): string[] {
  const limit = Math.max(maxTokens, 1);
  const parts: string[] = [];
  let current = '';
  const counters = newTokenCounters();
  for (const ch of text) {
    countChar(counters, ch, 1);
    if (current.length > 0 && countersTokens(counters) > limit) {
      parts.push(current);
      current = '';
      counters.cjk = 0; counters.ascii = 0; counters.other = 0; counters.punctuation = 0;
    }
    current += ch;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function minOption(left: number | null, right: number | null): number | null {
  if (left !== null && right !== null) return Math.min(left, right);
  return left ?? right;
}

function maxOption(left: number | null, right: number | null): number | null {
  if (left !== null && right !== null) return Math.max(left, right);
  return left ?? right;
}

function extendUnique(target: string[], values: string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------- token 计数器（与 text_utils.estimateTokens 等价，但可增量更新） ----------------

export interface TokenCounters { cjk: number; ascii: number; other: number; punctuation: number; }

export function newTokenCounters(): TokenCounters {
  return { cjk: 0, ascii: 0, other: 0, punctuation: 0 };
}

export function countChar(counters: TokenCounters, ch: string, delta: 1 | -1): void {
  const codePoint = ch.codePointAt(0);
  if (codePoint === undefined) return;
  if (isCjk(codePoint)) {
    counters.cjk += delta;
  } else if (
    (codePoint >= 0x30 && codePoint <= 0x39)
    || (codePoint >= 0x41 && codePoint <= 0x5a)
    || (codePoint >= 0x61 && codePoint <= 0x7a)
  ) {
    counters.ascii += delta;
  } else if (/\p{L}|\p{N}/u.test(ch)) {
    counters.other += delta;
  } else if (!isRustWhitespace(ch)) {
    counters.punctuation += delta;
  }
}

export function countersTokens(counters: TokenCounters): number {
  const estimate = counters.cjk
    + Math.ceil(counters.ascii / 4)
    + Math.ceil(counters.other / 2)
    + Math.ceil(counters.punctuation / 2);
  return Math.max(estimate, 1);
}

/** 对齐 text_utils.isCjk（CJK 统一表意文字 / 假名 / 谚文） */
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

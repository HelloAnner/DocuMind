// 移植自 apps/api-rs/src/document/chunking.rs —— 行为对齐 Rust 原版

// 切片：清洗块 -> 分组 -> 表格/长文本切分 -> 合并过小片 -> 相邻重叠 -> 重排 chunk_index

import { loadConfig } from '../config.ts';
import { newUuid } from '../infra/uuid.ts';
import type { CleanedBlock } from './cleaning.ts';
import { addOverlap } from './chunking/overlap.ts';
import { mergeSmallAdjacentChunks, splitByTokenLimit } from './chunking/postprocess.ts';
import { splitTableGroup } from './chunking/table.ts';
import { estimateTokens, trimRust } from './text_utils.ts';
import type { ChunkDraft, FileType } from './types.ts';

export const CHUNKER_VERSION = 'documind-chunker@0.3.0';

/** 与 Rust 一致的 serde 字段名（snake_case） */
export interface ChunkConfig {
  target_chunk_tokens: number;
  max_chunk_tokens: number;
  hard_split_tokens: number;
  min_chunk_tokens: number;
  overlap_tokens: number;
  max_table_rows_per_chunk: number;
  max_table_token_per_chunk: number;
}

/** 对齐 Rust ChunkConfig::default()：RAG_* 环境变量经 config.ts 统一读取 */
export function defaultChunkConfig(): ChunkConfig {
  const chunking = loadConfig().rag.chunking;
  return {
    target_chunk_tokens: chunking.targetChunkTokens,
    max_chunk_tokens: chunking.maxChunkTokens,
    hard_split_tokens: chunking.hardSplitTokens,
    min_chunk_tokens: chunking.minChunkTokens,
    overlap_tokens: chunking.overlapTokens,
    max_table_rows_per_chunk: chunking.maxTableRowsPerChunk,
    max_table_token_per_chunk: chunking.maxTableTokenPerChunk,
  };
}

function anchorQualityFor(fileType: FileType, hasBbox: boolean): string {
  if (hasBbox) return 'bbox';
  return fileType === 'pdf' ? 'page' : 'structural';
}

export class BlockGroup {
  blocks: CleanedBlock[] = [];
  tokens = 0;
  source_type = 'paragraph';

  isEmpty(): boolean {
    return this.blocks.length === 0;
  }

  push(block: CleanedBlock, tokens: number): void {
    if (this.blocks.length === 0) {
      this.source_type = sourceTypeFor(block);
    }
    this.tokens += tokens;
    this.blocks.push(block);
  }
}

export function chunkBlocks(
  fileType: FileType,
  kbId: string,
  parseJobId: string,
  cleanedBlocks: CleanedBlock[],
  cfg: ChunkConfig,
): ChunkDraft[] {
  const usable = cleanedBlocks.filter((block) => !block.is_removed && trimRust(block.cleaned_text).length > 0);

  const groups: BlockGroup[] = [];
  let current = new BlockGroup();

  for (const block of usable) {
    if (isHardBoundary(fileType, block, current)) {
      if (!current.isEmpty()) {
        groups.push(current);
        current = new BlockGroup();
      }
      if (block.block.block_type === 'table') {
        groups.push(singleBlockGroup(block));
        continue;
      }
    }

    const tokens = estimateTokens(block.cleaned_text);
    if (!current.isEmpty() && current.tokens + tokens > cfg.target_chunk_tokens) {
      groups.push(current);
      current = new BlockGroup();
    }
    current.push(block, tokens);
  }
  if (!current.isEmpty()) {
    groups.push(current);
  }
  mergeSmallGroups(fileType, groups, cfg);

  const chunks: ChunkDraft[] = [];
  for (const group of groups) {
    splitGroup(fileType, kbId, parseJobId, group, cfg, chunks);
  }

  mergeSmallAdjacentChunks(chunks, cfg);
  addOverlap(chunks, cfg);
  chunks.forEach((chunk, idx) => {
    chunk.chunk_index = idx;
  });
  return chunks;
}

function mergeSmallGroups(fileType: FileType, groups: BlockGroup[], cfg: ChunkConfig): void {
  if (cfg.min_chunk_tokens <= 0 || groups.length < 2) return;
  const merged: BlockGroup[] = [];
  for (const group of groups) {
    const previous = merged[merged.length - 1];
    const first = group.blocks[0];
    const canMerge = previous !== undefined
      && group.tokens < cfg.min_chunk_tokens
      && previous.tokens + group.tokens <= cfg.max_chunk_tokens
      && previous.source_type !== 'table'
      && group.source_type !== 'table'
      && first !== undefined
      && !isHardBoundary(fileType, first, previous);
    if (canMerge && previous !== undefined) {
      previous.tokens += group.tokens;
      previous.blocks.push(...group.blocks);
    } else {
      merged.push(group);
    }
  }
  groups.length = 0;
  groups.push(...merged);
}

export function singleBlockGroup(block: CleanedBlock): BlockGroup {
  const tokens = estimateTokens(block.cleaned_text);
  const group = new BlockGroup();
  group.push(block, tokens);
  return group;
}

function isHardBoundary(fileType: FileType, block: CleanedBlock, current: BlockGroup): boolean {
  if (current.isEmpty()) return false;
  if (fileType === 'pdf') {
    const currentPage = current.blocks[current.blocks.length - 1]?.block.page_start ?? null;
    const nextPage = block.block.page_start;
    if (currentPage !== null && nextPage !== null && currentPage !== nextPage) return true;
  }
  if (block.block.block_type === 'table' || block.block.block_type === 'code') return true;
  // PDF 解析器只有启发式标题、没有可靠标题路径：若把每条短行都当 H1 会把长 PDF 切碎
  if (fileType !== 'pdf' && block.block.heading_level === 1) return true;
  const currentSlide = current.blocks[current.blocks.length - 1]?.block.slide_index ?? null;
  return currentSlide !== null
    && block.block.slide_index !== null
    && currentSlide !== block.block.slide_index;
}

function splitGroup(
  fileType: FileType,
  kbId: string,
  parseJobId: string,
  group: BlockGroup,
  cfg: ChunkConfig,
  chunks: ChunkDraft[],
): void {
  if (
    group.blocks.length === 1
    && group.blocks[0]!.block.block_type === 'table'
    && splitTableGroup(fileType, kbId, parseJobId, group, cfg, chunks)
  ) {
    return;
  }
  const contentLimit = group.source_type === 'table'
    ? Math.max(cfg.max_chunk_tokens, 1)
    : Math.max(cfg.max_chunk_tokens - (Math.max(cfg.overlap_tokens, 0) + 20), 100);
  if (group.tokens <= contentLimit) {
    chunks.push(chunkFromGroup(fileType, kbId, parseJobId, group, 'group'));
    return;
  }

  if (group.blocks.length > 1) {
    let current = new BlockGroup();
    for (const block of group.blocks) {
      const tokens = estimateTokens(block.cleaned_text);
      if (!current.isEmpty() && current.tokens + tokens > contentLimit) {
        chunks.push(chunkFromGroup(fileType, kbId, parseJobId, current, 'block_boundary'));
        current = new BlockGroup();
      }
      current.push(block, tokens);
    }
    if (!current.isEmpty()) {
      chunks.push(chunkFromGroup(fileType, kbId, parseJobId, current, 'block_boundary'));
    }
    return;
  }

  const block = group.blocks[0];
  if (block === undefined) return;

  for (const part of splitLongText(block.cleaned_text, cfg, contentLimit)) {
    const partBlock: CleanedBlock = { ...block, cleaned_text: part };
    chunks.push(chunkFromGroup(fileType, kbId, parseJobId, singleBlockGroup(partBlock), 'text_split'));
  }
}

export function chunkFromGroup(
  fileType: FileType,
  _kbId: string,
  _parseJobId: string,
  group: BlockGroup,
  splitReason: string,
): ChunkDraft {
  const headingBlock = group.blocks.find((block) => block.block.heading_path.length > 0);
  const headingPath = headingBlock ? [...headingBlock.block.heading_path] : [];
  const pageStart = minOf(group.blocks.map((block) => block.block.page_start));
  const pageEnd = maxOf(group.blocks.map((block) => block.block.page_end));
  const slideStart = minOf(group.blocks.map((block) => block.block.slide_index));
  const slideEnd = maxOf(group.blocks.map((block) => block.block.slide_index));
  const blockIds = group.blocks.map((block) => block.block.block_id);
  const tableIds = group.blocks
    .map((block) => block.block.table_id)
    .filter((tableId): tableId is string => tableId !== null);
  // Rust 用 HashSet 去重（顺序不确定）；TS 取首次出现顺序，结果稳定
  const anchorIds: string[] = [];
  for (const block of group.blocks) {
    for (const anchorId of block.block.anchor_ids) {
      if (!anchorIds.includes(anchorId)) anchorIds.push(anchorId);
    }
  }
  const primaryAnchorId = group.blocks.find((block) => block.block.anchor_ids.length > 0)?.block.anchor_ids[0] ?? null;
  const hasBbox = group.blocks.some((block) => block.block.bbox !== null);
  const anchorQuality = anchorQualityFor(fileType, hasBbox);

  const contentParts: string[] = [];
  if (headingPath.length > 0) {
    contentParts.push(`标题路径：${headingPath.join(' / ')}`);
  }
  if (pageStart !== null) {
    contentParts.push(`页码：${pageStart}`);
  }
  if (slideStart !== null) {
    contentParts.push(`Slide：${slideStart}`);
  }
  contentParts.push('');
  contentParts.push(group.blocks.map((block) => block.cleaned_text).join('\n'));
  const content = trimRust(contentParts.join('\n'));

  return {
    chunk_id: newUuid(),
    chunk_index: 0,
    source_type: group.source_type,
    content,
    heading_path: headingPath,
    page_start: pageStart,
    page_end: pageEnd,
    slide_start: slideStart,
    slide_end: slideEnd,
    token_count: estimateTokens(content),
    block_ids: blockIds,
    table_ids: tableIds,
    anchor_ids: anchorIds,
    primary_anchor_id: primaryAnchorId,
    anchor_quality: anchorQuality,
    metadata: {
      format: fileType,
      chunker_version: CHUNKER_VERSION,
      split_reason: splitReason,
      overlap_tokens: 0,
      overlap_prev_block_ids: [],
      overlap_next_block_ids: [],
    },
  };
}

function sourceTypeFor(block: CleanedBlock): string {
  switch (block.block.block_type) {
    case 'table': return 'table';
    case 'slide_note': return 'slide_note';
    case 'footnote': return 'footnote';
    case 'code': return 'code';
    case 'heading': return 'paragraph';
    default: return block.block.block_type;
  }
}

function splitLongText(text: string, cfg: ChunkConfig, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) {
    return [text];
  }

  const sentenceParts = splitBySentence(text);
  const out: string[] = [];
  let current = '';
  for (const part of sentenceParts) {
    const next = current.length === 0 ? part : current + part;
    if (estimateTokens(next) > maxTokens && current.length > 0) {
      out.push(...forceSplit(current, Math.min(maxTokens, cfg.hard_split_tokens)));
      current = part;
    } else {
      current = next;
    }
  }
  if (current.length > 0) {
    out.push(...forceSplit(current, Math.min(maxTokens, cfg.hard_split_tokens)));
  }
  return out;
}

function splitBySentence(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of text) {
    current += ch;
    if (ch === '。' || ch === '！' || ch === '？' || ch === ';' || ch === '；' || ch === '!' || ch === '?') {
      out.push(current);
      current = '';
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function forceSplit(text: string, hardSplitTokens: number): string[] {
  if (estimateTokens(text) <= hardSplitTokens) {
    return [text];
  }
  return splitByTokenLimit(text, hardSplitTokens);
}

function minOf(values: Array<number | null>): number | null {
  let result: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    result = result === null ? value : Math.min(result, value);
  }
  return result;
}

function maxOf(values: Array<number | null>): number | null {
  let result: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    result = result === null ? value : Math.max(result, value);
  }
  return result;
}

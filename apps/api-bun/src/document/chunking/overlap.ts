// 移植自 apps/api-rs/src/document/chunking/overlap.rs —— 行为对齐 Rust 原版

// 相邻切片重叠：把上一片尾部 / 下一片头部（预算内）作为【上文】/【下文】追加

import type { ChunkConfig } from '../chunking.ts';
import { estimateTokens, trimRust } from '../text_utils.ts';
import type { ChunkDraft } from '../types.ts';
import { countChar, countersTokens, newTokenCounters } from './postprocess.ts';

export function addOverlap(chunks: ChunkDraft[], cfg: ChunkConfig): void {
  if (chunks.length < 2 || cfg.overlap_tokens <= 0) return;
  const half = Math.max(Math.trunc(cfg.overlap_tokens / 2), 1);
  const originals = chunks.map((chunk) => chunk.content);
  const ids = chunks.map((chunk) => chunk.block_ids);

  for (let idx = 0; idx < chunks.length; idx += 1) {
    const chunk = chunks[idx]!;
    let prevIds: string[] = [];
    let nextIds: string[] = [];
    let content = chunk.content;
    const available = Math.max(cfg.max_chunk_tokens - estimateTokens(content), 0);
    const sideBudget = Math.min(half, Math.trunc(Math.max(available - 16, 0) / 2));
    const previous = idx > 0 ? chunks[idx - 1]! : undefined;
    const next = idx + 1 < chunks.length ? chunks[idx + 1]! : undefined;
    if (previous !== undefined && canOverlap(previous, chunk)) {
      const prev = tailText(originals[idx - 1]!, sideBudget);
      if (trimRust(prev).length > 0) {
        const candidate = `【上文】${trimRust(prev)}\n\n${content}`;
        if (estimateTokens(candidate) <= cfg.max_chunk_tokens) {
          content = candidate;
          prevIds = ids[idx - 1]!;
        }
      }
    }
    if (next !== undefined && canOverlap(chunk, next)) {
      const nextText = headText(originals[idx + 1]!, sideBudget);
      if (trimRust(nextText).length > 0) {
        const candidate = `${content}\n\n【下文】${trimRust(nextText)}`;
        if (estimateTokens(candidate) <= cfg.max_chunk_tokens) {
          content = candidate;
          nextIds = ids[idx + 1]!;
        }
      }
    }

    chunk.content = content;
    chunk.token_count = estimateTokens(chunk.content);
    if (isRecord(chunk.metadata)) {
      chunk.metadata['overlap_tokens'] = cfg.overlap_tokens;
      chunk.metadata['overlap_prev_block_ids'] = prevIds;
      chunk.metadata['overlap_next_block_ids'] = nextIds;
    }
  }
}

function canOverlap(left: ChunkDraft, right: ChunkDraft): boolean {
  if (left.source_type === 'table' || right.source_type === 'table') return false;
  if (
    left.metadata['format'] === 'pdf'
    && left.page_end !== null
    && right.page_start !== null
    && left.page_end !== right.page_start
  ) return false;
  if (left.slide_end !== null && right.slide_start !== null && left.slide_end !== right.slide_start) {
    return false;
  }
  const leftH1 = left.heading_path[0];
  const rightH1 = right.heading_path[0];
  return leftH1 === undefined || rightH1 === undefined || leftH1 === rightH1;
}

/** 对齐 Rust tail_text：从尾部逐字符取，加入下一个字符会超预算则停止 */
function tailText(text: string, tokens: number): string {
  if (tokens <= 0) return '';
  const chars = [...text];
  const counters = newTokenCounters();
  let start = chars.length;
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const ch = chars[i]!;
    countChar(counters, ch, 1);
    if (countersTokens(counters) > tokens) {
      countChar(counters, ch, -1);
      break;
    }
    start = i;
  }
  return chars.slice(start).join('');
}

/** 对齐 Rust head_text：从头部逐字符取，加入下一个字符会超预算则停止 */
function headText(text: string, tokens: number): string {
  if (tokens <= 0) return '';
  const counters = newTokenCounters();
  let out = '';
  for (const ch of text) {
    countChar(counters, ch, 1);
    if (countersTokens(counters) > tokens) {
      countChar(counters, ch, -1);
      break;
    }
    out += ch;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

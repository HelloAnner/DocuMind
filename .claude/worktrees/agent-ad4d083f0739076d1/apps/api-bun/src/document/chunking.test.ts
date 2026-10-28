// 移植自 apps/api-rs/src/document/chunking/postprocess.rs #[cfg(test)]
import { describe, expect, test } from 'bun:test';

import { chunkBlocks, type ChunkConfig } from './chunking.ts';
import { splitTableText } from './chunking/postprocess.ts';
import type { CleanedBlock } from './cleaning.ts';
import { estimateTokens } from './text_utils.ts';
import { NIL_UUID, type ParsedBlock } from './types.ts';

function config(maxTokens: number, overlapTokens: number): ChunkConfig {
  return {
    target_chunk_tokens: Math.trunc(maxTokens / 2),
    max_chunk_tokens: maxTokens,
    hard_split_tokens: maxTokens,
    min_chunk_tokens: 0,
    overlap_tokens: overlapTokens,
    max_table_rows_per_chunk: 2,
    max_table_token_per_chunk: maxTokens,
  };
}

function cleanedBlock(blockType: string, headingLevel: number | null, text: string): CleanedBlock {
  const block: ParsedBlock = {
    block_id: crypto.randomUUID(),
    block_index: 0,
    block_type: blockType,
    text,
    heading_level: headingLevel,
    heading_path: [],
    page_start: 1,
    page_end: 1,
    slide_index: null,
    table_id: null,
    bbox: null,
    anchor_ids: [],
    source_ref: {},
    metadata: {},
  };
  return {
    block,
    cleaned_text: text,
    is_removed: false,
    remove_reason: null,
    cleaning_ops: [],
  };
}

describe('chunking', () => {
  test('table parts repeat headers and respect limits', () => {
    const cfg = config(40, 0);
    const table = '| 区域 | 金额 |\n|---|---|\n| 华东 | 100 |\n| 华南 | 200 |\n| 华北 | 300 |\n| 西南 | 400 |';

    const parts = splitTableText(table, cfg);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.startsWith('| 区域 | 金额 |\n|---|---|')).toBe(true);
      expect(estimateTokens(part)).toBeLessThanOrEqual(cfg.max_table_token_per_chunk);
    }
  });

  test('oversized table row is split within the token limit', () => {
    const cfg = config(40, 0);
    const table = `| 字段 | 内容 |\n|---|---|\n| 说明 | ${'超长内容'.repeat(80)} |`;

    const parts = splitTableText(table, cfg);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(estimateTokens(part)).toBeLessThanOrEqual(cfg.max_table_token_per_chunk);
    }
  });

  test('pdf heuristic headings do not create tiny chunks', () => {
    const cfg = config(200, 0);
    const blocks = Array.from({ length: 8 }, (_, index) =>
      cleanedBlock('heading', 1, `第 ${index} 节简短标题`));

    const chunks = chunkBlocks('pdf', NIL_UUID, crypto.randomUUID(), blocks, cfg);

    expect(chunks.length).toBe(1);
  });

  test('pdf chunks and overlap never cross page boundaries', () => {
    const cfg = config(200, 40);
    cfg.min_chunk_tokens = 50;
    const first = cleanedBlock('paragraph', null, '第一页证据');
    const second = cleanedBlock('paragraph', null, '第二页证据');
    second.block.page_start = 2;
    second.block.page_end = 2;

    const chunks = chunkBlocks('pdf', NIL_UUID, crypto.randomUUID(), [first, second], cfg);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => [chunk.page_start, chunk.page_end])).toEqual([[1, 1], [2, 2]]);
    expect(chunks.every((chunk) => !chunk.content.includes('【上文】')
      && !chunk.content.includes('【下文】'))).toBe(true);
  });

  test('overlap keeps final chunks below the configured maximum', () => {
    const cfg = config(200, 40);
    const blocks = [cleanedBlock('paragraph', null, '正文内容'.repeat(180))];

    const chunks = chunkBlocks('txt', NIL_UUID, crypto.randomUUID(), blocks, cfg);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.token_count).toBeLessThanOrEqual(cfg.max_chunk_tokens);
    }
  });

  test('assigns sequential chunk_index and structural metadata', () => {
    const cfg = config(200, 40);
    const blocks = [cleanedBlock('paragraph', null, '付款条款。'.repeat(80))];

    const chunks = chunkBlocks('txt', NIL_UUID, crypto.randomUUID(), blocks, cfg);

    chunks.forEach((chunk, index) => {
      expect(chunk.chunk_index).toBe(index);
      expect(chunk.metadata['chunker_version']).toBe('documind-chunker@0.3.0');
      expect(chunk.metadata['format']).toBe('txt');
    });
  });
});

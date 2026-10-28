// 移植自 apps/api-rs/src/document/chunking/table.rs —— 行为对齐 Rust 原版

// 单块表格切分：按行拆成多片，每片重复表头，并写入 table_part_index

import type { ChunkConfig } from '../chunking.ts';
import { chunkFromGroup, singleBlockGroup, type BlockGroup } from '../chunking.ts';
import type { ChunkDraft, FileType } from '../types.ts';
import { splitTableText } from './postprocess.ts';

export function splitTableGroup(
  fileType: FileType,
  kbId: string,
  parseJobId: string,
  group: BlockGroup,
  cfg: ChunkConfig,
  chunks: ChunkDraft[],
): boolean {
  const block = group.blocks[0];
  if (block === undefined) return false;
  const parts = splitTableText(block.cleaned_text, cfg);
  if (parts.length <= 1) return false;
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = { ...block, cleaned_text: parts[partIndex]! };
    const chunk = chunkFromGroup(fileType, kbId, parseJobId, singleBlockGroup(part), 'table_rows');
    if (isRecord(chunk.metadata)) {
      chunk.metadata['table_part_index'] = partIndex;
    }
    chunks.push(chunk);
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

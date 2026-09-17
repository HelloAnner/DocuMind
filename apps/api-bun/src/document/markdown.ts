// 移植自 apps/api-rs/src/document/markdown.rs —— 行为对齐 Rust 原版，错误信息保持一致

// Markdown 解析：frontmatter / 代码围栏 / 标题 / 列表 / 引用 / 图片 / 表格 / 段落

import type { SourceAnchor } from '../models/source_anchor.ts';
import { sourceAnchorStructural } from '../models/source_anchor.ts';
import { newUuid } from '../infra/uuid.ts';
import { findTextCharRange, type CharCursor } from './plain_text.ts';
import {
  attachTableCellAnchors,
  finalizeParsed,
  normalizeSpace,
  tableMarkdown,
} from './shared.ts';
import { decodeText, rustLines, trimRust } from './text_utils.ts';
import type { ParsedBlock, ParsedDocument, ParsedTable, ParsedTableCell } from './types.ts';
import { NIL_UUID } from './types.ts';

export function parseMarkdown(
  docId: string,
  parseJobId: string,
  title: string,
  bytes: Uint8Array,
): ParsedDocument {
  let text: string;
  try {
    text = decodeText(bytes);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error('invalid_markdown_encoding:' + error.message);
    }
    throw error;
  }
  const blocks: ParsedBlock[] = [];
  const tables: ParsedTable[] = [];
  const headingPath: Array<[number, string]> = [];
  let inFrontmatter = false;
  let frontmatter: string[] = [];
  let inCode = false;
  const codeFence: string[] = [];
  const paragraph: string[] = [];
  const tableLines: string[] = [];
  const warnings: string[] = [];

  for (const [lineIdx, line] of rustLines(text).entries()) {
    const trimmed = trimRust(line);
    if (lineIdx === 0 && trimmed === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === '---') {
        inFrontmatter = false;
        if (frontmatter.length > 0) {
          pushMarkdownBlock(
            blocks,
            'metadata',
            frontmatter.join('\n'),
            null,
            headingPath,
            { format: 'md', source: 'frontmatter' },
          );
          frontmatter = [];
        }
      } else {
        frontmatter.push(line);
      }
      continue;
    }

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (inCode) {
        codeFence.push(line);
        pushMarkdownBlock(
          blocks,
          'code',
          codeFence.join('\n'),
          null,
          headingPath,
          { format: 'md', source: 'code_fence' },
        );
        codeFence.length = 0;
        inCode = false;
      } else {
        flushMarkdownParagraph(blocks, paragraph, headingPath);
        flushMarkdownTable(blocks, tables, tableLines, headingPath);
        inCode = true;
        codeFence.push(line);
      }
      continue;
    }
    if (inCode) {
      codeFence.push(line);
      continue;
    }

    const heading = markdownHeading(trimmed);
    if (heading !== null) {
      flushMarkdownParagraph(blocks, paragraph, headingPath);
      flushMarkdownTable(blocks, tables, tableLines, headingPath);
      const [level, headingText] = heading;
      for (let i = headingPath.length - 1; i >= 0; i -= 1) {
        if (headingPath[i]![0] >= level) headingPath.splice(i, 1);
      }
      headingPath.push([level, headingText]);
      pushMarkdownBlock(
        blocks,
        'heading',
        headingText,
        level,
        headingPath.slice(0, Math.max(headingPath.length - 1, 0)),
        { format: 'md', line: lineIdx + 1 },
      );
      continue;
    }

    if (trimmed.startsWith('<!--')) {
      flushMarkdownParagraph(blocks, paragraph, headingPath);
      pushMarkdownBlock(
        blocks,
        'comment',
        trimmed,
        null,
        headingPath,
        { format: 'md', line: lineIdx + 1 },
      );
      continue;
    }

    if (markdownTableLine(trimmed)) {
      flushMarkdownParagraph(blocks, paragraph, headingPath);
      tableLines.push(trimmed);
      continue;
    } else {
      flushMarkdownTable(blocks, tables, tableLines, headingPath);
    }

    if (trimmed.length === 0) {
      flushMarkdownParagraph(blocks, paragraph, headingPath);
    } else if (markdownListItem(trimmed)) {
      flushMarkdownParagraph(blocks, paragraph, headingPath);
      pushMarkdownBlock(
        blocks,
        'list_item',
        trimmed,
        null,
        headingPath,
        { format: 'md', line: lineIdx + 1 },
      );
    } else if (trimmed.startsWith('>')) {
      flushMarkdownParagraph(blocks, paragraph, headingPath);
      pushMarkdownBlock(
        blocks,
        'blockquote',
        trimRust(trimmed.replace(/^>+/, '')),
        null,
        headingPath,
        { format: 'md', line: lineIdx + 1 },
      );
    } else if (trimmed.startsWith('![')) {
      flushMarkdownParagraph(blocks, paragraph, headingPath);
      pushMarkdownBlock(
        blocks,
        'image',
        trimmed,
        null,
        headingPath,
        { format: 'md', line: lineIdx + 1 },
      );
    } else {
      paragraph.push(trimmed);
    }
  }

  if (inFrontmatter) {
    pushMarkdownBlock(
      blocks,
      'metadata',
      frontmatter.join('\n'),
      null,
      headingPath,
      { format: 'md', source: 'frontmatter' },
    );
    warnings.push('markdown_unclosed_frontmatter');
  }
  if (inCode) {
    pushMarkdownBlock(
      blocks,
      'code',
      codeFence.join('\n'),
      null,
      headingPath,
      { format: 'md', source: 'code_fence' },
    );
    warnings.push('markdown_unclosed_code_fence');
  }
  flushMarkdownParagraph(blocks, paragraph, headingPath);
  flushMarkdownTable(blocks, tables, tableLines, headingPath);

  const anchors: SourceAnchor[] = [];
  attachTableCellAnchors(docId, parseJobId, 'md', blocks, tables, anchors);
  const charCursor: CharCursor = { pos: 0 };
  for (const block of blocks) {
    if (block.anchor_ids.length > 0) continue;
    const anchor = sourceAnchorStructural(
      docId,
      parseJobId,
      NIL_UUID,
      'md',
      block.block_type,
      block.block_id,
      block.page_start,
      block.slide_index,
      block.source_ref,
      block.text,
    );
    const range = findTextCharRange(text, block.text, charCursor);
    if (range !== null) {
      anchor.char_range = { start: range[0], end: range[1] };
    }
    block.anchor_ids.push(anchor.anchor_id);
    anchors.push(anchor);
  }

  const parsed = finalizeParsed(docId, parseJobId, 'md', title, null, blocks, tables, anchors);
  parsed.warnings.push(...warnings);
  return parsed;
}

function markdownHeading(line: string): [number, string] | null {
  let hashes = 0;
  for (const ch of line) {
    if (ch !== '#') break;
    hashes += 1;
  }
  if (hashes === 0 || hashes > 6) return null;
  const rest = trimRust(line.slice(hashes));
  if (rest.length === 0) return null;
  return [hashes, trimChars(rest, '#').trim()];
}

function markdownListItem(line: string): boolean {
  if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('+ ')) return true;
  const dot = line.indexOf('. ');
  if (dot < 0) return false;
  const prefix = line.slice(0, dot);
  if (prefix.length === 0) return false;
  return [...prefix].every((ch) => ch >= '0' && ch <= '9');
}

function markdownTableLine(line: string): boolean {
  return line.startsWith('|') && line.endsWith('|') && countChar(line, '|') >= 2;
}

function pushMarkdownBlock(
  blocks: ParsedBlock[],
  blockType: string,
  blockText: string,
  headingLevel: number | null,
  headingPath: Array<[number, string]>,
  metadata: unknown,
): void {
  if (trimRust(blockText).length === 0) return;
  blocks.push({
    block_id: newUuid(),
    block_index: blocks.length,
    block_type: blockType,
    text: blockText,
    heading_level: headingLevel,
    heading_path: headingPath.map(([, heading]) => heading),
    page_start: null,
    page_end: null,
    slide_index: null,
    table_id: null,
    bbox: null,
    anchor_ids: [],
    source_ref: { format: 'md', index: blocks.length },
    metadata,
  });
}

function flushMarkdownParagraph(
  blocks: ParsedBlock[],
  paragraph: string[],
  headingPath: Array<[number, string]>,
): void {
  if (paragraph.length === 0) return;
  const text = paragraph.join('\n');
  paragraph.length = 0;
  pushMarkdownBlock(
    blocks,
    'paragraph',
    text,
    null,
    headingPath,
    { format: 'md', source: 'paragraph' },
  );
}

function flushMarkdownTable(
  blocks: ParsedBlock[],
  tables: ParsedTable[],
  tableLines: string[],
  headingPath: Array<[number, string]>,
): void {
  if (tableLines.length < 2 || !markdownTableSeparator(tableLines[1] ?? '')) {
    if (tableLines.length > 0) {
      const text = tableLines.join('\n');
      pushMarkdownBlock(
        blocks,
        'paragraph',
        text,
        null,
        headingPath,
        { format: 'md', source: 'paragraph' },
      );
    }
    tableLines.length = 0;
    return;
  }

  const rows = tableLines
    .filter((line) => ![...line].every((ch) => ch === '|' || ch === '-' || ch === ':' || ch === ' '))
    .map((line) =>
      trimChars(line, '|').split('|').map((cell) => trimRust(cell)),
    );
  tableLines.length = 0;
  if (rows.length === 0) return;

  const blockId = newUuid();
  const tableId = newUuid();
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  const markdown = tableMarkdown(headers, body);
  const cells: ParsedTableCell[] = [];
  for (const [rowIdx, row] of rows.entries()) {
    for (const [colIdx, cellText] of row.entries()) {
      cells.push({
        cell_id: newUuid(),
        row_index: rowIdx,
        col_index: colIdx,
        rowspan: 1,
        colspan: 1,
        text: cellText,
        normalized_text: normalizeSpace(cellText),
        is_header: rowIdx === 0,
        data_type: 'text',
        bbox: null,
        style: {},
        source_ref: { format: 'md', table_index: tables.length, row: rowIdx, col: colIdx },
      });
    }
  }
  const path = headingPath.map(([, heading]) => heading);
  const tableIndex = tables.length;
  tables.push({
    table_id: tableId,
    block_id: blockId,
    table_index: tableIndex,
    title: path.length > 0 ? path[path.length - 1]! : null,
    heading_path: [...path],
    page_start: null,
    page_end: null,
    slide_index: null,
    headers: [...headers],
    rows: body,
    cells,
    markdown,
    quality: { header_confidence: 0.9, grid_confidence: 0.9, warnings: [] },
    source_ref: { format: 'md', table_index: tableIndex },
  });
  // 对齐 Rust：tables.push 之后 blocks.push，source_ref.index 为新 tables.len()
  blocks.push({
    block_id: blockId,
    block_index: blocks.length,
    block_type: 'table',
    text: markdown,
    heading_level: null,
    heading_path: path,
    page_start: null,
    page_end: null,
    slide_index: null,
    table_id: tableId,
    bbox: null,
    anchor_ids: [],
    source_ref: { format: 'md', node: 'table', index: tables.length },
    metadata: { format: 'md', source: 'table' },
  });
}

function markdownTableSeparator(line: string): boolean {
  let count = 0;
  for (const rawCell of trimChars(trimRust(line), '|').split('|')) {
    const cell = trimChars(trimRust(rawCell), ':');
    if (cell.length < 3 || ![...cell].every((ch) => ch === '-')) return false;
    count += 1;
  }
  return count > 0;
}

function trimChars(value: string, ch: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ch) start += 1;
  while (end > start && value[end - 1] === ch) end -= 1;
  return value.slice(start, end);
}

function countChar(value: string, ch: string): number {
  let count = 0;
  for (const c of value) {
    if (c === ch) count += 1;
  }
  return count;
}

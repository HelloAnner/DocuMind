// 移植自 apps/api-rs/src/document/shared.rs —— 行为对齐 Rust 原版，错误信息保持一致

// 共享逻辑：zip 安全校验与读取、XML 表格解析、表格锚点、文本收集、markdown 表格渲染

import JSZip from 'jszip';
import type { JSZipObject } from 'jszip';
import { newUuid } from '../infra/uuid.ts';
import type { CellRange, SourceAnchor } from '../models/source_anchor.ts';
import { sourceAnchorTableCellRange } from '../models/source_anchor.ts';
import {
  MAX_OFFICE_COMPRESSION_RATIO,
  MAX_OFFICE_ENTRY_BYTES,
  MAX_OFFICE_UNCOMPRESSED_BYTES,
  MAX_OFFICE_XML_BYTES,
  MAX_OFFICE_ZIP_ENTRIES,
  NIL_UUID,
  type ParsedBlock,
  type ParsedDocument,
  type ParsedTable,
  type ParsedTableCell,
} from './types.ts';
import { attrI32, childElements, descendants, attr, type XmlElement } from './xml.ts';
import { splitWhitespace } from './text_utils.ts';

export function normalizeSpace(value: string): string {
  return splitWhitespace(value).join(' ');
}

/** 对齐 Rust collect_text：后代文本拼接，tab -> \t，br/cr -> \n，最后 normalize_space */
export function collectText(node: XmlElement): string {
  let text = '';
  for (const ref of descendants(node)) {
    if (ref.kind === 'text') {
      text += ref.text;
    } else if (ref.element.name === 'tab') {
      text += '\t';
    } else if (ref.element.name === 'br' || ref.element.name === 'cr') {
      text += '\n';
    }
  }
  return normalizeSpace(text);
}

export function finalizeParsed(
  docId: string,
  parseJobId: string,
  fileType: string,
  title: string,
  pages: number | null,
  blocks: ParsedBlock[],
  tables: ParsedTable[],
  anchors: SourceAnchor[],
): ParsedDocument {
  return {
    doc_id: docId,
    parse_job_id: parseJobId,
    file_type: fileType,
    title,
    pages,
    blocks,
    tables,
    anchors,
    warnings: [],
    quality_score: 0.0,
  };
}

/** 对齐 Rust attach_table_cell_anchors：为表格块补充 table_cell_range 锚点 */
export function attachTableCellAnchors(
  docId: string,
  parseJobId: string,
  format: string,
  blocks: ParsedBlock[],
  tables: ParsedTable[],
  anchors: SourceAnchor[],
): void {
  for (const block of blocks) {
    if (block.table_id === null) continue;
    if (block.anchor_ids.some((anchorId) => anchors.some((anchor) => anchor.anchor_id === anchorId))) {
      continue;
    }
    const table = tables.find((candidate) => candidate.table_id === block.table_id);
    if (!table) continue;
    const cellRange = tableCellRange(table);
    const sourceRef = {
      format,
      table_index: table.table_index,
      table_id: table.table_id,
      kind: 'table_cell_range',
      cell_range: {
        row_start: cellRange.row_start,
        row_end: cellRange.row_end,
        col_start: cellRange.col_start,
        col_end: cellRange.col_end,
      },
    };
    const anchor = sourceAnchorTableCellRange(
      docId,
      parseJobId,
      NIL_UUID,
      format,
      block.block_id,
      table.table_id,
      table.page_start ?? block.page_start,
      table.slide_index ?? block.slide_index,
      cellRange,
      sourceRef,
      table.markdown,
    );
    block.anchor_ids.push(anchor.anchor_id);
    anchors.push(anchor);
  }
}

function tableCellRange(table: ParsedTable): CellRange {
  let rowEnd = 0;
  let colEnd = 0;
  for (const cell of table.cells) {
    rowEnd = Math.max(rowEnd, cell.row_index + Math.max(cell.rowspan, 1) - 1);
    colEnd = Math.max(colEnd, cell.col_index + Math.max(cell.colspan, 1) - 1);
  }
  return { row_start: 0, row_end: rowEnd, col_start: 0, col_end: colEnd };
}

/** 对齐 Rust parse_xml_table：w:tbl / a:tbl 网格解析（gridSpan / vMerge / rowSpan） */
export function parseXmlTable(
  tbl: XmlElement,
  _docId: string,
  _parseJobId: string,
  blockId: string,
  tableIndex: number,
  headingPath: string[],
  pageStart: number | null,
  pageEnd: number | null,
  slideIndex: number | null,
  format: string,
): ParsedTable {
  const tableId = newUuid();
  const rowNodes = childElements(tbl).filter((node) => node.name === 'tr');
  const rows: string[][] = [];
  const cells: ParsedTableCell[] = [];
  const verticalMerges = new Map<number, number>();

  for (const [rowIdx, row] of rowNodes.entries()) {
    const cellNodes = childElements(row).filter((node) => node.name === 'tc');
    const rowValues: string[] = [];
    let colIdx = 0;
    for (const cell of cellNodes) {
      const text = collectText(cell).trim();
      const gridSpanEl = descendants(cell).find(
        (ref) => ref.kind === 'element' && ref.element.name === 'gridSpan',
      );
      const colspan = Math.max(
        attrI32(cell, 'gridSpan')
          ?? (gridSpanEl?.kind === 'element' ? attrI32(gridSpanEl.element, 'val') : undefined)
          ?? 1,
        1,
      );
      const vMergeEl = descendants(cell).find(
        (ref) => ref.kind === 'element' && ref.element.name === 'vMerge',
      );
      const vMerge = vMergeEl?.kind === 'element' ? vMergeEl.element : undefined;
      const vMergeVal = vMerge ? attr(vMerge, 'val') : undefined;
      const continuesVerticalMerge = vMerge
        ? (vMergeVal !== undefined ? vMergeVal !== 'restart' : true)
        : false;
      if (continuesVerticalMerge) {
        const originIndex = verticalMerges.get(colIdx);
        if (originIndex !== undefined) {
          const origin = cells[originIndex];
          if (origin) origin.rowspan += 1;
        }
        for (let i = 0; i < colspan; i += 1) rowValues.push('');
        colIdx += colspan;
        continue;
      }

      rowValues.push(text);
      for (let i = 0; i < Math.max(colspan - 1, 0); i += 1) rowValues.push('');
      const cellIndex = cells.length;
      cells.push({
        cell_id: newUuid(),
        row_index: rowIdx,
        col_index: colIdx,
        rowspan: Math.max(attrI32(cell, 'rowSpan') ?? 1, 1),
        colspan,
        normalized_text: normalizeSpace(text),
        text,
        is_header: rowIdx === 0,
        data_type: 'text',
        bbox: null,
        style: {},
        source_ref: { format, table_index: tableIndex, row: rowIdx, col: colIdx },
      });
      for (let column = colIdx; column < colIdx + colspan; column += 1) {
        if (vMergeVal === 'restart') {
          verticalMerges.set(column, cellIndex);
        } else {
          verticalMerges.delete(column);
        }
      }
      colIdx += colspan;
    }
    if (!rowValues.every((value) => value.length === 0)) {
      rows.push(rowValues);
    }
  }
  const headers = rows.length > 0 ? (rows[0] ?? []) : [];
  const body = rows.slice(1);
  const markdown = tableMarkdown(headers, body);
  const totalSlots = rows.reduce((sum, row) => sum + row.length, 0);
  const emptySlots = rows.reduce(
    (sum, row) => sum + row.filter((value) => value.trim().length === 0).length,
    0,
  );
  const emptyCellRatio = totalSlots === 0 ? 1.0 : emptySlots / totalSlots;
  return {
    table_id: tableId,
    block_id: blockId,
    table_index: tableIndex,
    title: headingPath.length > 0 ? headingPath[headingPath.length - 1]! : null,
    heading_path: headingPath,
    page_start: pageStart,
    page_end: pageEnd,
    slide_index: slideIndex,
    headers,
    rows: body,
    cells,
    markdown,
    quality: {
      header_confidence: rows.length === 0 ? 0.0 : 0.9,
      grid_confidence: 0.95,
      empty_cell_ratio: emptyCellRatio,
      warnings: [],
    },
    source_ref: { format, table_index: tableIndex },
  };
}

// ---------------- zip 安全校验与读取（对齐 Rust shared::{open_zip, read_zip_text, ...}） ----------------

interface ZipEntrySize {
  uncompressedSize: number;
  compressedSize: number;
}

/** jszip 未在类型中暴露 central directory 尺寸元数据，运行时校验后显式使用 */
function zipEntrySize(file: JSZipObject): ZipEntrySize {
  const internal = file as unknown as { _data?: { uncompressedSize?: number; compressedSize?: number } };
  const uncompressedSize = internal._data?.uncompressedSize;
  const compressedSize = internal._data?.compressedSize;
  if (typeof uncompressedSize !== 'number' || typeof compressedSize !== 'number') {
    throw new Error('zip_entry_meta_missing:' + file.name);
  }
  return { uncompressedSize, compressedSize };
}

export async function openZip(bytes: Uint8Array): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error('invalid_zip_container');
  }
  validateOfficeZip(zip);
  return zip;
}

export async function zipEntryNames(bytes: Uint8Array): Promise<string[]> {
  const zip = await openZip(bytes);
  return Object.values(zip.files).map((file) => file.name);
}

export async function readZipText(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  if (!file) throw new Error('missing_zip_entry:' + name);
  const { uncompressedSize } = zipEntrySize(file);
  if (uncompressedSize > MAX_OFFICE_XML_BYTES) {
    throw new Error('zip_xml_entry_too_large:' + name + ':' + uncompressedSize + '>' + MAX_OFFICE_XML_BYTES);
  }
  const raw = await file.async('uint8array');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Error('invalid_zip_entry_encoding:' + name);
  }
}

function validateOfficeZip(zip: JSZip): void {
  const entries = Object.values(zip.files);
  if (entries.length > MAX_OFFICE_ZIP_ENTRIES) {
    throw new Error('zip_entry_count_exceeded:' + entries.length + '>' + MAX_OFFICE_ZIP_ENTRIES);
  }
  let totalUncompressed = 0;
  for (const file of entries) {
    if (file.dir) continue;
    const name = file.name;
    if (!isSafeZipEntryName(name)) {
      throw new Error('zip_entry_name_unsafe:' + name);
    }
    const { uncompressedSize, compressedSize } = zipEntrySize(file);
    if (uncompressedSize > MAX_OFFICE_ENTRY_BYTES) {
      throw new Error('zip_entry_too_large:' + name + ':' + uncompressedSize + '>' + MAX_OFFICE_ENTRY_BYTES);
    }
    totalUncompressed += uncompressedSize;
    if (!Number.isSafeInteger(totalUncompressed)) {
      throw new Error('zip_uncompressed_size_overflow');
    }
    if (totalUncompressed > MAX_OFFICE_UNCOMPRESSED_BYTES) {
      throw new Error('zip_uncompressed_size_exceeded:' + totalUncompressed + '>' + MAX_OFFICE_UNCOMPRESSED_BYTES);
    }
    if (uncompressedSize > 0 && compressedSize === 0) {
      throw new Error('zip_entry_invalid_compressed_size:' + name);
    }
    if (compressedSize > 0 && uncompressedSize > compressedSize * MAX_OFFICE_COMPRESSION_RATIO) {
      throw new Error(
        'zip_compression_ratio_exceeded:' + name + ':' + uncompressedSize + '/' + compressedSize + '>' + MAX_OFFICE_COMPRESSION_RATIO,
      );
    }
  }
}

function isSafeZipEntryName(name: string): boolean {
  if (name.trim().length === 0
    || name.startsWith('/')
    || name.startsWith('\\')
    || name.includes('\0')
    || name.includes(':')) {
    return false;
  }
  const normalized = name.replace(/\\/g, '/');
  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  return trimmed.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

// ---------------- markdown 表格渲染 ----------------

export function tableMarkdown(headers: string[], rows: string[][]): string {
  if (headers.length === 0) {
    return rows.map((row) => row.join(' | ')).join('\n');
  }
  let out = '';
  out += '|' + headers.map((header) => escapeTableCell(header)).join('|') + '|\n';
  out += '|' + headers.map(() => '---').join('|') + '|\n';
  for (const row of rows) {
    out += '|' + row.map((value) => escapeTableCell(value)).join('|') + '|\n';
  }
  return out;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

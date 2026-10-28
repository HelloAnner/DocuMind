import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

import { newUuid } from '../infra/uuid.ts';
import {
  sourceAnchorForPdfParagraph,
  sourceAnchorTableCellRange,
  type SourceAnchor,
} from '../models/source_anchor.ts';
import { finalizeParsed } from './shared.ts';
import { charCount, trimRust } from './text_utils.ts';
import {
  NIL_UUID,
  MAX_PDF_PAGES,
  MAX_PDF_PAGE_TEXT_CHARS,
  type ParsedBlock,
  type ParsedDocument,
  type ParsedTable,
  type ParsedTableCell,
} from './types.ts';
import { extractPdfPageLayout, type PdfLayoutBlock, type PdfPageLayout } from './pdf_layout.ts';

const pdfjsGlobal = globalThis as typeof globalThis & {
  pdfjsWorker?: { WorkerMessageHandler: typeof WorkerMessageHandler };
};
pdfjsGlobal.pdfjsWorker ??= { WorkerMessageHandler };

export async function parsePdf(
  docId: string,
  parseJobId: string,
  title: string,
  bytes: Uint8Array,
): Promise<ParsedDocument> {
  const { task, doc } = await loadDocument(bytes);
  try {
    if (doc.numPages > MAX_PDF_PAGES) {
      throw new Error(`pdf_page_count_exceeded:${doc.numPages}>${MAX_PDF_PAGES}`);
    }
    const pages = await extractPageLayouts(doc);
    const blocks: ParsedBlock[] = [];
    const tables: ParsedTable[] = [];
    const anchors: SourceAnchor[] = [];
    const warnings: string[] = [];
    const repeatedNoise = repeatedHeaderFooterText(pages);
    let currentHeading: string | null = null;
    let pagesWithoutText = 0;

    for (const [pageIndex, layout] of pages.entries()) {
      const page = pageIndex + 1;
      const pageChars = charCount(layout.text);
      if (pageChars > MAX_PDF_PAGE_TEXT_CHARS) {
        throw new Error(`pdf_page_text_chars_exceeded:${page}:${pageChars}>${MAX_PDF_PAGE_TEXT_CHARS}`);
      }
      if (layout.blocks.length === 0) {
        pagesWithoutText += 1;
        warnings.push(`pdf_page_${page}_no_text_layer`);
        continue;
      }
      const bodyFonts = layout.blocks
        .filter((block) => block.kind === 'text' && block.text.length >= 20)
        .map((block) => block.font_size);
      const bodyFont = median(bodyFonts.length > 0 ? bodyFonts : layout.blocks.map((block) => block.font_size));

      for (const layoutBlock of layout.blocks) {
        const text = trimRust(layoutBlock.text);
        if (!text || repeatedNoise.has(noiseKey(layoutBlock))) continue;
        if (layoutBlock.kind === 'table' && layoutBlock.rows) {
          const result = createPdfTable(docId, parseJobId, page, layoutBlock, tables.length, blocks.length, currentHeading);
          tables.push(result.table);
          blocks.push(result.block);
          anchors.push(result.anchor);
          continue;
        }

        const blockId = newUuid();
        const formula = layoutBlock.kind === 'formula';
        const heading = !formula && looksLikeHeading(text, layoutBlock.font_size, bodyFont);
        const blockType = formula ? 'formula' : heading ? 'heading' : 'paragraph';
        const anchor = sourceAnchorForPdfParagraph(
          docId, parseJobId, NIL_UUID, blockId, page, text, layoutBlock.bbox,
        );
        anchor.kind = formula ? 'formula' : heading ? 'heading' : 'paragraph';
        anchor.source_ref = {
          format: 'pdf', page, pdf_text_run_ids: layoutBlock.source_run_ids,
        };
        anchors.push(anchor);
        blocks.push({
          block_id: blockId,
          block_index: blocks.length,
          block_type: blockType,
          text,
          heading_level: heading ? 1 : null,
          heading_path: heading ? [] : currentHeading ? [currentHeading] : [],
          page_start: page,
          page_end: page,
          slide_index: null,
          table_id: null,
          bbox: layoutBlock.bbox,
          anchor_ids: [anchor.anchor_id],
          source_ref: anchor.source_ref,
          metadata: {
            layout: 'positioned_text_layer',
            font_size: layoutBlock.font_size,
            extraction_method: 'text_layer',
            ...(formula ? { formula_format: 'plain_text' } : {}),
          },
        });
        if (heading) currentHeading = text;
      }
    }

    if (blocks.length === 0) warnings.push('scanned_pdf_no_text_layer');
    else if (pagesWithoutText > 0) warnings.push(`pdf_partial_text_layer:${pagesWithoutText}/${pages.length}`);
    if (tables.length > 0) warnings.push(`pdf_tables_detected:${tables.length}`);

    const parsed = finalizeParsed(docId, parseJobId, 'pdf', title, pages.length, blocks, tables, anchors);
    parsed.warnings.push(...warnings);
    return parsed;
  } finally {
    try {
      await task.destroy();
    } catch (error) {
      console.error('[documind][document] pdf worker cleanup failed:', messageOf(error));
    }
  }
}

async function loadDocument(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false });
  try {
    return { task, doc: await task.promise };
  } catch (error) {
    throw new Error('pdf_text_extract_failed:' + messageOf(error));
  }
}

async function extractPageLayouts(doc: {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getViewport(options: { scale: number }): { width: number; height: number };
    getTextContent(): Promise<{ items: unknown[] }>;
  }>;
}): Promise<PdfPageLayout[]> {
  try {
    const pages: PdfPageLayout[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      pages.push(await extractPdfPageLayout(await doc.getPage(pageNumber), pageNumber));
    }
    return pages;
  } catch (error) {
    throw new Error('pdf_text_extract_failed:' + messageOf(error));
  }
}

function createPdfTable(
  docId: string,
  parseJobId: string,
  page: number,
  layout: PdfLayoutBlock,
  tableIndex: number,
  blockIndex: number,
  currentHeading: string | null,
): { table: ParsedTable; block: ParsedBlock; anchor: SourceAnchor } {
  const rows = layout.rows ?? [];
  const width = Math.max(0, ...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ''));
  const blockId = newUuid();
  const tableId = newUuid();
  const cells: ParsedTableCell[] = [];
  for (const [rowIndex, row] of normalizedRows.entries()) {
    for (const [columnIndex, text] of row.entries()) {
      cells.push({
        cell_id: newUuid(), row_index: rowIndex, col_index: columnIndex,
        rowspan: 1, colspan: 1, text, normalized_text: text.replace(/\s+/g, ' ').trim(),
        is_header: rowIndex === 0, data_type: tableDataType(text), bbox: null, style: {},
        source_ref: { format: 'pdf', page, table_index: tableIndex, row: rowIndex, col: columnIndex },
      });
    }
  }
  const headers = normalizedRows[0] ?? [];
  const body = normalizedRows.slice(1);
  const cellRange = {
    row_start: 0,
    row_end: Math.max(0, normalizedRows.length - 1),
    col_start: 0,
    col_end: Math.max(0, width - 1),
  };
  const sourceRef = {
    format: 'pdf', page, table_index: tableIndex, table_id: tableId,
    pdf_text_run_ids: layout.source_run_ids, cell_range: cellRange,
  };
  const anchor = sourceAnchorTableCellRange(
    docId, parseJobId, NIL_UUID, 'pdf', blockId, tableId, page, null,
    cellRange, sourceRef, layout.text, layout.bbox,
  );
  const headingPath = currentHeading ? [currentHeading] : [];
  return {
    table: {
      table_id: tableId, block_id: blockId, table_index: tableIndex,
      title: currentHeading, heading_path: headingPath,
      page_start: page, page_end: page, slide_index: null,
      headers, rows: body, cells, markdown: layout.text,
      quality: { header_confidence: 0.7, grid_confidence: layout.confidence ?? 0.65, extraction_method: 'text_alignment' },
      source_ref: sourceRef,
    },
    block: {
      block_id: blockId, block_index: blockIndex, block_type: 'table', text: layout.text,
      heading_level: null, heading_path: headingPath,
      page_start: page, page_end: page, slide_index: null, table_id: tableId,
      bbox: layout.bbox, anchor_ids: [anchor.anchor_id], source_ref: sourceRef,
      metadata: { layout: 'positioned_table', extraction_method: 'text_layer', table_grid_confidence: layout.confidence ?? 0.65 },
    },
    anchor,
  };
}

function repeatedHeaderFooterText(pages: PdfPageLayout[]): Set<string> {
  const pagesByKey = new Map<string, Set<number>>();
  for (const [pageIndex, page] of pages.entries()) {
    for (const block of page.blocks) {
      if (block.kind !== 'text' || (block.bbox.y1 < 0.88 && block.bbox.y0 > 0.12)) continue;
      const key = noiseKey(block);
      if (key.length < 2 || key.length > 160) continue;
      const seen = pagesByKey.get(key) ?? new Set<number>();
      seen.add(pageIndex);
      pagesByKey.set(key, seen);
    }
  }
  const minimum = Math.max(2, Math.ceil(pages.length * 0.6));
  return new Set([...pagesByKey].filter(([, pageSet]) => pageSet.size >= minimum).map(([key]) => key));
}

function noiseKey(block: PdfLayoutBlock): string {
  return block.text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
}

function looksLikeHeading(text: string, fontSize: number, bodyFont: number): boolean {
  const length = charCount(text);
  if (length < 2 || length > 100) return false;
  const last = [...text].pop();
  if (last !== undefined && '.。！!？?；;，,'.includes(last)) return false;
  let meaningful = 0;
  let digits = 0;
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) meaningful += 1;
    if (ch >= '0' && ch <= '9') digits += 1;
  }
  const numbered = /^(第[一二三四五六七八九十百]+[章节]|\d+(?:\.\d+)*[、.\s])/u.test(text);
  return meaningful > 0 && digits * 2 < meaningful && (numbered || fontSize >= bodyFont * 1.18);
}

function tableDataType(text: string): string {
  const value = text.trim();
  if (/^[+-]?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?%$/u.test(value)) return 'percentage';
  if (/^[¥￥$€£]?\s*[+-]?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?$/u.test(value)) return 'number';
  if (/^\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?$/u.test(value)) return 'date';
  return 'text';
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

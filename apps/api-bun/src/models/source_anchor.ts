// 移植自 apps/api-rs/src/models/source_anchor.ts 对应 Rust models/source_anchor.rs
export interface CellRange { row_start: number; row_end: number; col_start: number; col_end: number; }
export interface CharRange { start: number; end: number; }
export interface NormalizedBBox {
  x0: number; y0: number; x1: number; y1: number; unit: string; rotation: number;
}
export function normalizedBBox(x0: number, y0: number, x1: number, y1: number): NormalizedBBox {
  return { x0, y0, x1, y1, unit: 'normalized', rotation: 0 };
}
export function bboxToPoints(bbox: NormalizedBBox, pageWidth: number, pageHeight: number): [number, number, number, number] {
  return [bbox.x0 * pageWidth, bbox.y0 * pageHeight, bbox.x1 * pageWidth, bbox.y1 * pageHeight];
}

export interface SourceAnchor {
  anchor_id: string; doc_id: string; parse_job_id: string; tenant_id: string;
  format: string; kind: string;
  page: number | null; slide: number | null;
  block_id: string | null; table_id: string | null;
  cell_range?: CellRange | null; char_range?: CharRange | null; bbox?: NormalizedBBox | null;
  source_ref: unknown;
  text: string; text_hash?: string | null; anchor_quality: string;
}

function hexHash(text: string): string {
  const digest = new Bun.CryptoHasher('sha256').update(text).digest('hex');
  return digest;
}

import { newUuid } from '../infra/uuid.ts';

export function sourceAnchorForPdfParagraph(
  docId: string, parseJobId: string, tenantId: string, blockId: string,
  page: number, text: string, bbox: NormalizedBBox | null,
): SourceAnchor {
  return {
    anchor_id: newUuid(), doc_id: docId, parse_job_id: parseJobId, tenant_id: tenantId,
    format: 'pdf', kind: 'paragraph', page, slide: null,
    block_id: blockId, table_id: null,
    cell_range: null, char_range: null, bbox,
    source_ref: { format: 'pdf', page },
    text, text_hash: hexHash(text),
    anchor_quality: bbox ? 'bbox' : 'page',
  };
}

export function sourceAnchorStructural(
  docId: string, parseJobId: string, tenantId: string, format: string, kind: string,
  blockId: string, page: number | null, slide: number | null,
  sourceRef: unknown, text: string,
): SourceAnchor {
  return {
    anchor_id: newUuid(), doc_id: docId, parse_job_id: parseJobId, tenant_id: tenantId,
    format, kind, page, slide,
    block_id: blockId, table_id: null,
    cell_range: null, char_range: null, bbox: null,
    source_ref: sourceRef, text, text_hash: hexHash(text),
    anchor_quality: 'structural',
  };
}

export function sourceAnchorTableCellRange(
  docId: string, parseJobId: string, tenantId: string, format: string,
  blockId: string, tableId: string, page: number | null, slide: number | null,
  cellRange: CellRange, sourceRef: unknown, text: string,
): SourceAnchor {
  return {
    anchor_id: newUuid(), doc_id: docId, parse_job_id: parseJobId, tenant_id: tenantId,
    format, kind: 'table_cell_range', page, slide,
    block_id: blockId, table_id: tableId,
    cell_range: cellRange, char_range: null, bbox: null,
    source_ref: sourceRef, text, text_hash: hexHash(text),
    anchor_quality: 'structural',
  };
}

// 移植自 apps/api-rs/src/agent/citation_resolver.rs
import type { CitationOutput } from '../models/agent.ts';
import type { CitationAnchor } from '../models/citation.ts';
import type { NormalizedBBox, CharRange } from '../models/source_anchor.ts';
import type { EvidencePack, RerankedChunk, RetrievedChunk } from '../models/rag.ts';

const MAX_QUOTE_CHARS = 180;
const MAX_CITATIONS = 6;

export function resolveCitations(answer: string, evidence: EvidencePack): CitationOutput[] {
  const citedIndexes = citedEvidenceIndexes(answer);
  if (citedIndexes.length === 0) return [];
  const cited = new Set(citedIndexes);
  const selected: Array<{ oneBased: number; chunk: RerankedChunk }> = [];
  evidence.chunks.forEach((chunk, evidenceIndex) => {
    const oneBased = evidenceIndex + 1;
    if (!cited.has(oneBased)) return;
    selected.push({ oneBased, chunk });
  });

  const seenDocs = new Set<string>();
  const output: CitationOutput[] = [];
  for (const { oneBased, chunk } of selected) {
    if (seenDocs.has(chunk.chunk.doc_id)) continue;
    seenDocs.add(chunk.chunk.doc_id);
    if (output.length >= MAX_CITATIONS) break;
    output.push({
      index: oneBased,
      chunk_id: chunk.chunk.chunk_id,
      doc_id: chunk.chunk.doc_id,
      doc_title: chunk.chunk.doc_title,
      page_range: [...chunk.chunk.page_range],
      quote: compactQuote(chunk.chunk.content),
      score: chunk.score,
      source_status: 'available',
      anchor: anchorForChunk(chunk),
    });
  }
  return output;
}

export function canonicalizeCitationMarkers(answer: string, evidence: EvidencePack): string {
  const cited = citedEvidenceIndexes(answer);
  const firstByDoc = new Map<string, number>();
  const replacements = new Map<number, number>();
  for (const index of cited) {
    const chunk = evidence.chunks[index - 1];
    if (!chunk) continue;
    const docId = chunk.chunk.doc_id;
    const canonical = firstByDoc.has(docId) ? firstByDoc.get(docId)! : index;
    if (!firstByDoc.has(docId)) firstByDoc.set(docId, index);
    replacements.set(index, canonical);
  }

  let result = '';
  let rest = answer;
  for (;;) {
    const start = rest.indexOf('[');
    if (start === -1) break;
    result += rest.slice(0, start);
    const marker = rest.slice(start);
    const end = marker.indexOf(']');
    if (end === -1) {
      result += marker;
      return result;
    }
    const values = marker
      .slice(1, end)
      .split(',')
      .map((part) => parseI32Strict(part.trim()));
    if (values.every((value) => value !== null)) {
      const canonical: number[] = [];
      for (const value of values as number[]) {
        const mapped = replacements.has(value) ? replacements.get(value)! : value;
        if (!canonical.includes(mapped)) canonical.push(mapped);
      }
      result += '[' + canonical.join(',') + ']';
    } else {
      result += marker.slice(0, end + 1);
    }
    rest = marker.slice(end + 1);
  }
  result += rest;
  return result;
}

export function citedEvidenceIndexes(answer: string): number[] {
  const indexes = new Set<number>();
  let cursor = 0;
  const chars = [...answer];
  while (cursor < chars.length) {
    const ch = chars[cursor];
    cursor += 1;
    if (ch !== '[') continue;
    let marker = '';
    let closed = false;
    while (cursor < chars.length) {
      const next = chars[cursor];
      cursor += 1;
      if (next === ']') {
        closed = true;
        break;
      }
      marker += next;
    }
    if (!closed) break;
    for (const part of marker.split(',')) {
      const parsed = parseI32Strict(part.trim());
      if (parsed !== null && parsed > 0) indexes.add(parsed);
    }
  }
  return [...indexes].sort((a, b) => a - b);
}

interface PrimaryAnchorShape {
  anchor_id?: unknown;
  parse_job_id?: unknown;
  format?: unknown;
  kind?: unknown;
  page?: unknown;
  slide?: unknown;
  bbox?: unknown;
  char_range?: unknown;
}

function primaryAnchorOf(chunk: RetrievedChunk): PrimaryAnchorShape | null {
  const anchor = chunk.primary_anchor;
  if (typeof anchor !== 'object' || anchor === null) return null;
  return anchor as PrimaryAnchorShape;
}

function anchorForChunk(chunk: RerankedChunk): CitationAnchor {
  const primary = primaryAnchorOf(chunk.chunk);
  const page =
    primary && typeof primary.page === 'number'
      ? primary.page
      : chunk.chunk.page_range.length > 0
        ? chunk.chunk.page_range[0]
        : null;
  const slide =
    primary && typeof primary.slide === 'number'
      ? primary.slide
      : metadataI32(chunk.chunk.metadata, 'slide_start') ??
        metadataI32(chunk.chunk.metadata, 'slide') ??
        metadataI32(chunk.chunk.metadata, 'slide_end');
  const kind =
    primary && typeof primary.kind === 'string'
      ? primary.kind
      : chunk.chunk.table_ids.length > 0 || sourceType(chunk.chunk) === 'table'
        ? 'table_region'
        : slide !== null && slide !== undefined
          ? 'slide_shape'
          : 'paragraph';
  const bbox = primary && isBBox(primary.bbox) ? primary.bbox : null;
  const charRange = primary && isCharRange(primary.char_range) ? primary.char_range : null;
  const anchorId = primary && typeof primary.anchor_id === 'string' ? primary.anchor_id : null;
  const parseJobId =
    primary && typeof primary.parse_job_id === 'string' ? primary.parse_job_id : null;

  const locationStatus =
    bbox !== null || charRange !== null
      ? 'exact'
      : chunk.chunk.block_ids.length > 0 || chunk.chunk.table_ids.length > 0
        ? 'structural_only'
        : slide !== null && slide !== undefined
          ? 'slide_only'
          : page !== null
            ? 'page_only'
            : 'unavailable';

  return {
    anchor_id: anchorId,
    parse_job_id: parseJobId,
    format: primary && typeof primary.format === 'string' ? primary.format : chunk.chunk.file_type,
    kind: kind,
    page: page ?? null,
    slide: slide ?? null,
    block_ids: [...chunk.chunk.block_ids],
    table_ids: [...chunk.chunk.table_ids],
    char_range: charRange,
    bbox: bbox,
    location_status: locationStatus,
  };
}

function isBBox(value: unknown): value is NormalizedBBox {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.x0 === 'number' &&
    typeof record.y0 === 'number' &&
    typeof record.x1 === 'number' &&
    typeof record.y1 === 'number'
  );
}

function isCharRange(value: unknown): value is CharRange {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.start === 'number' && typeof record.end === 'number';
}

function metadataI32(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) return parseI32Strict(value) ?? undefined;
  return undefined;
}

function compactQuote(content: string): string {
  const text = stripContextPrefixes(content)
    .replace(/\n/g, ' ')
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(' ');
  const chars = [...text];
  let quote = chars.slice(0, MAX_QUOTE_CHARS).join('');
  if (chars.length > MAX_QUOTE_CHARS) quote += '...';
  return quote;
}

function stripContextPrefixes(content: string): string {
  const skipped = new Set(['标题路径', '页码', 'Slide']);
  const lines: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if ([...skipped].some((prefix) => trimmed.startsWith(prefix))) continue;
    if (trimmed.length === 0 && lines.length === 0) continue;
    lines.push(trimmed);
  }
  return lines.join('\n').trim();
}

function sourceType(chunk: RetrievedChunk): string {
  const value = chunk.metadata['source_type'];
  return typeof value === 'string' ? value : 'paragraph';
}

function parseI32Strict(text: string): number | null {
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  if (value < -2147483648 || value > 2147483647) return null;
  return value;
}

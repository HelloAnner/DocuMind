// 移植自 apps/api-rs/src/agent/citation_resolver.rs
import type { CitationOutput } from '../models/agent.ts';
import type { CitationAnchor } from '../models/citation.ts';
import type { CharRange, NormalizedBBox, SourceAnchor } from '../models/source_anchor.ts';
import type { EvidencePack, RerankedChunk, RetrievedChunk } from '../models/rag.ts';
import { newUuid } from '../infra/uuid.ts';

const MAX_QUOTE_CHARS = 300;

export function resolveCitations(answer: string, evidence: EvidencePack): CitationOutput[] {
  return citationPlan(answer, evidence).citations.map(
    ({ displayIndex, chunk, sourceAnchor }) => ({
      citation_id: newUuid(),
      index: displayIndex,
      chunk_id: chunk.chunk.chunk_id,
      doc_id: chunk.chunk.doc_id,
      doc_title: chunk.chunk.doc_title,
      page_range: [...chunk.chunk.page_range],
      quote: compactQuote(sourceAnchor?.text || chunk.chunk.content),
      score: chunk.score,
      source_status: 'available',
      anchor: anchorForChunk(chunk, sourceAnchor),
    }),
  );
}

export function canonicalizeCitationMarkers(answer: string, evidence: EvidencePack): string {
  const markers = citationPlan(answer, evidence).markerDisplays;
  const rewritten = answer.replace(/\[([^\]]+)\]/g, (marker, _body: string, offset: number) => {
    const displays = markers.get(offset);
    return displays === undefined || displays.length === 0
      ? marker
      : `[${displays.join(',')}]`;
  });
  return rewritten.replace(/(\[\d+(?:,\d+)*\])(?:[ \t]*\1)+/g, '$1');
}

interface PlannedCitation {
  displayIndex: number;
  chunk: RerankedChunk;
  sourceAnchor: SourceAnchor | null;
}

interface CitationPlan {
  citations: PlannedCitation[];
  markerDisplays: Map<number, number[]>;
}

function citationPlan(answer: string, evidence: EvidencePack): CitationPlan {
  const citations: PlannedCitation[] = [];
  const markerDisplays = new Map<number, number[]>();
  const displayByLocation = new Map<string, number>();

  for (const match of answer.matchAll(/\[([^\]]+)\]/g)) {
    const offset = match.index ?? 0;
    const values = match[1]!.split(',').map((part) => parseI32Strict(part.trim()));
    if (values.some((value) => value === null)) continue;
    const displays: number[] = [];
    const claim = claimBeforeMarker(answer, offset);
    for (const evidenceIndex of values as number[]) {
      const chunk = evidence.chunks[evidenceIndex - 1];
      if (!chunk) continue;
      const sourceAnchor = selectedAnchorForChunk(chunk.chunk, claim);
      const key = citationLocationKey(chunk.chunk, sourceAnchor);
      let displayIndex = displayByLocation.get(key);
      if (displayIndex === undefined) {
        displayIndex = citations.length + 1;
        displayByLocation.set(key, displayIndex);
        citations.push({ displayIndex, chunk, sourceAnchor });
      }
      if (!displays.includes(displayIndex)) displays.push(displayIndex);
    }
    markerDisplays.set(offset, displays);
  }

  return { citations, markerDisplays };
}

function claimBeforeMarker(answer: string, offset: number): string {
  const prefix = answer.slice(Math.max(0, offset - 300), offset);
  const boundary = Math.max(
    prefix.lastIndexOf('。'),
    prefix.lastIndexOf('！'),
    prefix.lastIndexOf('？'),
    prefix.lastIndexOf('\n'),
  );
  return prefix.slice(boundary + 1).trim();
}

function citationLocationKey(chunk: RetrievedChunk, anchor: SourceAnchor | null): string {
  return `${chunk.doc_id}:${chunk.chunk_id}:${anchor?.anchor_id ?? ''}:${anchor?.page ?? ''}`;
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
  return [...indexes];
}

function selectedAnchorForChunk(chunk: RetrievedChunk, claim: string): SourceAnchor | null {
  const candidates = chunk.anchors.length > 0
    ? chunk.anchors
    : chunk.primary_anchor === null
      ? []
      : [chunk.primary_anchor];
  if (candidates.length === 0) return null;

  let best = chunk.primary_anchor ?? candidates[0]!;
  let bestScore = textOverlapScore(claim, best.text);
  for (const candidate of candidates) {
    const score = textOverlapScore(claim, candidate.text);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function textOverlapScore(left: string, right: string): number {
  const target = Array.from(left.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));
  const source = right.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (target.length < 2) return source.includes(target.join('')) ? target.length : 0;
  const grams = new Set<string>();
  for (let index = 0; index < target.length - 1; index += 1) {
    grams.add(target[index]! + target[index + 1]!);
  }
  let score = 0;
  for (const gram of grams) if (source.includes(gram)) score += 1;
  return score;
}

function anchorForChunk(chunk: RerankedChunk, sourceAnchor: SourceAnchor | null): CitationAnchor {
  const page = sourceAnchor?.page
    ?? (chunk.chunk.page_range.length > 0 ? chunk.chunk.page_range[0]! : null);
  const slide = sourceAnchor?.slide
    ?? metadataI32(chunk.chunk.metadata, 'slide_start')
    ?? metadataI32(chunk.chunk.metadata, 'slide')
    ?? metadataI32(chunk.chunk.metadata, 'slide_end')
    ?? null;
  const bbox = sourceAnchor?.bbox ?? null;
  const charRange = sourceAnchor?.char_range ?? null;
  const locationStatus =
    bbox !== null || charRange !== null
      ? 'exact'
      : page !== null
        ? 'page_only'
        : slide !== null
          ? 'slide_only'
          : 'file_only';

  return {
    anchor_id: sourceAnchor?.anchor_id ?? null,
    parse_job_id: sourceAnchor?.parse_job_id ?? null,
    format: sourceAnchor?.format ?? chunk.chunk.file_type,
    kind: sourceAnchor?.kind
      ?? (chunk.chunk.table_ids.length > 0 || sourceType(chunk.chunk) === 'table'
        ? 'table_region'
        : slide !== null
          ? 'slide_shape'
          : 'paragraph'),
    page,
    slide,
    block_ids: [...chunk.chunk.block_ids],
    table_ids: [...chunk.chunk.table_ids],
    char_range: charRange,
    bbox,
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

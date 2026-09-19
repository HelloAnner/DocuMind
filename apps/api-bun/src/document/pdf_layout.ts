import { normalizedBBox, type NormalizedBBox } from '../models/source_anchor.ts';

export interface PdfTextItem {
  str?: unknown;
  hasEOL?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
  fontName?: unknown;
}

interface TextRun {
  id: string;
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  baseline: number;
  fontSize: number;
  fontName: string | null;
}

interface TextLine {
  id: number;
  runs: TextRun[];
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  baseline: number;
  fontSize: number;
}

export interface PdfLayoutBlock {
  kind: 'text' | 'table' | 'formula';
  text: string;
  bbox: NormalizedBBox;
  font_size: number;
  source_run_ids: string[];
  rows?: string[][];
  confidence?: number;
}

export interface PdfPageLayout {
  width: number;
  height: number;
  blocks: PdfLayoutBlock[];
  text: string;
}

interface PdfPageLike {
  getViewport(options: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: unknown[] }>;
}

export async function extractPdfPageLayout(page: PdfPageLike, pageNumber: number): Promise<PdfPageLayout> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs = positionedRuns(content.items, pageNumber);
  const lines = readingOrder(groupLines(runs), viewport.width);
  const tableGroups = detectTables(lines, viewport.width);
  const tableLineIds = new Set(tableGroups.flatMap((group) => group.lines.map((line) => line.id)));
  const blocks: PdfLayoutBlock[] = [];

  for (const group of tableGroups) {
    blocks.push({
      kind: 'table',
      text: tableMarkdown(group.rows),
      bbox: normalizeBox(bounds(group.lines), viewport.width, viewport.height),
      font_size: median(group.lines.map((line) => line.fontSize)),
      source_run_ids: group.lines.flatMap((line) => line.runs.map((run) => run.id)),
      rows: group.rows,
      confidence: group.confidence,
    });
  }

  const ordinary = lines.filter((line) => !tableLineIds.has(line.id));
  for (const paragraph of groupParagraphs(ordinary)) {
    const text = joinParagraphLines(paragraph);
    if (!text) continue;
    blocks.push({
      kind: looksLikeFormula(text) ? 'formula' : 'text',
      text,
      bbox: normalizeBox(bounds(paragraph), viewport.width, viewport.height),
      font_size: median(paragraph.map((line) => line.fontSize)),
      source_run_ids: paragraph.flatMap((line) => line.runs.map((run) => run.id)),
    });
  }

  blocks.sort((a, b) => {
    const vertical = b.bbox.y1 - a.bbox.y1;
    return Math.abs(vertical) > 0.01 ? vertical : a.bbox.x0 - b.bbox.x0;
  });
  return {
    width: viewport.width,
    height: viewport.height,
    blocks,
    text: blocks.map((block) => block.text).join('\n\n'),
  };
}

function positionedRuns(items: unknown[], pageNumber: number): TextRun[] {
  const runs: TextRun[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const candidate = items[index] as PdfTextItem;
    if (!candidate || typeof candidate !== 'object' || typeof candidate.str !== 'string') continue;
    const text = candidate.str.trim();
    if (!text) continue;
    if (!Array.isArray(candidate.transform) || candidate.transform.length < 6) continue;
    const transform = candidate.transform.map(Number);
    if (transform.some((value) => !Number.isFinite(value))) continue;
    const x = transform[4]!;
    const baseline = transform[5]!;
    const transformHeight = Math.hypot(transform[2]!, transform[3]!);
    const height = positiveNumber(candidate.height) ?? (transformHeight || 1);
    const width = positiveNumber(candidate.width) ?? Math.max(height * 0.5, height * 0.5 * Array.from(text).length);
    runs.push({
      id: `p${pageNumber}-r${index + 1}`,
      text,
      x0: x,
      y0: baseline - height * 0.25,
      x1: x + width,
      y1: baseline + height * 0.75,
      baseline,
      fontSize: height,
      fontName: typeof candidate.fontName === 'string' ? candidate.fontName : null,
    });
  }
  return runs;
}

function groupLines(runs: TextRun[]): TextLine[] {
  const rows: TextRun[][] = [];
  for (const run of [...runs].sort((a, b) => b.baseline - a.baseline || a.x0 - b.x0)) {
    const row = rows.find((candidate) => {
      const baseline = median(candidate.map((item) => item.baseline));
      const height = median(candidate.map((item) => item.fontSize));
      return Math.abs(run.baseline - baseline) <= Math.max(1.5, Math.min(run.fontSize, height) * 0.45);
    });
    if (row) row.push(run); else rows.push([run]);
  }
  return rows.map((row, id) => {
    row.sort((a, b) => a.x0 - b.x0);
    const box = bounds(row);
    return {
      id,
      runs: row,
      text: joinRuns(row),
      ...box,
      baseline: median(row.map((run) => run.baseline)),
      fontSize: median(row.map((run) => run.fontSize)),
    };
  });
}

function joinRuns(runs: TextRun[]): string {
  let output = '';
  let previous: TextRun | undefined;
  for (const run of runs) {
    if (previous) {
      const gap = run.x0 - previous.x1;
      const averageGlyph = previous.x1 > previous.x0
        ? (previous.x1 - previous.x0) / Math.max(1, Array.from(previous.text).length)
        : previous.fontSize * 0.5;
      if (gap > Math.max(1, averageGlyph * 0.45) && needsWordSpace(previous.text, run.text)) output += ' ';
    }
    output += run.text;
    previous = run;
  }
  return output.trim();
}

function readingOrder(lines: TextLine[], pageWidth: number): TextLine[] {
  if (lines.length < 4 || pageWidth <= 0) return [...lines].sort(topDown);
  let bestGap: number | null = null;
  let bestScore = 0;
  for (let ratio = 0.25; ratio <= 0.75; ratio += 0.02) {
    const x = pageWidth * ratio;
    const crossing = lines.filter((line) => line.x0 < x && line.x1 > x).length;
    const left = lines.filter((line) => line.x1 <= x).length;
    const right = lines.filter((line) => line.x0 >= x).length;
    if (left < 2 || right < 2 || crossing / lines.length > 0.2) continue;
    const score = Math.min(left, right) - crossing * 2;
    if (score > bestScore) {
      bestScore = score;
      bestGap = x;
    }
  }
  if (bestGap === null) return [...lines].sort(topDown);

  const spanning = lines.filter((line) => line.x0 < bestGap! && line.x1 > bestGap!).sort(topDown);
  const ordered: TextLine[] = [];
  let upper = Number.POSITIVE_INFINITY;
  for (const divider of [...spanning, undefined]) {
    const lower = divider?.baseline ?? Number.NEGATIVE_INFINITY;
    const band = lines.filter((line) => !spanning.includes(line) && line.baseline < upper && line.baseline > lower);
    ordered.push(...band.filter((line) => line.x1 <= bestGap!).sort(topDown));
    ordered.push(...band.filter((line) => line.x0 >= bestGap!).sort(topDown));
    if (divider) ordered.push(divider);
    upper = lower;
  }
  return ordered;
}

function groupParagraphs(lines: TextLine[]): TextLine[][] {
  const groups: TextLine[][] = [];
  for (const line of lines) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    if (!current || !previous || startsNewParagraph(previous, line)) groups.push([line]);
    else current.push(line);
  }
  return groups;
}

function startsNewParagraph(previous: TextLine, next: TextLine): boolean {
  const verticalGap = previous.y0 - next.y1;
  const lineHeight = Math.max(previous.fontSize, next.fontSize, 1);
  if (verticalGap > lineHeight * 1.25 || verticalGap < -lineHeight) return true;
  if (Math.abs(previous.fontSize - next.fontSize) > lineHeight * 0.22) return true;
  if (Math.abs(previous.x0 - next.x0) > lineHeight * 2.5) return true;
  if (/[。！？.!?;；:]$/u.test(previous.text) && next.text.length < 90) return true;
  return false;
}

function joinParagraphLines(lines: TextLine[]): string {
  let output = '';
  for (const line of lines) {
    if (!output) {
      output = line.text;
      continue;
    }
    if (/[-‐‑]$/u.test(output) && /^[a-z]/u.test(line.text)) output = output.slice(0, -1) + line.text;
    else if (needsWordSpace(output, line.text)) output += ` ${line.text}`;
    else output += line.text;
  }
  return output.trim();
}

function detectTables(lines: TextLine[], pageWidth: number): Array<{ lines: TextLine[]; rows: string[][]; confidence: number }> {
  const candidates = [...lines].sort(topDown).map((line) => ({ line, cells: tableCells(line) }));
  const groups: Array<Array<{ line: TextLine; cells: Array<{ text: string; x: number }> }>> = [];
  let current: Array<{ line: TextLine; cells: Array<{ text: string; x: number }> }> = [];
  for (const candidate of candidates) {
    const previous = current.at(-1);
    const aligned = previous && candidate.cells.length >= 2
      && Math.abs(previous.line.baseline - candidate.line.baseline) <= Math.max(previous.line.fontSize, candidate.line.fontSize) * 3
      && alignedColumns(previous.cells, candidate.cells, pageWidth);
    if (candidate.cells.length >= 2 && (!previous || aligned)) current.push(candidate);
    else {
      if (isTableGroup(current)) groups.push(current);
      current = candidate.cells.length >= 2 ? [candidate] : [];
    }
  }
  if (isTableGroup(current)) groups.push(current);
  return groups.map((group) => ({
    lines: group.map((entry) => entry.line),
    rows: group.map((entry) => entry.cells.map((cell) => cell.text)),
    confidence: Math.min(0.95, 0.65 + group.length * 0.05),
  }));
}

function tableCells(line: TextLine): Array<{ text: string; x: number }> {
  if (line.runs.length < 2) return [];
  const cells: Array<{ text: string; x: number }> = [];
  let text = line.runs[0]!.text;
  let x = line.runs[0]!.x0;
  let previous = line.runs[0]!;
  for (const run of line.runs.slice(1)) {
    const gap = run.x0 - previous.x1;
    if (gap > Math.max(previous.fontSize, run.fontSize) * 1.5) {
      cells.push({ text: text.trim(), x });
      text = run.text;
      x = run.x0;
    } else {
      text += needsWordSpace(text, run.text) ? ` ${run.text}` : run.text;
    }
    previous = run;
  }
  cells.push({ text: text.trim(), x });
  return cells.filter((cell) => cell.text.length > 0);
}

function alignedColumns(a: Array<{ x: number }>, b: Array<{ x: number }>, pageWidth: number): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  const tolerance = Math.max(8, pageWidth * 0.035);
  const matches = a.filter((left) => b.some((right) => Math.abs(left.x - right.x) <= tolerance)).length;
  return matches >= Math.min(2, a.length, b.length);
}

function isTableGroup(group: Array<{ cells: Array<{ text: string }> }>): boolean {
  if (group.length < 2) return false;
  const maxColumns = Math.max(...group.map((entry) => entry.cells.length));
  if (maxColumns < 3) return false;
  return group.length >= 3 || group.some((entry) =>
    entry.cells.some((cell) => /\d/u.test(cell.text))
  );
}

function looksLikeFormula(text: string): boolean {
  const semanticText = text.replace(/_{4,}/gu, '');
  const mathSymbols = semanticText.match(/[=≈≠≤≥±×÷∑∏∫√∞∂∆∇^_{}]/gu)?.length ?? 0;
  const greek = semanticText.match(/[α-ωΑ-Ω]/gu)?.length ?? 0;
  const superscript = semanticText.match(/[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/gu)?.length ?? 0;
  const words = semanticText.match(/[\p{L}]+/gu)?.length ?? 0;
  return semanticText.length <= 240 && (mathSymbols + greek + superscript >= 2 || (mathSymbols >= 1 && words <= 4));
}

function tableMarkdown(rows: string[][]): string {
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) return '';
  const padded = rows.map((row) => Array.from({ length: width }, (_, index) => escapeCell(row[index] ?? '')));
  const header = padded[0]!;
  return [
    `|${header.join('|')}|`,
    `|${header.map(() => '---').join('|')}|`,
    ...padded.slice(1).map((row) => `|${row.join('|')}|`),
  ].join('\n');
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function bounds(items: Array<{ x0: number; y0: number; x1: number; y1: number }>) {
  return {
    x0: Math.min(...items.map((item) => item.x0)),
    y0: Math.min(...items.map((item) => item.y0)),
    x1: Math.max(...items.map((item) => item.x1)),
    y1: Math.max(...items.map((item) => item.y1)),
  };
}

function normalizeBox(box: { x0: number; y0: number; x1: number; y1: number }, width: number, height: number): NormalizedBBox {
  const safeWidth = Math.max(width, 1);
  const safeHeight = Math.max(height, 1);
  return normalizedBBox(
    clamp(box.x0 / safeWidth), clamp(box.y0 / safeHeight),
    clamp(box.x1 / safeWidth), clamp(box.y1 / safeHeight),
  );
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function topDown(a: TextLine, b: TextLine): number {
  return b.baseline - a.baseline || a.x0 - b.x0;
}

function needsWordSpace(left: string, right: string): boolean {
  return /[\p{L}\p{N})\]]$/u.test(left) && /^[\p{L}\p{N}([]/u.test(right)
    && !(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(left)
      && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(right));
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

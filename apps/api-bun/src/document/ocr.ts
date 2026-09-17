// 移植自 apps/api-rs/src/document/ocr.rs —— 行为对齐 Rust 原版，错误信息保持一致

// Tesseract TSV 解析：level=5 的 word 行按 (block_num, paragraph_num) 聚合成段落块，
// 输出归一化 bbox（原点在左下，与 PDF 坐标系一致）。

import { normalizedBBox, type NormalizedBBox } from '../models/source_anchor.ts';
import { rustLines, trimRust } from './text_utils.ts';

export interface OcrTextBlock {
  text: string;
  bbox: NormalizedBBox;
  confidence: number;
}

export interface OcrPage {
  blocks: OcrTextBlock[];
  mean_confidence: number;
}

interface BlockAccumulator {
  words: string[];
  left: number;
  top: number;
  right: number;
  bottom: number;
  confidences: number[];
}

function newAccumulator(left: number, top: number, width: number, height: number): BlockAccumulator {
  return {
    words: [],
    left,
    top,
    right: left + width,
    bottom: top + height,
    confidences: [],
  };
}

function pushWord(
  accumulator: BlockAccumulator,
  text: string,
  left: number,
  top: number,
  width: number,
  height: number,
  confidence: number,
): void {
  accumulator.words.push(text);
  accumulator.left = Math.min(accumulator.left, left);
  accumulator.top = Math.min(accumulator.top, top);
  accumulator.right = Math.max(accumulator.right, left + width);
  accumulator.bottom = Math.max(accumulator.bottom, top + height);
  accumulator.confidences.push(confidence);
}

export function parseTesseractTsv(tsv: string): OcrPage {
  let pageWidth = 0;
  let pageHeight = 0;
  const groups = new Map<string, { key: [number, number]; accumulator: BlockAccumulator }>();

  const lines = rustLines(tsv);
  for (const line of lines.slice(1)) {
    const columns = splitN(line, '\t', 12);
    if (columns.length !== 12) continue;
    const level = parseI32(columns[0]!);
    const blockNum = parseI32(columns[2]!);
    const paragraphNum = parseI32(columns[3]!);
    const left = parseI32(columns[6]!);
    const top = parseI32(columns[7]!);
    const width = parseI32(columns[8]!);
    const height = parseI32(columns[9]!);
    if (level === 1) {
      pageWidth = width;
      pageHeight = height;
      continue;
    }
    if (level !== 5) continue;
    const text = trimRust(columns[11]!);
    const confidence = parseConfidence(columns[10]!);
    if (text.length === 0 || confidence < 0.0 || width <= 0 || height <= 0) continue;
    const key = `${blockNum}:${paragraphNum}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      const accumulator = newAccumulator(left, top, width, height);
      pushWord(accumulator, text, left, top, width, height, confidence);
      groups.set(key, { key: [blockNum, paragraphNum], accumulator });
    } else {
      pushWord(existing.accumulator, text, left, top, width, height, confidence);
    }
  }

  if (pageWidth <= 0 || pageHeight <= 0) {
    throw new Error('tesseract_tsv_page_dimensions_missing');
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.key[0] !== b.key[0]) return a.key[0] - b.key[0];
    return a.key[1] - b.key[1];
  });
  const blocks: OcrTextBlock[] = [];
  for (const entry of ordered) {
    const group = entry.accumulator;
    if (group.words.length === 0) continue;
    const confidence = group.confidences.reduce((sum, value) => sum + value, 0) / group.confidences.length;
    const x0 = group.left / pageWidth;
    const x1 = group.right / pageWidth;
    const y0 = 1.0 - group.bottom / pageHeight;
    const y1 = 1.0 - group.top / pageHeight;
    blocks.push({
      text: group.words.join(' '),
      bbox: normalizedBBox(clamp01(x0), clamp01(y0), clamp01(x1), clamp01(y1)),
      confidence,
    });
  }
  const meanConfidence = blocks.length === 0
    ? 0.0
    : blocks.reduce((sum, block) => sum + block.confidence, 0) / blocks.length;
  return { blocks, mean_confidence: meanConfidence };
}

function clamp01(value: number): number {
  return Math.min(1.0, Math.max(0.0, value));
}

/** 对齐 Rust str::splitn(12, '\t')：最多 12 段，最后一段保留剩余内容（含制表符） */
function splitN(value: string, separator: string, limit: number): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < limit - 1; i += 1) {
    const index = value.indexOf(separator, start);
    if (index < 0) break;
    parts.push(value.slice(start, index));
    start = index + separator.length;
  }
  parts.push(value.slice(start));
  return parts;
}

function parseI32(value: string): number {
  if (!/^[+-]?\d+$/.test(value)) {
    throw new Error(`invalid_tesseract_tsv_integer:${value}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < -2147483648 || parsed > 2147483647) {
    throw new Error(`invalid_tesseract_tsv_integer:${value}`);
  }
  return parsed;
}

/** 对齐 Rust f64::from_str：解析失败回退 -1.0 */
function parseConfidence(value: string): number {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return -1.0;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? -1.0 : parsed;
}

// 移植自 apps/api-rs/src/document/quality.rs —— 行为对齐 Rust 原版，错误信息保持一致

// 文档质量评分：文本量、可读性、结构、锚点覆盖、页覆盖率与警告惩罚

import { charCount } from './text_utils.ts';
import type { ParsedDocument } from './types.ts';

export function scoreQuality(parsed: ParsedDocument): number {
  if (parsed.blocks.length === 0) return 0.2;
  const charTotal = parsed.blocks.reduce((sum, block) => sum + charCount(block.text), 0);
  const textScore = charTotal >= 500 ? 0.95
    : charTotal >= 100 ? 0.8
      : charTotal >= 20 ? 0.55
        : 0.25;
  let invalidChars = 0;
  for (const block of parsed.blocks) {
    for (const ch of block.text) {
      if (isInvalidChar(ch)) invalidChars += 1;
    }
  }
  let legibilityScore: number;
  if (charTotal === 0) {
    legibilityScore = 0.0;
  } else {
    const invalidRatio = invalidChars / charTotal;
    legibilityScore = invalidRatio >= 0.1 ? 0.15
      : invalidRatio >= 0.02 ? 0.55
        : 1.0;
  }
  const structureScore = parsed.tables.length === 0
    && !parsed.blocks.some((block) => block.block_type === 'heading')
    ? 0.7
    : 0.95;
  const anchoredBlocks = parsed.blocks.filter((block) => block.anchor_ids.length > 0).length;
  const anchorScore = anchoredBlocks / parsed.blocks.length;
  let pageScore = 1.0;
  if (parsed.pages !== null) {
    if (parsed.pages <= 0) {
      pageScore = 0.0;
    } else {
      const covered = new Set<number>();
      for (const block of parsed.blocks) {
        const marker = block.page_start ?? block.slide_index;
        if (marker !== null) covered.add(marker);
      }
      pageScore = Math.min(1.0, Math.max(0.0, covered.size / parsed.pages));
    }
  }
  const warningPenalty = qualityWarningPenalty(parsed.warnings);
  const score = 0.3 * textScore
    + 0.2 * legibilityScore
    + 0.15 * structureScore
    + 0.2 * anchorScore
    + 0.15 * pageScore
    - warningPenalty;
  return Math.min(1.0, Math.max(0.0, score));
}

function isInvalidChar(ch: string): boolean {
  const codePoint = ch.codePointAt(0)!;
  if (codePoint === 0xfffd) return true;
  // Rust char::is_control：Cc 类别
  if ((codePoint >= 0x00 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f)) {
    return !['\n', '\r', '\t'].includes(ch);
  }
  if (codePoint >= 0xe000 && codePoint <= 0xf8ff) return true;
  if (codePoint >= 0xf0000 && codePoint <= 0xffffd) return true;
  if (codePoint >= 0x100000 && codePoint <= 0x10fffd) return true;
  return false;
}

function qualityWarningPenalty(warnings: string[]): number {
  let penalty = warnings.length * 0.02;
  for (const warning of warnings) {
    if (warning === 'scanned_pdf_no_text_layer') {
      penalty += 0.4;
    } else if (warning.startsWith('pdf_partial_text_layer:')) {
      const ratio = warning.slice('pdf_partial_text_layer:'.length);
      const slash = ratio.indexOf('/');
      let missingRatio = 0.0;
      if (slash >= 0) {
        const missing = Number.parseFloat(ratio.slice(0, slash));
        const total = Number.parseFloat(ratio.slice(slash + 1));
        if (Number.isFinite(missing) && Number.isFinite(total) && total !== 0) {
          missingRatio = missing / total;
        }
      }
      penalty += missingRatio >= 0.15 ? 0.15 : 0.05;
    }
  }
  return Math.min(penalty, 0.5);
}

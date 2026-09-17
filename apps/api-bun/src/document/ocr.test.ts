// 移植自 apps/api-rs/src/document/ocr.rs #[cfg(test)]
import { describe, expect, test } from 'bun:test';

import { parseTesseractTsv } from './ocr.ts';

describe('parseTesseractTsv', () => {
  test('parses words into paragraph bbox', () => {
    const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n'
      + '1\t1\t0\t0\t0\t0\t0\t0\t1000\t2000\t-1\t\n'
      + '5\t1\t1\t1\t1\t1\t100\t200\t120\t40\t90.0\tDocuMind\n'
      + '5\t1\t1\t1\t1\t2\t240\t200\t80\t40\t80.0\tOCR\n';
    const page = parseTesseractTsv(tsv);

    expect(page.blocks.length).toBe(1);
    expect(page.blocks[0]!.text).toBe('DocuMind OCR');
    expect(page.mean_confidence).toBe(85.0);
    expect(Math.abs(page.blocks[0]!.bbox.x0 - 0.1)).toBeLessThan(0.0001);
    expect(Math.abs(page.blocks[0]!.bbox.y0 - 0.88)).toBeLessThan(0.0001);
  });

  test('rejects tsv without page dimensions', () => {
    expect(() => parseTesseractTsv('level\ttext\n')).toThrow('tesseract_tsv_page_dimensions_missing');
  });
});

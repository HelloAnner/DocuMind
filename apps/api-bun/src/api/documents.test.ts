// 移植自 apps/api-rs/src/api/documents.rs 的 #[cfg(test)] 用例
import { describe, expect, test } from 'bun:test';
import type { EmbeddingConfig } from '../config.ts';
import type { ParseJobTask } from './documents_types.ts';
import {
  canExcludeFromSearch, canMoveDocument, canReplaceFile, canSendToOcr, currentParserConfig,
  parseIdentityFor, parseStatusForQuality, parseStatusForResult, sha256Hex, titleFromFileName,
} from './documents_support.ts';
import {
  buildParseArtifacts, interruptedDocumentFinalStatus, parseFailedMetadata, parseRunningMetadata,
} from './documents_parse.ts';
import { extractSinglePagePdf, pdfPageCount } from './documents_pdf_page.ts';

function testEmbeddingConfig(): EmbeddingConfig {
  return {
    model: 'text-embedding-v3', baseUrl: 'http://localhost:11434/v1', apiKey: 'test',
    batchSize: 2, dimension: 1024, retryMax: 3, workerPollMs: 1000,
    indexSchemaVersion: 2, indexName: 'chunks', indexAlias: 'chunks_search', enabled: false,
  };
}

function testTask(fileName: string, text: string): ParseJobTask {
  const fileSha256 = sha256Hex(text);
  const parserConfig = currentParserConfig();
  return {
    tenant_id: crypto.randomUUID(), kb_id: crypto.randomUUID(), doc_id: crypto.randomUUID(),
    parse_job_id: crypto.randomUUID(), parse_version: 1,
    title: titleFromFileName(fileName), file_name: fileName,
    mime_type: 'text/plain', file_type: 'txt',
    parser_config: parserConfig, parse_identity: parseIdentityFor(fileSha256, parserConfig),
    bytes: new TextEncoder().encode(text), embedding_config: testEmbeddingConfig(),
    force_index: false,
  };
}

function pdfTask(fileName: string, bytes: Uint8Array): ParseJobTask {
  const fileSha256 = sha256Hex(bytes);
  const parserConfig = currentParserConfig();
  return {
    tenant_id: crypto.randomUUID(), kb_id: crypto.randomUUID(), doc_id: crypto.randomUUID(),
    parse_job_id: crypto.randomUUID(), parse_version: 1,
    title: titleFromFileName(fileName), file_name: fileName,
    mime_type: 'application/pdf', file_type: 'pdf',
    parser_config: parserConfig, parse_identity: parseIdentityFor(fileSha256, parserConfig),
    bytes, embedding_config: testEmbeddingConfig(), force_index: false,
  };
}

function encode(text: string): Uint8Array { return new TextEncoder().encode(text); }

/** Rust 测试 helper: blank_pdf_with_pages（无文本层 PDF） */
function blankPdfWithPages(pageCount: number): Uint8Array {
  const pageNums: number[] = [];
  for (let i = 0; i < pageCount; i += 1) pageNums.push(3 + i * 2);
  const objs: string[] = [];
  objs[0] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  objs[1] = `2 0 obj\n<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageCount} >>\nendobj\n`;
  for (const pageNum of pageNums) {
    const contentNum = pageNum + 1;
    objs[pageNum - 1] = `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents ${contentNum} 0 R >>\nendobj\n`;
    objs[contentNum - 1] = `${contentNum} 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n`;
  }
  return assemblePdf(objs);
}

function singlePagePdfWithText(text: string): Uint8Array {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escaped}) Tj\nET`;
  return assemblePdf([
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ]);
}

function assemblePdf(objects: string[]): Uint8Array {
  const parts: Uint8Array[] = [encode('%PDF-1.4\n')];
  let offset = parts[0]!.length;
  const offsets: number[] = [];
  for (const object of objects) {
    if (typeof object !== 'string') throw new Error('test pdf has a hole in object numbering');
    offsets.push(offset);
    const bytes = encode(object);
    parts.push(bytes);
    offset += bytes.length;
  }
  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const entry of offsets) xref += `${String(entry).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(encode(xref));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) { out.set(part, cursor); cursor += part.length; }
  return out;
}

describe('documents state predicates', () => {
  test('only_stable_documents_can_move_between_knowledge_bases', () => {
    for (const status of ['parsed', 'cleaned', 'indexed', 'parse_low_confidence', 'parse_failed',
      'embedding_failed', 'excluded_from_search']) {
      expect(canMoveDocument(status)).toBe(true);
    }
    for (const status of ['uploaded', 'parsing', 'chunked', 'embedding', 'ocr_pending']) {
      expect(canMoveDocument(status)).toBe(false);
    }
  });

  test('exclude_from_search_only_allows_terminal_document_states', () => {
    for (const status of ['indexed', 'parse_low_confidence', 'parse_failed', 'embedding_failed']) {
      expect(canExcludeFromSearch(status)).toBe(true);
    }
    for (const status of ['uploaded', 'parsing', 'chunked', 'embedding', 'deleted']) {
      expect(canExcludeFromSearch(status)).toBe(false);
    }
  });

  test('replace_file_only_allows_terminal_document_states', () => {
    for (const status of ['indexed', 'parse_low_confidence', 'parse_failed', 'embedding_failed',
      'excluded_from_search']) {
      expect(canReplaceFile(status)).toBe(true);
    }
    for (const status of ['uploaded', 'parsing', 'chunked', 'embedding', 'deleted']) {
      expect(canReplaceFile(status)).toBe(false);
    }
  });

  test('send_to_ocr_only_allows_low_confidence_documents', () => {
    expect(canSendToOcr('parse_low_confidence')).toBe(true);
    for (const status of ['indexed', 'parse_failed', 'embedding_failed', 'ocr_pending', 'uploaded',
      'parsing', 'deleted']) {
      expect(canSendToOcr(status)).toBe(false);
    }
  });
});

describe('documents parse status', () => {
  test('completed_ocr_uses_quality_gate_instead_of_original_text_layer_warning', () => {
    expect(parseStatusForResult(0.89, true, true)).toBe('chunked');
    expect(parseStatusForResult(0.89, true, false)).toBe('parse_low_confidence');
  });

  test('interrupted_document_final_status_is_retryable_and_explainable', () => {
    expect(interruptedDocumentFinalStatus('embedding', 'parse')).toBe('embedding_failed');
    expect(interruptedDocumentFinalStatus('ocr_pending', 'ocr')).toBe('parse_low_confidence');
    expect(interruptedDocumentFinalStatus('parsing', 'ocr')).toBe('parse_low_confidence');
    expect(interruptedDocumentFinalStatus('parsing', 'parse')).toBe('parse_failed');
    expect(interruptedDocumentFinalStatus('uploaded', 'parse')).toBe('parse_failed');
  });

  test('non_ocr_parse_metadata_does_not_clear_ocr_status', () => {
    const task = testTask('normal.txt', '普通解析任务');
    const running = parseRunningMetadata(task);
    const failed = parseFailedMetadata(task, 'PARSE_FAILED', '解析失败');
    expect(running['ocr_status']).toBeUndefined();
    expect(failed['ocr_status']).toBeUndefined();
    expect(running['parse_progress']).toBe(30);
  });

  test('ocr_parse_metadata_sets_explicit_ocr_status', () => {
    const task = pdfTask('scan.pdf', encode('%PDF-1.4\n%%EOF'));
    task.parser_config = { ...task.parser_config, job_kind: 'ocr' };
    const running = parseRunningMetadata(task);
    const failed = parseFailedMetadata(task, 'OCR_FAILED', 'OCR failed');
    expect(running['ocr_status']).toBe('running');
    expect(failed['ocr_status']).toBe('failed');
    expect(running['parse_progress']).toBe(45);
  });
});

describe('documents parse artifacts', () => {
  test('short_parse_is_low_confidence_and_not_indexed', async () => {
    const artifacts = await buildParseArtifacts(testTask('short.txt', '短文本'));
    expect(artifacts.parse_status).toBe('parse_low_confidence');
    expect(artifacts.quality_score).toBeGreaterThanOrEqual(0.55);
    expect(artifacts.bundle.chunks.length).toBe(1);
  });

  test('long_parse_is_chunked', async () => {
    const text = '付款节点包括首付款、验收款和质保金。'.repeat(80);
    const artifacts = await buildParseArtifacts(testTask('long.txt', text));
    expect(artifacts.parse_status).toBe('chunked');
    expect(artifacts.quality_score).toBeGreaterThanOrEqual(0.75);
    expect((artifacts.bundle.clean_stats as { output_blocks: number }).output_blocks).toBeGreaterThan(0);
  });

  test('pending_identity_matches_completed_artifacts', async () => {
    const text = '付款节点包括首付款、验收款和质保金。'.repeat(80);
    const fileSha256 = sha256Hex(text);
    const pendingIdentity = parseIdentityFor(fileSha256, currentParserConfig());
    const artifacts = await buildParseArtifacts(testTask('identity.txt', text));
    expect(artifacts.parse_identity).toBe(pendingIdentity);
    expect(artifacts.parse_status).toBe('chunked');
  });

  test('scanned_pdf_without_text_layer_is_low_confidence_not_failed', async () => {
    const artifacts = await buildParseArtifacts(pdfTask('scanned.pdf', blankPdfWithPages(1)));
    expect(artifacts.parse_status).toBe('parse_low_confidence');
    expect(artifacts.bundle.chunks.length).toBe(0);
    expect(artifacts.bundle.parsed.warnings).toContain('scanned_pdf_no_text_layer');
  });

  test('force_index_converts_low_confidence_with_chunks_to_chunked', async () => {
    const task = testTask('short.txt', '短文本');
    task.force_index = true;
    const artifacts = await buildParseArtifacts(task);
    expect(artifacts.parse_status).toBe('chunked');
    expect(artifacts.bundle.chunks.length).toBe(1);
    expect(artifacts.parser_config['force_index']).toBe(true);
  });

  test('force_index_rejects_scanned_pdf_without_chunks', async () => {
    const task = pdfTask('scanned.pdf', blankPdfWithPages(1));
    task.force_index = true;
    let code = '';
    let message = '';
    try {
      await buildParseArtifacts(task);
      throw new Error('force_index should reject scanned PDF without chunks');
    } catch (error) {
      const appError = error as { code?: string; message: string };
      code = appError.code ?? '';
      message = appError.message;
    }
    expect(code).toBe('FORCE_INDEX_UNAVAILABLE');
    expect(message).toContain('没有有效切片');
  });

  test('parse_status_for_quality_rejects_too_low_scores', () => {
    expect(parseStatusForQuality(0.75)).toBe('chunked');
    expect(parseStatusForQuality(0.55)).toBe('parse_low_confidence');
    expect(() => parseStatusForQuality(0.2)).toThrow();
  });
});

describe('documents pdf page extraction', () => {
  test('counts_pages_and_slices_single_page', () => {
    const twoPages = new Uint8Array(blankPdfWithPages(2));
    expect(pdfPageCount(twoPages)).toBe(2);

    const extracted = extractSinglePagePdf(twoPages, 2);
    expect(extracted.totalPages).toBe(2);
    expect(pdfPageCount(extracted.bytes)).toBe(1);

    const withText = new Uint8Array(singlePagePdfWithText('DocuMind'));
    expect(pdfPageCount(withText)).toBe(1);
    expect(() => extractSinglePagePdf(withText, 3)).toThrow('page 3 out of range (1-1)');
  });
});
// 移植自 apps/api-rs/src/api/documents.rs 的 build_ocr_bundle / build_ocr_bundle_in_dir
// Tesseract TSV 解析复用 src/document/ocr.ts（与 Rust document::ocr::parse_tesseract_tsv 对齐）。
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../errors.ts';
import { cleanBlocks } from '../document/cleaning.ts';
import type { CleanedBlock, CleanStats } from '../document/cleaning.ts';
import { chunkBlocks } from '../document/chunking/mod.ts';
import type { ChunkConfig } from '../document/chunking/mod.ts';
import type { ParsedBlock, ParsedBundle, ParsedDocument } from '../document/types.ts';
import type { SourceAnchor } from '../models/source_anchor.ts';
import { sourceAnchorForPdfParagraph } from '../models/source_anchor.ts';
import { OCR_RENDER_DPI } from './documents_types.ts';
import type { ParseJobTask } from './documents_types.ts';
import { currentParserConfig, sha256Hex } from './documents_support.ts';
import { parseTesseractTsv } from '../document/ocr.ts';

interface SpawnOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

async function runCommand(command: string[], notFound: (message: string) => AppError): Promise<SpawnOutput> {
  let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  } catch (error) {
    throw notFound((error as Error).message);
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { success: code === 0, stdout, stderr };
}

/** Rust: build_ocr_bundle */
export async function buildOcrBundle(task: ParseJobTask): Promise<ParsedBundle> {
  const workDir = join(tmpdir(), `documind-ocr-${task.parse_job_id}`);
  await rm(workDir, { recursive: true, force: true });
  try {
    await mkdir(workDir, { recursive: true });
  } catch (error) {
    throw AppError.internal(`failed to create ocr work dir: ${(error as Error).message}`);
  }
  try {
    return await buildOcrBundleInDir(task, workDir);
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`failed to cleanup OCR work dir ${workDir}: ${(error as Error).message}`);
    }
  }
}

async function buildOcrBundleInDir(task: ParseJobTask, workDir: string): Promise<ParsedBundle> {
  const inputPdf = join(workDir, 'source.pdf');
  try {
    await writeFile(inputPdf, task.bytes);
  } catch (error) {
    throw AppError.internal(`failed to write ocr source pdf: ${(error as Error).message}`);
  }

  const prefix = join(workDir, 'page');
  const render = await runCommand(
    ['pdftoppm', '-r', String(OCR_RENDER_DPI), '-png', inputPdf, prefix],
    (message) => AppError.badRequest('OCR_RENDER_UNAVAILABLE', `无法执行 pdftoppm，请检查 OCR 依赖: ${message}`),
  );
  if (!render.success) {
    throw AppError.badRequest('OCR_RENDER_FAILED', `PDF 转图片失败: ${render.stderr}`);
  }

  let entries: string[];
  try {
    entries = await readdir(workDir);
  } catch (error) {
    throw AppError.internal(`failed to list ocr pages: ${(error as Error).message}`);
  }
  const pageImages = entries.filter((name) => name.endsWith('.png')).sort();
  if (pageImages.length === 0) {
    throw AppError.badRequest('OCR_RENDER_EMPTY', 'PDF 未能渲染出可 OCR 的页面');
  }

  const blocks: ParsedBlock[] = [];
  const anchors: SourceAnchor[] = [];
  const warnings = ['ocr_generated', 'scanned_pdf_no_text_layer'];
  let emptyPages = 0;
  const pageConfidences: number[] = [];

  for (let pageIdx = 0; pageIdx < pageImages.length; pageIdx += 1) {
    const page = pageIdx + 1;
    const imagePath = join(workDir, pageImages[pageIdx]!);
    const output = await runCommand(
      ['tesseract', imagePath, 'stdout', '-l', 'chi_sim+eng', '--psm', '3', 'tsv'],
      (message) => AppError.badRequest('OCR_ENGINE_UNAVAILABLE', `无法执行 tesseract，请检查 OCR 依赖: ${message}`),
    );
    if (!output.success) {
      throw AppError.badRequest('OCR_ENGINE_FAILED', `Tesseract OCR 失败: ${output.stderr}`);
    }
    let ocrPage: import('../document/ocr.ts').OcrPage;
    try {
      ocrPage = parseTesseractTsv(output.stdout);
    } catch (error) {
      throw AppError.badRequest(
        'OCR_OUTPUT_INVALID', `Tesseract OCR 输出无效: ${(error as Error).message}`);
    }
    if (ocrPage.blocks.length === 0) {
      emptyPages += 1;
      warnings.push(`ocr_page_${page}_empty`);
      continue;
    }
    pageConfidences.push(ocrPage.mean_confidence);

    for (let paragraphIdx = 0; paragraphIdx < ocrPage.blocks.length; paragraphIdx += 1) {
      const ocrBlock = ocrPage.blocks[paragraphIdx]!;
      const blockId = crypto.randomUUID();
      const anchor = sourceAnchorForPdfParagraph(
        task.doc_id, task.parse_job_id, task.tenant_id, blockId, page,
        ocrBlock.text, ocrBlock.bbox,
      );
      anchors.push(anchor);
      blocks.push({
        block_id: blockId,
        block_index: blocks.length,
        block_type: 'paragraph',
        text: ocrBlock.text,
        heading_level: null,
        heading_path: [],
        page_start: page,
        page_end: page,
        slide_index: null,
        table_id: null,
        bbox: ocrBlock.bbox,
        anchor_ids: [anchor.anchor_id],
        source_ref: { format: 'pdf', page, paragraph: paragraphIdx + 1, source: 'ocr' },
        metadata: {
          layout: 'ocr',
          ocr_engine: 'tesseract',
          ocr_render_dpi: OCR_RENDER_DPI,
          ocr_confidence: ocrBlock.confidence,
        },
      });
    }
  }

  if (blocks.length === 0) {
    throw AppError.badRequest('OCR_EMPTY_TEXT', 'OCR 未能识别出可检索文本');
  }

  const meanConfidence = pageConfidences.reduce((sum, value) => sum + value, 0)
    / Math.max(1, pageConfidences.length);
  const pageCoverage = (pageImages.length - emptyPages) / pageImages.length;
  const qualityScore = Math.min(1, Math.max(0, 0.65 * (meanConfidence / 100.0) + 0.35 * pageCoverage));
  if (meanConfidence < 70.0) warnings.push(`ocr_low_confidence:${meanConfidence.toFixed(2)}`);

  const parsed: ParsedDocument = {
    doc_id: task.doc_id,
    parse_job_id: task.parse_job_id,
    file_type: 'pdf',
    title: task.title,
    pages: pageImages.length,
    blocks,
    tables: [],
    anchors,
    warnings,
    quality_score: qualityScore,
  };
  const [cleanedBlocks, cleanStats] = cleanBlocks('pdf', parsed.blocks) as [CleanedBlock[], CleanStats];
  const parserConfig = currentParserConfig();
  const chunkConfig: ChunkConfig = {
    target_chunk_tokens: parserConfig['target_chunk_tokens'] as number,
    max_chunk_tokens: parserConfig['max_chunk_tokens'] as number,
    hard_split_tokens: parserConfig['hard_split_tokens'] as number,
    min_chunk_tokens: parserConfig['min_chunk_tokens'] as number,
    overlap_tokens: parserConfig['chunk_overlap_tokens'] as number,
    max_table_rows_per_chunk: parserConfig['max_table_rows_per_chunk'] as number,
    max_table_token_per_chunk: parserConfig['max_table_token_per_chunk'] as number,
  };
  const chunks = chunkBlocks('pdf', task.kb_id, task.parse_job_id, cleanedBlocks, chunkConfig);
  if (chunks.length === 0) {
    throw AppError.badRequest('OCR_EMPTY_CHUNKS', 'OCR 识别成功但没有生成有效切片');
  }

  return {
    file_type: 'pdf',
    file_sha256: sha256Hex(task.bytes),
    parsed,
    cleaned_blocks: cleanedBlocks,
    clean_stats: cleanStats,
    chunks,
  };
}
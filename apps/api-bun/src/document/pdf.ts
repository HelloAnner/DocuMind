// 移植自 apps/api-rs/src/document/pdf.rs —— 行为对齐 Rust 原版，错误信息保持一致

// PDF：pdfjs-dist 逐页取文本层 -> 按空行切段 -> 启发式标题（短行、无句末标点、数字占比低）
// 无文本层的页写入 warnings；整篇无文本时标记 scanned_pdf_no_text_layer（由上层决定是否转 OCR）
//
// Rust 用 pdf_extract、TS 用 pdfjs-dist，两者都只在行末写单个 '\n'（不写空行），
// 因此 split_paragraphs 的「空行分段」在 PDF 上同样折叠为“每页一段”，block/chunk 结构一致。
// 已知差异：1) pdfjs 会丢弃落在页面 MediaBox 之外的字形，pdf_extract 不会；
//          2) pdfjs 的 item.str 只保留内容流里的真实空格，不按几何间距合成空格。

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { newUuid } from '../infra/uuid.ts';
import { NIL_UUID, MAX_PDF_PAGES, MAX_PDF_PAGE_TEXT_CHARS, type ParsedBlock, type ParsedDocument } from './types.ts';
import { sourceAnchorForPdfParagraph, type SourceAnchor } from '../models/source_anchor.ts';
import { splitParagraphs } from './plain_text.ts';
import { finalizeParsed } from './shared.ts';
import { charCount, trimRust } from './text_utils.ts';

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
    const pages = await extractPageTexts(doc);
    if (pages.length > MAX_PDF_PAGES) {
      throw new Error(`pdf_page_count_exceeded:${pages.length}>${MAX_PDF_PAGES}`);
    }

    const blocks: ParsedBlock[] = [];
    const anchors: SourceAnchor[] = [];
    const warnings: string[] = [];
    let currentHeading: string | null = null;
    let pagesWithoutText = 0;

    for (const [pageIdx, pageText] of pages.entries()) {
      const page = pageIdx + 1;
      const pageChars = charCount(pageText);
      if (pageChars > MAX_PDF_PAGE_TEXT_CHARS) {
        throw new Error(`pdf_page_text_chars_exceeded:${page}:${pageChars}>${MAX_PDF_PAGE_TEXT_CHARS}`);
      }
      const paragraphs = splitParagraphs(pageText);
      if (paragraphs.length === 0) {
        pagesWithoutText += 1;
        warnings.push(`pdf_page_${page}_no_text_layer`);
      }

      for (const paragraph of paragraphs) {
        const trimmed = trimRust(paragraph);
        if (trimmed.length === 0) continue;
        const isHeading = looksLikeHeading(trimmed);
        const blockId = newUuid();
        const anchor = sourceAnchorForPdfParagraph(
          docId,
          parseJobId,
          NIL_UUID,
          blockId,
          page,
          trimmed,
          null,
        );
        anchors.push(anchor);
        const headingPath = currentHeading !== null ? [currentHeading] : [];
        blocks.push({
          block_id: blockId,
          block_index: blocks.length,
          block_type: isHeading ? 'heading' : 'paragraph',
          text: trimmed,
          heading_level: isHeading ? 1 : null,
          heading_path: isHeading ? [] : headingPath,
          page_start: page,
          page_end: page,
          slide_index: null,
          table_id: null,
          bbox: null,
          anchor_ids: [anchor.anchor_id],
          source_ref: { format: 'pdf', page },
          metadata: { layout: 'text_layer' },
        });
        if (isHeading) {
          currentHeading = trimmed;
        }
      }
    }

    if (blocks.length === 0) {
      warnings.push('scanned_pdf_no_text_layer');
    } else if (pagesWithoutText > 0) {
      warnings.push(`pdf_partial_text_layer:${pagesWithoutText}/${pages.length}`);
    }

    const parsed = finalizeParsed(docId, parseJobId, 'pdf', title, pages.length, blocks, [], anchors);
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
  const task = getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
  });
  try {
    return { task, doc: await task.promise };
  } catch (error) {
    throw new Error('pdf_text_extract_failed:' + messageOf(error));
  }
}

async function extractPageTexts(doc: { numPages: number; getPage: (pageNumber: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }> }): Promise<string[]> {
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(textContentToText(content.items));
    }
    return pages;
  } catch (error) {
    throw new Error('pdf_text_extract_failed:' + messageOf(error));
  }
}

interface PdfTextItem { str?: unknown; hasEOL?: unknown }

/** 对齐 Rust pdf_extract 的逐行输出：pdfjs 按 hasEOL 补换行 */
function textContentToText(items: unknown[]): string {
  let text = '';
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as PdfTextItem;
    if (typeof candidate.str === 'string') {
      text += candidate.str;
      if (candidate.hasEOL === true) text += '\n';
    }
  }
  return text;
}

function looksLikeHeading(text: string): boolean {
  const length = charCount(text);
  if (length < 2 || length > 80) return false;
  const last = [...text].pop();
  if (last !== undefined && '.。！!？?；;，,'.includes(last)) return false;
  let meaningful = 0;
  let digits = 0;
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) meaningful += 1;
    if (ch >= '0' && ch <= '9') digits += 1;
  }
  return meaningful > 0 && digits * 2 < meaningful;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

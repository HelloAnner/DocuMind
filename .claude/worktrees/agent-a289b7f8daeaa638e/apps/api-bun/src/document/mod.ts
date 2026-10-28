// 移植自 apps/api-rs/src/document/mod.rs —— 行为对齐 Rust 原版，错误信息保持一致

// document 模块入口：文件类型判定、解析 -> 补结构锚点 -> 质量分 -> 清洗 -> 切片，产出 ParsedBundle

import { sourceAnchorStructural } from '../models/source_anchor.ts';
import { chunkBlocks, defaultChunkConfig } from './chunking.ts';
import { cleanBlocks } from './cleaning.ts';
import { parseDocx } from './docx.ts';
import { parseMarkdown } from './markdown.ts';
import { parsePdf } from './pdf.ts';
import { parsePlainText } from './plain_text.ts';
import { parsePptx } from './pptx.ts';
import { scoreQuality } from './quality.ts';
import { zipEntryNames } from './shared.ts';
import { decodeText, hexSha256, looksLikeZip, titleFromFileName } from './text_utils.ts';
import { NIL_UUID, type FileType, type ParsedBundle, type ParsedDocument } from './types.ts';

export * from './types.ts';
export * as cleaning from './cleaning.ts';
export * as chunking from './chunking.ts';
export * as ocr from './ocr.ts';
export { cleanBlocks, CLEANER_VERSION, type CleanedBlock, type CleanStats } from './cleaning.ts';
export { chunkBlocks, defaultChunkConfig, CHUNKER_VERSION, type ChunkConfig } from './chunking.ts';
export { parseDocx } from './docx.ts';
export { parseMarkdown } from './markdown.ts';
export { parsePdf } from './pdf.ts';
export { parsePlainText, splitParagraphs } from './plain_text.ts';
export { parsePptx } from './pptx.ts';
export { scoreQuality } from './quality.ts';
export { estimateTokens, hexSha256, looksLikeZip, titleFromFileName, decodeText } from './text_utils.ts';
export { tableMarkdown } from './shared.ts';

export async function parseDocument(
  docId: string,
  parseJobId: string,
  fileName: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<ParsedBundle> {
  const fileSha256 = hexSha256(bytes);
  const fileType = await detectFileType(fileName, mimeType, bytes);
  const title = titleFromFileName(fileName);
  let parsed: ParsedDocument;
  switch (fileType) {
    case 'pdf':
      parsed = await parsePdf(docId, parseJobId, title, bytes);
      break;
    case 'docx':
      parsed = await parseDocx(docId, parseJobId, title, bytes);
      break;
    case 'pptx':
      parsed = await parsePptx(docId, parseJobId, title, bytes);
      break;
    case 'md':
      parsed = parseMarkdown(docId, parseJobId, title, bytes);
      break;
    case 'txt':
      parsed = parsePlainText(docId, parseJobId, title, bytes);
      break;
    default:
      throw new Error('unsupported_file_type:' + String(fileType));
  }
  attachMissingStructuralAnchors(docId, parseJobId, fileType, parsed);
  parsed.quality_score = scoreQuality(parsed);
  const [cleanedBlocks, cleanStats] = cleanBlocks(fileType, parsed.blocks);
  const chunkCfg = defaultChunkConfig();
  const chunks = chunkBlocks(fileType, NIL_UUID, parseJobId, cleanedBlocks, chunkCfg);
  return {
    file_type: fileType,
    file_sha256: fileSha256,
    parsed,
    cleaned_blocks: cleanedBlocks,
    clean_stats: cleanStats,
    chunks,
  };
}

/** 对齐 Rust attach_missing_structural_anchors：无锚点的块补 structural 锚点 */
function attachMissingStructuralAnchors(
  docId: string,
  parseJobId: string,
  fileType: FileType,
  parsed: ParsedDocument,
): void {
  for (const block of parsed.blocks) {
    if (block.anchor_ids.length > 0) continue;
    const anchor = sourceAnchorStructural(
      docId,
      parseJobId,
      NIL_UUID,
      fileType,
      block.block_type,
      block.block_id,
      block.page_start,
      block.slide_index,
      block.source_ref,
      block.text,
    );
    block.anchor_ids.push(anchor.anchor_id);
    parsed.anchors.push(anchor);
  }
}

export async function detectFileType(
  fileName: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<FileType> {
  const ext = extensionOf(fileName);
  const declared = declaredFromMimeType(mimeType);
  const byExt = fileTypeFromExtension(ext);
  let byHeader: FileType | null = null;
  if (startsWithPdfHeader(bytes)) {
    byHeader = 'pdf';
  } else if (looksLikeZip(bytes)) {
    const entries = await zipEntryNames(bytes);
    if (entries.some((entry) => entry === 'word/document.xml')) {
      byHeader = 'docx';
    } else if (
      entries.some((entry) => entry === 'ppt/presentation.xml')
      && entries.some((entry) => entry.startsWith('ppt/slides/slide'))
    ) {
      byHeader = 'pptx';
    }
  } else if ((byExt === 'md' || byExt === 'txt') && canDecodeText(bytes)) {
    byHeader = byExt;
  }

  if (byHeader === null) {
    throw new Error('unsupported_or_corrupt_file');
  }
  if (byExt !== null && byExt !== byHeader) {
    throw new Error('file_type_mismatch');
  }
  if (declared !== null && declared !== byHeader) {
    throw new Error('file_type_mismatch');
  }
  return byHeader;
}

/** 对齐 Rust file_name.rsplit('.').next()：无点号时整体作为扩展名 */
function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  const raw = index >= 0 ? fileName.slice(index + 1) : fileName;
  return raw.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

function declaredFromMimeType(mimeType: string): FileType | null {
  if (mimeType.includes('pdf')) return 'pdf';
  if (mimeType.includes('wordprocessingml') || mimeType.includes('msword')) return 'docx';
  if (mimeType.includes('presentationml') || mimeType.includes('powerpoint')) return 'pptx';
  if (mimeType.includes('markdown')) return 'md';
  if (mimeType.startsWith('text/plain')) return 'txt';
  return null;
}

function fileTypeFromExtension(ext: string): FileType | null {
  switch (ext) {
    case 'pdf': return 'pdf';
    case 'docx': return 'docx';
    case 'pptx': return 'pptx';
    case 'md':
    case 'markdown': return 'md';
    case 'txt': return 'txt';
    default: return null;
  }
}

function startsWithPdfHeader(bytes: Uint8Array): boolean {
  const prefix = '%PDF-';
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

/** 对齐 Rust text_utils::decode_text(bytes).is_ok() */
function canDecodeText(bytes: Uint8Array): boolean {
  try {
    decodeText(bytes);
    return true;
  } catch {
    return false;
  }
}

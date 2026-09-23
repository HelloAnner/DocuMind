import type JSZip from 'jszip';
import { parseDocument } from '../document/mod.ts';
import { openZip, readZipText } from '../document/shared.ts';
import { attr, childElements, descendants, parseXml, type XmlElement } from '../document/xml.ts';
import { decodeText } from '../document/text_utils.ts';
import { newUuid } from '../infra/uuid.ts';

export const MAX_FILE_CONTEXT_CHARS = 20_000;
export const MAX_TOTAL_FILE_CONTEXT_CHARS = 60_000;
const MAX_XLSX_ROWS = 1_000;
const MAX_XLSX_CELLS = 10_000;
const USER_UPLOAD_TYPES: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export interface ExtractedFileText {
  text: string;
  truncated: boolean;
}

export async function validateUserUpload(
  uploadName: string,
  persistedName: string,
  bytes: Uint8Array,
): Promise<string> {
  const uploadExtension = fileExtension(uploadName);
  const extension = fileExtension(persistedName);
  if (uploadExtension !== extension) {
    throw new Error(`filename_path_extension_mismatch:${uploadExtension || 'none'}:${extension || 'none'}`);
  }
  const mimeType = USER_UPLOAD_TYPES[extension];
  if (!mimeType) throw new Error(`unsupported_user_file_type:${extension || 'none'}`);
  if (['txt', 'md', 'markdown', 'csv', 'json'].includes(extension)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (extension === 'json') JSON.parse(text);
    return mimeType;
  }
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(`invalid_${extension}_signature`);
  }
  const zip = await openZip(bytes);
  const required = extension === 'docx'
    ? 'word/document.xml'
    : extension === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml';
  if (!zip.file('[Content_Types].xml') || !zip.file(required)) {
    throw new Error(`invalid_${extension}_package`);
  }
  parseXml(await readZipText(zip, '[Content_Types].xml'));
  parseXml(await readZipText(zip, required));
  return mimeType;
}

export async function extractUserFileText(
  name: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<ExtractedFileText> {
  const extension = fileExtension(name);
  let text: string;
  if (extension === 'csv' || extension === 'json') {
    text = decodeText(bytes);
  } else if (extension === 'xlsx') {
    text = await extractXlsx(bytes);
  } else if (['txt', 'md', 'markdown', 'docx', 'pptx'].includes(extension)) {
    const bundle = await parseDocument(newUuid(), newUuid(), name, mimeType, bytes);
    text = bundle.parsed.blocks.map((block) => block.text).filter(Boolean).join('\n\n');
  } else {
    throw new Error('unsupported_user_file_type:' + extension);
  }
  if (text.length <= MAX_FILE_CONTEXT_CHARS) return { text, truncated: false };
  const suffix = `\n\n[已截断：单文件上下文最多 ${MAX_FILE_CONTEXT_CHARS} 字符]`;
  return {
    text: text.slice(0, MAX_FILE_CONTEXT_CHARS - suffix.length) + suffix,
    truncated: true,
  };
}

async function extractXlsx(bytes: Uint8Array): Promise<string> {
  const zip = await openZip(bytes);
  const sharedStrings = await loadSharedStrings(zip);
  const sheetNames = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  if (sheetNames.length === 0) throw new Error('xlsx_worksheet_missing');
  const output: string[] = [];
  let rowCount = 0;
  let cellCount = 0;
  for (const sheetName of sheetNames) {
    output.push(`## ${sheetName.split('/').pop()}`);
    const root = parseXml(await readZipText(zip, sheetName));
    const rows = descendants(root)
      .filter((node): node is { kind: 'element'; element: XmlElement } =>
        node.kind === 'element' && node.element.name === 'row');
    for (const row of rows) {
      if (rowCount >= MAX_XLSX_ROWS || cellCount >= MAX_XLSX_CELLS) {
        output.push(`[已截断：XLSX 最多读取 ${MAX_XLSX_ROWS} 行、${MAX_XLSX_CELLS} 个单元格]`);
        return output.join('\n');
      }
      const values: string[] = [];
      for (const cell of childElements(row.element).filter((item) => item.name === 'c')) {
        if (cellCount >= MAX_XLSX_CELLS) {
          output.push(values.join('\t'));
          output.push(`[已截断：XLSX 最多读取 ${MAX_XLSX_ROWS} 行、${MAX_XLSX_CELLS} 个单元格]`);
          return output.join('\n');
        }
        values.push(xlsxCellValue(cell, sharedStrings));
        cellCount += 1;
      }
      output.push(values.join('\t'));
      rowCount += 1;
    }
  }
  return output.join('\n');
}

async function loadSharedStrings(zip: JSZip): Promise<string[]> {
  if (!zip.file('xl/sharedStrings.xml')) return [];
  const root = parseXml(await readZipText(zip, 'xl/sharedStrings.xml'));
  return descendants(root)
    .filter((node): node is { kind: 'element'; element: XmlElement } =>
      node.kind === 'element' && node.element.name === 'si')
    .map((node) => elementText(node.element));
}

function xlsxCellValue(cell: XmlElement, sharedStrings: string[]): string {
  const type = attr(cell, 't');
  if (type === 'inlineStr') {
    const inline = descendants(cell).find((node) => node.kind === 'element' && node.element.name === 'is');
    return inline?.kind === 'element' ? elementText(inline.element) : '';
  }
  const value = descendants(cell).find((node) => node.kind === 'element' && node.element.name === 'v');
  const raw = value?.kind === 'element' ? elementText(value.element) : '';
  if (type === 's' && /^\d+$/u.test(raw)) return sharedStrings[Number(raw)] ?? '';
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  return raw;
}

function elementText(element: XmlElement): string {
  return descendants(element)
    .filter((node): node is { kind: 'text'; text: string } => node.kind === 'text')
    .map((node) => node.text)
    .join('');
}

function fileExtension(name: string): string {
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
}

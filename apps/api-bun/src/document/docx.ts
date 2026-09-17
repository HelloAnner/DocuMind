// 移植自 apps/api-rs/src/document/docx.rs —— 行为对齐 Rust 原版，错误信息保持一致

// Word：解析 word/document.xml（标题层级 / 列表 / 表格），样式表提供 styleId -> 标题级别映射

import type JSZip from 'jszip';
import { newUuid } from '../infra/uuid.ts';
import type { SourceAnchor } from '../models/source_anchor.ts';
import {
  attachTableCellAnchors,
  collectText,
  finalizeParsed,
  openZip,
  parseXmlTable,
  readZipText,
} from './shared.ts';
import { attr, attrI32, descendants, parseXml, validateXmlNesting, type XmlElement } from './xml.ts';
import { trimRust } from './text_utils.ts';
import type { ParsedBlock, ParsedDocument, ParsedTable } from './types.ts';

export async function parseDocx(
  docId: string,
  parseJobId: string,
  title: string,
  bytes: Uint8Array,
): Promise<ParsedDocument> {
  const archive = await openZip(bytes);
  const xml = await readZipText(archive, 'word/document.xml');
  const stylesXml = await readZipTextOptional(archive, 'word/styles.xml');
  let styleLevels = new Map<string, number>();
  if (stylesXml !== null) {
    validateXmlNesting(stylesXml);
    styleLevels = docxStyleHeadingLevels(stylesXml);
  }
  validateXmlNesting(xml);
  const doc = parseXml(xml);
  const body = findBody(doc);
  if (body === null) {
    throw new Error('docx_body_missing');
  }

  const blocks: ParsedBlock[] = [];
  const tables: ParsedTable[] = [];
  const anchors: SourceAnchor[] = [];
  let headingPath: Array<[number, string]> = [];

  const contentNodes = descendants(body)
    .filter((ref): ref is { kind: 'element'; element: XmlElement } => ref.kind === 'element')
    .filter((ref) => ref.element.name === 'p' || ref.element.name === 'tbl')
    .filter((ref) => !hasBlockAncestor(ref.element, body))
    .map((ref) => ref.element);

  for (const child of contentNodes) {
    if (child.name === 'p') {
      const text = trimRust(collectText(child));
      if (text.length === 0) continue;
      const style = paragraphStyle(child);
      const hasNumbering = descendants(child).some(
        (ref) => ref.kind === 'element' && ref.element.name === 'numPr',
      );
      const headingLevel = paragraphOutlineLevel(child)
        ?? (style !== null ? styleLevels.get(style) : undefined)
        ?? headingLevelFromStyle(style);
      const blockType = headingLevel !== undefined
        ? 'heading'
        : hasNumbering
          ? 'list_item'
          : 'paragraph';
      if (headingLevel !== undefined) {
        headingPath = headingPath.filter(([existing]) => existing < headingLevel);
        headingPath.push([headingLevel, text]);
      }
      const path = blockType === 'heading'
        ? headingPath.slice(0, Math.max(headingPath.length - 1, 0)).map(([, heading]) => heading)
        : headingPath.map(([, heading]) => heading);
      blocks.push({
        block_id: newUuid(),
        block_index: blocks.length,
        block_type: blockType,
        text,
        heading_level: headingLevel ?? null,
        heading_path: path,
        page_start: null,
        page_end: null,
        slide_index: null,
        table_id: null,
        bbox: null,
        anchor_ids: [],
        source_ref: { format: 'docx', node: 'w:p', index: blocks.length },
        metadata: { style: style ?? null },
      });
    } else if (child.name === 'tbl') {
      const blockId = newUuid();
      const table = parseXmlTable(
        child,
        docId,
        parseJobId,
        blockId,
        tables.length,
        headingPath.map(([, heading]) => heading),
        null,
        null,
        null,
        'docx',
      );
      blocks.push({
        block_id: blockId,
        block_index: blocks.length,
        block_type: 'table',
        text: table.markdown,
        heading_level: null,
        heading_path: [...table.heading_path],
        page_start: null,
        page_end: null,
        slide_index: null,
        table_id: table.table_id,
        bbox: null,
        anchor_ids: [],
        source_ref: { format: 'docx', node: 'w:tbl', index: tables.length },
        metadata: {},
      });
      tables.push(table);
    }
  }

  attachTableCellAnchors(docId, parseJobId, 'docx', blocks, tables, anchors);

  return finalizeParsed(docId, parseJobId, 'docx', title, null, blocks, tables, anchors);
}

/** 对齐 Rust read_zip_text(...).ok()：样式表缺失或不可读时忽略（但内容解析错误仍抛出） */
async function readZipTextOptional(archive: JSZip, name: string): Promise<string | null> {
  try {
    return await readZipText(archive, name);
  } catch {
    return null;
  }
}

function findBody(doc: XmlElement): XmlElement | null {
  for (const ref of descendants(doc)) {
    if (ref.kind === 'element' && ref.element.name === 'body') return ref.element;
  }
  return null;
}

/** 对齐 Rust content_nodes 过滤：p/tbl 且最近的 p/tbl 祖先不存在（body 之前） */
function hasBlockAncestor(node: XmlElement, body: XmlElement): boolean {
  let current = node.parent;
  while (current !== null && current !== body) {
    if (current.name === 'p' || current.name === 'tbl') return true;
    current = current.parent;
  }
  return false;
}

function paragraphStyle(paragraph: XmlElement): string | null {
  for (const ref of descendants(paragraph)) {
    if (ref.kind === 'element' && ref.element.name === 'pStyle') {
      return attr(ref.element, 'val') ?? null;
    }
  }
  return null;
}

function paragraphOutlineLevel(paragraph: XmlElement): number | undefined {
  for (const ref of descendants(paragraph)) {
    if (ref.kind === 'element' && ref.element.name === 'outlineLvl') {
      const level = attrI32(ref.element, 'val');
      if (level === undefined) return undefined;
      return Math.min(Math.max(level + 1, 1), 9);
    }
  }
  return undefined;
}

function docxStyleHeadingLevels(xml: string): Map<string, number> {
  let doc: XmlElement;
  try {
    doc = parseXml(xml);
  } catch (error) {
    throw new Error('invalid_docx_styles_xml:' + messageOf(error));
  }
  const levels = new Map<string, number>();
  for (const ref of descendants(doc)) {
    if (ref.kind !== 'element' || ref.element.name !== 'style') continue;
    const style = ref.element;
    const styleId = attr(style, 'styleId');
    if (styleId === undefined) continue;
    let level: number | undefined;
    for (const inner of descendants(style)) {
      if (inner.kind === 'element' && inner.element.name === 'outlineLvl') {
        const raw = attrI32(inner.element, 'val');
        if (raw !== undefined) level = Math.min(Math.max(raw + 1, 1), 9);
        break;
      }
    }
    if (level === undefined) {
      for (const inner of descendants(style)) {
        if (inner.kind === 'element' && inner.element.name === 'name') {
          level = headingLevelFromStyle(attr(inner.element, 'val') ?? null);
          break;
        }
      }
    }
    if (level !== undefined) {
      levels.set(styleId, level);
    }
  }
  return levels;
}

function headingLevelFromStyle(style: string | null): number | undefined {
  if (style === null) return undefined;
  const normalized = asciiLower(style).replace(/ /g, '');
  for (let level = 1; level <= 6; level += 1) {
    if (normalized === `heading${level}` || normalized === `标题${level}`) {
      return level;
    }
  }
  return undefined;
}

/** 对齐 Rust to_ascii_lowercase：只折叠 ASCII 大写 */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

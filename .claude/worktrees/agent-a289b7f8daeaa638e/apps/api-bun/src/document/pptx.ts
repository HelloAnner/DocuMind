// 移植自 apps/api-rs/src/document/pptx.rs —— 行为对齐 Rust 原版，错误信息保持一致

// PPT：优先按 ppt/presentation.xml + rels 的 sldId 顺序取幻灯片，退化时按文件名排序扫描

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
import {
  attr,
  childElements,
  descendants,
  parseXml,
  validateXmlNesting,
  type XmlElement,
} from './xml.ts';
import { trimRust } from './text_utils.ts';
import type { ParsedBlock, ParsedDocument, ParsedTable } from './types.ts';

export async function parsePptx(
  docId: string,
  parseJobId: string,
  title: string,
  bytes: Uint8Array,
): Promise<ParsedDocument> {
  const archive = await openZip(bytes);
  const [slideNames, usedRelationshipOrder] = await pptxSlideNames(archive);

  const blocks: ParsedBlock[] = [];
  const tables: ParsedTable[] = [];
  const anchors: SourceAnchor[] = [];
  const warnings: string[] = [];
  if (!usedRelationshipOrder) {
    warnings.push('pptx_slide_order_fallback');
  }

  for (const [slideIdx, name] of slideNames.entries()) {
    const slideIndex = slideIdx + 1;
    const xml = await readZipText(archive, name);
    validateXmlNesting(xml);
    const doc = parseXml(xml);
    let slideHeading: string[] = [];
    let hasText = false;
    const spTree = descendants(doc)
      .find((ref) => ref.kind === 'element' && ref.element.name === 'spTree');
    const shapeNodes = spTree !== undefined && spTree.kind === 'element'
      ? childElements(spTree.element)
      : [];

    for (const [shapeIdx, shape] of shapeNodes.entries()) {
      const shapeIndex = shapeIdx + 1;
      const tbl = descendants(shape)
        .find((ref) => ref.kind === 'element' && ref.element.name === 'tbl');
      if (tbl !== undefined && tbl.kind === 'element') {
        const blockId = newUuid();
        const table = parseXmlTable(
          tbl.element,
          docId,
          parseJobId,
          blockId,
          tables.length,
          [...slideHeading],
          null,
          null,
          slideIndex,
          'pptx',
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
          slide_index: slideIndex,
          table_id: table.table_id,
          bbox: null,
          anchor_ids: [],
          source_ref: { format: 'pptx', slide: slideIndex, shape: shapeIndex, node: 'a:tbl' },
          metadata: {},
        });
        tables.push(table);
        continue;
      }

      const isTitleShape = descendants(shape).some((ref) => {
        if (ref.kind !== 'element' || ref.element.name !== 'ph') return false;
        const kind = attr(ref.element, 'type');
        return kind === 'title' || kind === 'ctrTitle';
      });
      for (const ref of descendants(shape)) {
        if (ref.kind !== 'element' || ref.element.name !== 'p') continue;
        const text = trimRust(collectText(ref.element));
        if (text.length === 0) continue;
        const isBullet = descendants(ref.element).some(
          (inner) => inner.kind === 'element' && (inner.element.name === 'buChar' || inner.element.name === 'buAutoNum'),
        );
        const isHeading = isTitleShape || !hasText;
        const blockType = isHeading ? 'heading' : isBullet ? 'list_item' : 'paragraph';
        if (isHeading) {
          slideHeading = [text];
        }
        hasText = true;
        blocks.push({
          block_id: newUuid(),
          block_index: blocks.length,
          block_type: blockType,
          text,
          heading_level: isHeading ? 1 : null,
          heading_path: isHeading ? [] : [...slideHeading],
          page_start: null,
          page_end: null,
          slide_index: slideIndex,
          table_id: null,
          bbox: null,
          anchor_ids: [],
          source_ref: { format: 'pptx', slide: slideIndex, shape: shapeIndex, node: 'a:p' },
          metadata: { placeholder_title: isTitleShape },
        });
      }
    }

    if (!hasText && !blocks.some((block) => block.slide_index === slideIndex)) {
      warnings.push(`slide_${slideIndex}_empty`);
    }
  }

  attachTableCellAnchors(docId, parseJobId, 'pptx', blocks, tables, anchors);

  const parsed = finalizeParsed(docId, parseJobId, 'pptx', title, slideNames.length, blocks, tables, anchors);
  parsed.warnings.push(...warnings);
  return parsed;
}

async function pptxSlideNames(archive: JSZip): Promise<[string[], boolean]> {
  const presentationXml = await readZipTextOptional(archive, 'ppt/presentation.xml');
  const relsXml = await readZipTextOptional(archive, 'ppt/_rels/presentation.xml.rels');
  if (presentationXml !== null && relsXml !== null) {
    validateXmlNesting(presentationXml);
    validateXmlNesting(relsXml);
    const presentation = parseXmlOrThrow(presentationXml, 'invalid_pptx_presentation_xml');
    const relationships = parseXmlOrThrow(relsXml, 'invalid_pptx_relationships_xml');
    const targets = new Map<string, string>();
    for (const ref of descendants(relationships)) {
      if (ref.kind !== 'element' || ref.element.name !== 'Relationship') continue;
      const id = attr(ref.element, 'Id');
      const target = attr(ref.element, 'Target');
      if (id === undefined || target === undefined) continue;
      targets.set(id, target);
    }
    const ordered: string[] = [];
    for (const ref of descendants(presentation)) {
      if (ref.kind !== 'element' || ref.element.name !== 'sldId') continue;
      // attrs 是扁平本地名映射：<p:sldId id="256" r:id="rId2"/> 取到的是 r:id
      const relationshipId = Object.entries(ref.element.attrs)
        .find(([name, value]) => name === 'id' && value.startsWith('rId'))?.[1];
      if (relationshipId === undefined) continue;
      const target = targets.get(relationshipId);
      if (target === undefined) continue;
      ordered.push(normalizePptTarget(target));
    }
    if (ordered.length > 0) {
      return [ordered, true];
    }
  }

  const slideNames: string[] = [];
  for (const file of Object.values(archive.files)) {
    const name = file.name;
    if (!name.startsWith('ppt/slides/slide') || !name.endsWith('.xml')) continue;
    const rest = trimEndMatches(name.slice('ppt/slides/slide'.length), '.xml');
    if (!/^[0-9]*$/.test(rest)) continue;
    slideNames.push(name);
  }
  slideNames.sort((a, b) => slideOrderKey(a) - slideOrderKey(b));

  return [slideNames, false];
}

async function readZipTextOptional(archive: JSZip, name: string): Promise<string | null> {
  try {
    return await readZipText(archive, name);
  } catch {
    return null;
  }
}

function parseXmlOrThrow(xml: string, context: string): XmlElement {
  try {
    return parseXml(xml);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${context}:${message}`);
  }
}

function trimEndMatches(value: string, pattern: string): string {
  let out = value;
  while (out.endsWith(pattern)) out = out.slice(0, -pattern.length);
  return out;
}

function trimStartMatches(value: string, pattern: string): string {
  let out = value;
  while (out.startsWith(pattern)) out = out.slice(pattern.length);
  return out;
}

function slideOrderKey(name: string): number {
  const raw = trimEndMatches(trimStartMatches(name, 'ppt/slides/slide'), '.xml');
  if (!/^[+-]?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return parsed < -2147483648 || parsed > 2147483647 ? 0 : parsed;
}

function normalizePptTarget(target: string): string {
  const trimmed = trimStartMatches(target, '/');
  if (trimmed.startsWith('ppt/')) return trimmed;
  return 'ppt/' + trimStartMatches(trimmed, '../');
}

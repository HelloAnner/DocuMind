// 移植自 apps/api-rs/src/api/documents.rs parses_pptx_slides_with_page_range
import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';

import { parseDocument } from './mod.ts';

async function zipWithEntries(entries: Array<[string, string]>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, entryContent] of entries) {
    zip.file(name, entryContent);
  }
  return await zip.generateAsync({ type: 'uint8array' });
}

function slideXml(text: string): string {
  return `
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
           xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree><p:sp><p:txBody>
        <a:p><a:r><a:t>${text}</a:t></a:r></a:p>
      </p:txBody></p:sp></p:spTree></p:cSld>
    </p:sld>
  `;
}

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

describe('parseDocument (pptx)', () => {
  test('parses pptx slides with page range', async () => {
    const bytes = await zipWithEntries([
      ['ppt/presentation.xml', '<p:presentation/>'],
      ['ppt/slides/slide3.xml', slideXml('Q3华东区域销售目标为1200万元')],
    ]);

    const bundle = await parseDocument(
      crypto.randomUUID(),
      crypto.randomUUID(),
      'slides.pptx',
      PPTX_MIME,
      bytes,
    );

    expect(bundle.file_type).toBe('pptx');
    expect(bundle.parsed.blocks.length).toBe(1);
    expect(bundle.parsed.blocks[0]!.slide_index).toBe(1);
    expect(bundle.parsed.blocks[0]!.text).toContain('1200万元');
    expect(bundle.parsed.blocks[0]!.anchor_ids.length).toBeGreaterThan(0);
    expect(bundle.parsed.pages).toBe(1);
    expect(bundle.parsed.warnings).toContain('pptx_slide_order_fallback');
  });

  test('follows presentation relationship order for slides', async () => {
    const presentationXml = `
      <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <p:sldIdLst>
          <p:sldId id="256" r:id="rId2"/>
          <p:sldId id="257" r:id="rId1"/>
        </p:sldIdLst>
      </p:presentation>
    `;
    const relsXml = `
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
      </Relationships>
    `;
    const bytes = await zipWithEntries([
      ['ppt/presentation.xml', presentationXml],
      ['ppt/_rels/presentation.xml.rels', relsXml],
      ['ppt/slides/slide1.xml', slideXml('第一张幻灯片')],
      ['ppt/slides/slide2.xml', slideXml('第二张幻灯片')],
    ]);

    const bundle = await parseDocument(crypto.randomUUID(), crypto.randomUUID(), 'ordered.pptx', PPTX_MIME, bytes);

    expect(bundle.parsed.blocks.length).toBe(2);
    expect(bundle.parsed.blocks[0]!.text).toContain('第二张幻灯片');
    expect(bundle.parsed.blocks[0]!.slide_index).toBe(1);
    expect(bundle.parsed.blocks[1]!.text).toContain('第一张幻灯片');
    expect(bundle.parsed.blocks[1]!.slide_index).toBe(2);
    expect(bundle.parsed.warnings).not.toContain('pptx_slide_order_fallback');
  });

  test('parses pptx tables and attaches cell-range anchors', async () => {
    const slide = `
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree>
          <p:graphicFrame><a:graphic><a:graphicData><a:tbl>
            <a:tr><a:tc><a:txBody><a:p><a:r><a:t>区域</a:t></a:r></a:p></a:txBody></a:tc>
                  <a:tc><a:txBody><a:p><a:r><a:t>金额</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
            <a:tr><a:tc><a:txBody><a:p><a:r><a:t>华东</a:t></a:r></a:p></a:txBody></a:tc>
                  <a:tc><a:txBody><a:p><a:r><a:t>1200</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
          </a:tbl></a:graphicData></a:graphic></p:graphicFrame>
        </p:spTree></p:cSld>
      </p:sld>
    `;
    const bytes = await zipWithEntries([
      ['ppt/presentation.xml', '<p:presentation/>'],
      ['ppt/slides/slide1.xml', slide],
    ]);

    const bundle = await parseDocument(crypto.randomUUID(), crypto.randomUUID(), 'table.pptx', PPTX_MIME, bytes);

    const table = bundle.parsed.tables[0]!;
    expect(table.headers).toEqual(['区域', '金额']);
    expect(table.rows).toEqual([['华东', '1200']]);
    expect(table.markdown).toContain('|区域|金额|');
    expect(bundle.parsed.blocks.some((block) => block.block_type === 'table')).toBe(true);
    expect(bundle.chunks.some((chunk) => chunk.source_type === 'table')).toBe(true);
    const tableAnchor = bundle.parsed.anchors.find((anchor) => anchor.kind === 'table_cell_range');
    expect(tableAnchor).toBeDefined();
    expect(tableAnchor!.cell_range).toEqual({ row_start: 0, row_end: 1, col_start: 0, col_end: 1 });
  });

  test('warns about empty slides', async () => {
    const bytes = await zipWithEntries([
      ['ppt/presentation.xml', '<p:presentation/>'],
      ['ppt/slides/slide1.xml', '<p:sld xmlns:p="urn:p"><p:cSld><p:spTree/></p:cSld></p:sld>'],
    ]);

    const bundle = await parseDocument(crypto.randomUUID(), crypto.randomUUID(), 'empty.pptx', PPTX_MIME, bytes);

    expect(bundle.parsed.blocks.length).toBe(0);
    expect(bundle.parsed.warnings).toContain('slide_1_empty');
    expect(bundle.chunks.length).toBe(0);
  });
});

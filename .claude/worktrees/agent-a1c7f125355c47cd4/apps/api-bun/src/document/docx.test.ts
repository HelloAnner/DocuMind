// 移植自 apps/api-rs/src/api/documents.rs parses_docx_paragraphs_and_tables
import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';

import { parseDocument } from './mod.ts';

export async function zipWithEntries(entries: Array<[string, string]>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of entries) {
    zip.file(name, content);
  }
  return await zip.generateAsync({ type: 'uint8array' });
}

describe('parseDocument (docx)', () => {
  test('parses docx paragraphs and tables', async () => {
    const xml = `
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
            <w:r><w:t>付款条款</w:t></w:r>
          </w:p>
          <w:p><w:r><w:t>合同签署后支付首付款30%。</w:t></w:r></w:p>
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>阶段</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>比例</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:body>
      </w:document>
    `;
    const bytes = await zipWithEntries([['word/document.xml', xml]]);

    const bundle = await parseDocument(
      crypto.randomUUID(),
      crypto.randomUUID(),
      'contract.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes,
    );

    expect(bundle.file_type).toBe('docx');
    expect(bundle.parsed.blocks.some((block) => block.block_type === 'heading' && block.text === '付款条款')).toBe(true);
    expect(bundle.parsed.blocks.some((block) => block.text.includes('首付款30%'))).toBe(true);
    expect(bundle.parsed.blocks.some((block) => block.block_type === 'table')).toBe(true);
    expect(bundle.parsed.blocks.every((block) => block.anchor_ids.length > 0)).toBe(true);
    expect(bundle.cleaned_blocks.some((block) => !block.is_removed)).toBe(true);
    expect(bundle.chunks.some((chunk) => chunk.source_type === 'table')).toBe(true);

    const tableAnchor = bundle.parsed.anchors.find((anchor) => anchor.kind === 'table_cell_range');
    expect(tableAnchor).toBeDefined();
    expect(tableAnchor!.cell_range).toEqual({ row_start: 0, row_end: 0, col_start: 0, col_end: 1 });

    const tableBlock = bundle.parsed.blocks.find((block) => block.block_type === 'table')!;
    expect(tableBlock.anchor_ids).toContain(tableAnchor!.anchor_id);
    const tableChunk = bundle.chunks.find((chunk) => chunk.source_type === 'table')!;
    expect(tableChunk.anchor_ids).toContain(tableAnchor!.anchor_id);
  });

  test('uses heading level from word/styles.xml', async () => {
    const documentXml = `
      <w:document xmlns:w="urn:test">
        <w:body>
          <w:p><w:pPr><w:pStyle w:val="MyHeading"/></w:pPr><w:r><w:t>自定义标题</w:t></w:r></w:p>
          <w:p><w:r><w:t>正文内容。</w:t></w:r></w:p>
        </w:body>
      </w:document>
    `;
    const stylesXml = `
      <w:styles xmlns:w="urn:test">
        <w:style w:styleId="MyHeading">
          <w:name w:val="heading 2"/>
          <w:pPr><w:outlineLvl w:val="2"/></w:pPr>
        </w:style>
      </w:styles>
    `;
    const bytes = await zipWithEntries([
      ['word/document.xml', documentXml],
      ['word/styles.xml', stylesXml],
    ]);

    const bundle = await parseDocument(crypto.randomUUID(), crypto.randomUUID(), 'styled.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes);

    const heading = bundle.parsed.blocks.find((block) => block.text === '自定义标题')!;
    expect(heading.block_type).toBe('heading');
    expect(heading.heading_level).toBe(3);
    expect(heading.heading_path).toEqual([]);
    const paragraph = bundle.parsed.blocks.find((block) => block.text === '正文内容。')!;
    expect(paragraph.heading_path).toEqual(['自定义标题']);
  });
});

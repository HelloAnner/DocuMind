// 移植自 apps/api-rs/examples/inspect_document.rs —— 解析语料巡检（每文件输出一行 JSON）
// 用法: bun run apps/api-bun/scripts/inspect-document.ts <files...>
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { newUuid } from '../src/infra/uuid.ts';
import { parseDocument } from '../src/document/mod.ts';

interface DocumentInspection {
  file_name: string;
  file_type: string;
  pages: number | null;
  blocks: number;
  tables: number;
  chunks: number;
  anchors: number;
  unanchored_blocks: number;
  bbox_anchors: number;
  block_types: Record<string, number>;
  quality_score: number;
  warnings: string[];
  content: string;
}

function mimeType(path: string): string {
  switch (extname(path).slice(1).toLowerCase()) {
    case 'pdf': return 'application/pdf';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'md': case 'markdown': return 'text/markdown';
    case 'txt': return 'text/plain';
    default: return 'application/octet-stream';
  }
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('usage: bun run apps/api-bun/scripts/inspect-document.ts <files...>');
  process.exit(1);
}

for (const path of paths) {
  const fileName = basename(path);
  const bytes = new Uint8Array(readFileSync(path));
  const bundle = await parseDocument(
    newUuid(), newUuid(), fileName, mimeType(path), bytes,
  );
  const inspection: DocumentInspection = {
    file_name: fileName,
    file_type: bundle.file_type,
    pages: bundle.parsed.pages,
    blocks: bundle.parsed.blocks.length,
    tables: bundle.parsed.tables.length,
    chunks: bundle.chunks.length,
    anchors: bundle.parsed.anchors.length,
    unanchored_blocks: bundle.parsed.blocks.filter((block) => block.anchor_ids.length === 0).length,
    bbox_anchors: bundle.parsed.anchors.filter((anchor) => anchor.bbox != null).length,
    block_types: bundle.parsed.blocks.reduce<Record<string, number>>((counts, block) => {
      counts[block.block_type] = (counts[block.block_type] ?? 0) + 1;
      return counts;
    }, {}),
    quality_score: bundle.parsed.quality_score,
    warnings: bundle.parsed.warnings,
    content: bundle.cleaned_blocks
      .filter((block) => !block.is_removed)
      .map((block) => block.cleaned_text)
      .join('\n'),
  };
  console.log(JSON.stringify(inspection));
}

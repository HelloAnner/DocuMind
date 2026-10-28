// 移植自 apps/api-rs/src/api/documents.rs 的 insert_parse_outputs —— 解析产物落库
import type { TransactionSql } from 'postgres';
import { cleanedBlockMetadata } from '../document/cleaning.ts';
import type { CleanedBlock } from '../document/cleaning.ts';
import { SCHEMA_VERSION, PARSER_VERSION } from '../document/types.ts';
import type { SourceAnchor } from '../models/source_anchor.ts';
import { nowRfc3339 } from '../infra/time.ts';
import type { ParseArtifacts, ParseWriteScope } from './documents_types.ts';
import { pageRange, toJson, uuidListFromMetadata } from './documents_support.ts';

export async function insertParseOutputs(
  tx: TransactionSql, scope: ParseWriteScope, fileType: string, artifacts: ParseArtifacts,
): Promise<void> {
  const chunks = artifacts.bundle.chunks;
  const blocks = artifacts.bundle.parsed.blocks;
  const anchors = artifacts.bundle.parsed.anchors as SourceAnchor[];
  const cleanedBlocks = artifacts.bundle.cleaned_blocks as CleanedBlock[];

  await tx.unsafe(
    `INSERT INTO document_parse_jobs (
        parse_job_id, tenant_id, kb_id, doc_id, parser_version, parser_config,
        parse_identity, status, quality_score, started_at, completed_at
     )
     VALUES (\$1, \$2, \$3, \$4, \$5, \$6, \$7, 'completed', \$8, NOW(), NOW())
     ON CONFLICT (parse_job_id) DO UPDATE
     SET parser_config = EXCLUDED.parser_config,
         parse_identity = EXCLUDED.parse_identity,
         status = 'completed',
         error_code = NULL,
         error_message = NULL,
         quality_score = EXCLUDED.quality_score,
         worker_id = NULL,
         heartbeat_at = NOW(),
         updated_at = NOW(),
         started_at = COALESCE(document_parse_jobs.started_at, NOW()),
         completed_at = NOW()`,
    [scope.parse_job_id, scope.tenant_id, scope.kb_id, scope.doc_id, PARSER_VERSION,
      toJson(artifacts.parser_config), artifacts.parse_identity, artifacts.quality_score],
  );

  await tx.unsafe(
    `INSERT INTO document_processing_events (
        tenant_id, doc_id, parse_job_id, stage, status, message, metrics
     ) VALUES (\$1, \$2, \$3, 'chunking', \$4, \$5, \$6)`,
    [scope.tenant_id, scope.doc_id, scope.parse_job_id,
      artifacts.parse_status === 'parse_low_confidence' ? 'warning' : 'completed',
      artifacts.parse_status === 'parse_low_confidence' ? '解析完成，但质量较低' : '解析、清洗和切片完成',
      toJson({
        blocks: blocks.length,
        tables: artifacts.bundle.parsed.tables.length,
        chunks: chunks.length,
        quality_score: artifacts.quality_score,
      })],
  );

  await tx.unsafe(
    `INSERT INTO document_parse_results (parse_job_id, doc_id, parsed_json, schema_version)
     VALUES (\$1, \$2, \$3, \$4)`,
    [scope.parse_job_id, scope.doc_id, toJson(artifacts.bundle.parsed), SCHEMA_VERSION],
  );

  for (const anchor of anchors) {
    await tx.unsafe(
      `INSERT INTO document_source_anchors (
          id, doc_id, parse_job_id, tenant_id, format, kind,
          page, slide, block_id, table_id, cell_range, char_range,
          bbox, source_ref, text, text_hash, anchor_quality
       )
       VALUES (\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, \$13, \$14, \$15, \$16, \$17)
       ON CONFLICT (id) DO UPDATE
       SET doc_id = EXCLUDED.doc_id,
           parse_job_id = EXCLUDED.parse_job_id,
           tenant_id = EXCLUDED.tenant_id,
           format = EXCLUDED.format,
           kind = EXCLUDED.kind,
           page = EXCLUDED.page,
           slide = EXCLUDED.slide,
           block_id = EXCLUDED.block_id,
           table_id = EXCLUDED.table_id,
           cell_range = EXCLUDED.cell_range,
           char_range = EXCLUDED.char_range,
           bbox = EXCLUDED.bbox,
           source_ref = EXCLUDED.source_ref,
           text = EXCLUDED.text,
           text_hash = EXCLUDED.text_hash,
           anchor_quality = EXCLUDED.anchor_quality`,
      [anchor.anchor_id, scope.doc_id, scope.parse_job_id, scope.tenant_id,
        anchor.format, anchor.kind, anchor.page, anchor.slide, anchor.block_id, anchor.table_id,
        toJson(anchor.cell_range), toJson(anchor.char_range), toJson(anchor.bbox),
        toJson(anchor.source_ref), anchor.text, anchor.text_hash ?? null, anchor.anchor_quality],
    );
  }

  const documentMetadata: Record<string, unknown> = {
    quality_score: artifacts.quality_score,
    warnings: artifacts.bundle.parsed.warnings,
    clean_stats: artifacts.bundle.clean_stats,
    file_type: fileType,
  };
  if (artifacts.parser_config['ocr_status'] === 'completed') {
    documentMetadata['ocr_status'] = 'completed';
    documentMetadata['ocr_completed_at'] = nowRfc3339();
    documentMetadata['ocr_parse_job_id'] = scope.parse_job_id;
    documentMetadata['ocr_block_count'] = blocks.filter(
      (block) => typeof block.metadata === 'object' && block.metadata !== null
        && (block.metadata as Record<string, unknown>)['extraction_method'] === 'ocr',
    ).length;
    documentMetadata['ocr_chunk_count'] = chunks.length;
    documentMetadata['ocr_mode'] = artifacts.parser_config['ocr_mode'];
    documentMetadata['ocr_pages'] = artifacts.parser_config['ocr_pages'];
  }

  await tx.unsafe(
    `UPDATE documents
     SET latest_parse_job_id = \$1,
         parse_status = \$2,
         parse_version = \$3,
         chunk_count = \$4,
         metadata = metadata || \$5,
         updated_at = NOW()
     WHERE id = \$6`,
    [scope.parse_job_id, artifacts.parse_status, scope.parse_version, chunks.length,
      toJson(documentMetadata), scope.doc_id],
  );

  for (const block of blocks) {
    await tx.unsafe(
      `INSERT INTO document_blocks (
          id, tenant_id, kb_id, doc_id, parse_job_id, block_index, block_type,
          heading_path, page_range, content, anchor_ids, metadata
       )
       VALUES (\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12)`,
      [block.block_id, scope.tenant_id, scope.kb_id, scope.doc_id, scope.parse_job_id,
        block.block_index + 1, block.block_type, block.heading_path,
        pageRange(block.page_start, block.page_end), block.text, block.anchor_ids,
        toJson({
          heading_level: block.heading_level,
          slide: block.slide_index,
          table_id: block.table_id,
          bbox: block.bbox,
          source_ref: block.source_ref,
          metadata: block.metadata,
        })],
    );
  }

  for (const block of cleanedBlocks) {
    await tx.unsafe(
      `INSERT INTO cleaned_blocks (
          tenant_id, kb_id, doc_id, parse_job_id, block_id, block_index, block_type,
          cleaned_text, is_removed, remove_reason, cleaning_ops,
          heading_path, page_range, metadata
       )
       VALUES (\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, \$13, \$14)
       ON CONFLICT (parse_job_id, block_id) DO UPDATE
       SET cleaned_text = EXCLUDED.cleaned_text,
           is_removed = EXCLUDED.is_removed,
           remove_reason = EXCLUDED.remove_reason,
           cleaning_ops = EXCLUDED.cleaning_ops,
           metadata = EXCLUDED.metadata`,
      [scope.tenant_id, scope.kb_id, scope.doc_id, scope.parse_job_id,
        block.block.block_id, block.block.block_index + 1, block.block.block_type,
        block.cleaned_text, block.is_removed, block.remove_reason, block.cleaning_ops,
        block.block.heading_path, pageRange(block.block.page_start, block.block.page_end),
        toJson(cleanedBlockMetadata(block))],
    );
  }

  for (const table of artifacts.bundle.parsed.tables) {
    await tx.unsafe(
      `INSERT INTO document_tables (
          id, tenant_id, kb_id, doc_id, parse_job_id, table_index,
          heading_path, page_range, markdown, cells, metadata
       )
       VALUES (\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11)`,
      [table.table_id, scope.tenant_id, scope.kb_id, scope.doc_id, scope.parse_job_id,
        table.table_index + 1, table.heading_path, pageRange(table.page_start, table.page_end),
        table.markdown, table.rows,
        toJson({
          block_id: table.block_id,
          title: table.title,
          headers: table.headers,
          row_count: table.rows.length,
          col_count: table.headers.length,
          quality: table.quality,
          source_ref: table.source_ref,
          slide: table.slide_index,
        })],
    );

    for (const cell of table.cells) {
      await tx.unsafe(
        `INSERT INTO document_table_cells (
            id, tenant_id, kb_id, doc_id, parse_job_id, table_id,
            row_index, col_index, row_span, col_span, text, metadata
         )
         VALUES (\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12)
         ON CONFLICT (table_id, row_index, col_index) DO UPDATE
         SET text = EXCLUDED.text, metadata = EXCLUDED.metadata`,
        [cell.cell_id, scope.tenant_id, scope.kb_id, scope.doc_id, scope.parse_job_id,
          table.table_id, cell.row_index, cell.col_index, cell.rowspan, cell.colspan, cell.text,
          toJson({
            normalized_text: cell.normalized_text,
            is_header: cell.is_header,
            data_type: cell.data_type,
            bbox: cell.bbox,
            style: cell.style,
            source_ref: cell.source_ref,
          })],
      );
    }
  }

  for (const chunk of chunks) {
    await tx.unsafe(
      `INSERT INTO chunks (
          id, tenant_id, kb_id, doc_id, parse_job_id, chunk_index,
          source_type, content, heading_path, page_range, token_count,
          block_ids, table_ids, anchor_ids, primary_anchor_id, anchor_quality,
          overlap_prev_block_ids, overlap_next_block_ids, metadata
       )
       VALUES (\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, \$13, \$14, \$15, \$16, \$17, \$18, \$19)`,
      [chunk.chunk_id, scope.tenant_id, scope.kb_id, scope.doc_id, scope.parse_job_id,
        chunk.chunk_index + 1, chunk.source_type, chunk.content, chunk.heading_path,
        pageRange(chunk.page_start, chunk.page_end), chunk.token_count,
        chunk.block_ids, chunk.table_ids, chunk.anchor_ids, chunk.primary_anchor_id,
        chunk.anchor_quality,
        uuidListFromMetadata(chunk.metadata, 'overlap_prev_block_ids'),
        uuidListFromMetadata(chunk.metadata, 'overlap_next_block_ids'),
        toJson({
          slide_start: chunk.slide_start,
          slide_end: chunk.slide_end,
          block_ids: chunk.block_ids,
          table_ids: chunk.table_ids,
          anchor_ids: chunk.anchor_ids,
          primary_anchor_id: chunk.primary_anchor_id,
          anchor_quality: chunk.anchor_quality,
          source_type: chunk.source_type,
          chunk_metadata: chunk.metadata,
        })],
    );

    for (const tableId of chunk.table_ids) {
      await tx.unsafe(
        `INSERT INTO chunk_tables (chunk_id, table_id)
         VALUES (\$1, \$2)
         ON CONFLICT (chunk_id, table_id) DO NOTHING`,
        [chunk.chunk_id, tableId],
      );
    }

    for (const anchorId of chunk.anchor_ids) {
      await tx.unsafe(
        `INSERT INTO chunk_anchor_map (chunk_id, anchor_id, relation)
         VALUES (\$1, \$2, \$3)
         ON CONFLICT (chunk_id, anchor_id) DO NOTHING`,
        [chunk.chunk_id, anchorId, anchorId === chunk.primary_anchor_id ? 'primary' : 'covered'],
      );
    }
  }
}

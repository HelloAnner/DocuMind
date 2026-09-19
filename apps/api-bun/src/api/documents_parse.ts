// 移植自 apps/api-rs/src/api/documents.rs 的解析任务引擎
// （insert_pending_parse_job / spawn_parse_job / run_parse_job / mark_parse_job_* /
//   build_parse_artifacts / resume_pending_document_jobs / recover_interrupted_document_jobs）
import type { Sql, TransactionSql } from 'postgres';
import { AppError } from '../errors.ts';
import { parseDocument } from '../document/mod.ts';
import type { CleanedBlock, CleanStats } from '../document/cleaning.ts';
import type { ParsedBundle } from '../document/types.ts';
import { PARSER_VERSION, SCHEMA_VERSION } from '../document/types.ts';
import { newUuid } from '../infra/uuid.ts';
import { activeIndex, enqueueDocument as enqueueVectorJob } from '../rag/vector_jobs.ts';
import { markDocumentTerminalFailure } from '../rag/vector_store.ts';
import { physicalIndexName } from '../rag/vector_index/schema.ts';
import type { AppState } from '../state.ts';
import type { EmbeddingConfig } from '../config.ts';
import {
  appErrorDetails, currentParserConfig, isOcrTask, isScannedPdfNoTextLayer, parseStatusForResult, toJson,
} from './documents_support.ts';
import {
  OCR_RENDER_DPI, PARSE_WORKER_CONCURRENCY,
} from './documents_types.ts';
import type { ParseArtifacts, ParseJobTask, ParseWriteScope } from './documents_types.ts';
import { buildOcrBundle, buildSelectiveOcrBundle } from './documents_ocr.ts';
import { insertParseOutputs } from './documents_parse_outputs.ts';

// ---------------------------------------------------------------------------
// 解析 worker 并发闸门（Rust: static PARSE_WORKER_SLOTS = Semaphore(2)）
// ---------------------------------------------------------------------------

let activeWorkers = 0;
const waiting: Array<() => void> = [];

async function acquireWorkerSlot(): Promise<() => void> {
  if (activeWorkers < PARSE_WORKER_CONCURRENCY) {
    activeWorkers += 1;
  } else {
    await new Promise<void>((resolve) => { waiting.push(resolve); });
    activeWorkers += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWorkers -= 1;
    const next = waiting.shift();
    if (next !== undefined) next();
  };
}

export function spawnParseJob(sql: Sql, task: ParseJobTask): void {
  void (async () => {
    const release = await acquireWorkerSlot();
    try {
      await runParseJob(sql, task);
    } catch (error) {
      console.error(`document parse job failed to update state: ${(error as Error).message}`);
    } finally {
      release();
    }
  })();
}

export async function runParseJob(sql: Sql, task: ParseJobTask): Promise<void> {
  await markParseJobRunning(sql, task);

  let artifacts: ParseArtifacts;
  try {
    artifacts = await buildParseArtifacts(task);
  } catch (error) {
    if (error instanceof AppError) {
      await markParseJobFailed(sql, task, error);
      return;
    }
    await markParseJobFailed(sql, task, AppError.internal((error as Error).message));
    return;
  }

  await sql.begin(async (tx) => {
    await insertParseOutputs(tx, {
      tenant_id: task.tenant_id,
      kb_id: task.kb_id,
      doc_id: task.doc_id,
      parse_job_id: task.parse_job_id,
      parse_version: task.parse_version,
    }, task.file_type, artifacts);
  });

  if (artifacts.parse_status === 'chunked' && task.embedding_config.enabled) {
    try {
      await enqueueDocumentJob(
        sql, task.tenant_id, task.kb_id, task.doc_id, task.parse_job_id,
        task.embedding_config, false,
      );
    } catch (error) {
      await markDocumentTerminalFailure(
        sql, task.doc_id, task.parse_job_id, task.embedding_config.model, (error as Error).message,
      );
    }
  }
}

/** Rust: rag::vector_pipeline::enqueue_document（按 active alias 解析物理索引） */
export async function enqueueDocumentJob(
  sql: Sql, tenantId: string, kbId: string, docId: string, parseJobId: string,
  config: EmbeddingConfig, force: boolean,
): Promise<string> {
  const target = (await activeIndex(sql, config.indexAlias))
    ?? physicalIndexName(config.indexName, config.model, config.dimension, config.indexSchemaVersion);
  return enqueueVectorJob(sql, tenantId, kbId, docId, parseJobId, target, config, force);
}

export async function insertPendingParseJob(
  tx: TransactionSql, scope: ParseWriteScope, parserConfig: Record<string, unknown>,
  parseIdentity: string,
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO document_parse_jobs (
        parse_job_id, tenant_id, kb_id, doc_id, parser_version, parser_config,
        parse_identity, status
     )
     VALUES (\$1, \$2, \$3, \$4, \$5, \$6, \$7, 'pending')`,
    [scope.parse_job_id, scope.tenant_id, scope.kb_id, scope.doc_id, PARSER_VERSION,
      toJson(parserConfig), parseIdentity],
  );

  await tx.unsafe(
    `INSERT INTO document_processing_events (tenant_id, doc_id, parse_job_id, stage, status, message)
     VALUES (\$1, \$2, \$3, 'waiting_parse', 'queued', '文件已保存，等待文档解析')`,
    [scope.tenant_id, scope.doc_id, scope.parse_job_id],
  );

  await tx.unsafe(
    `UPDATE documents
     SET latest_parse_job_id = \$1,
         parse_status = 'uploaded',
         parse_version = \$2,
         chunk_count = 0,
         metadata = metadata || \$3,
         updated_at = NOW()
     WHERE tenant_id = \$4 AND id = \$5`,
    [scope.parse_job_id, scope.parse_version,
      { active_parse_job_id: scope.parse_job_id, parse_progress: 10 },
      scope.tenant_id, scope.doc_id],
  );
}

export async function markParseJobRunning(sql: Sql, task: ParseJobTask): Promise<void> {
  const ocr = isOcrTask(task);
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `UPDATE document_parse_jobs
       SET status = 'running',
           attempt_count = attempt_count + 1,
           worker_id = \$4,
           heartbeat_at = NOW(),
           updated_at = NOW(),
           started_at = COALESCE(started_at, NOW())
       WHERE tenant_id = \$1 AND doc_id = \$2 AND parse_job_id = \$3
         AND status IN ('pending', 'ocr_queued', 'running')`,
      [task.tenant_id, task.doc_id, task.parse_job_id, `parse-worker-${process.pid}`],
    );

    await tx.unsafe(
      `INSERT INTO document_processing_events (tenant_id, doc_id, parse_job_id, stage, status, message)
       VALUES (\$1, \$2, \$3, \$4, 'running', \$5)`,
      [task.tenant_id, task.doc_id, task.parse_job_id,
        ocr ? 'ocr' : 'parsing', ocr ? '开始 OCR 增强' : '开始解析文档'],
    );

    await tx.unsafe(
      `UPDATE documents
       SET parse_status = \$1,
           metadata = metadata || \$2,
           updated_at = NOW()
       WHERE tenant_id = \$3 AND id = \$4`,
      [ocr ? 'ocr_pending' : 'parsing', toJson(parseRunningMetadata(task)), task.tenant_id, task.doc_id],
    );
  });
}

export async function markParseJobFailed(sql: Sql, task: ParseJobTask, err: AppError): Promise<void> {
  const [errorCode, errorMessage] = appErrorDetails(err);
  const ocr = isOcrTask(task);
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `UPDATE document_parse_jobs
       SET status = 'failed',
           error_code = \$1,
           error_message = \$2,
           worker_id = NULL,
           heartbeat_at = NOW(),
           updated_at = NOW(),
           completed_at = NOW()
       WHERE tenant_id = \$3 AND doc_id = \$4 AND parse_job_id = \$5`,
      [errorCode, errorMessage, task.tenant_id, task.doc_id, task.parse_job_id],
    );

    await tx.unsafe(
      `INSERT INTO document_processing_events (
          tenant_id, doc_id, parse_job_id, stage, status, message, error_code, error_message
       ) VALUES (\$1, \$2, \$3, \$4, 'failed', '文档处理失败', \$5, \$6)`,
      [task.tenant_id, task.doc_id, task.parse_job_id, ocr ? 'ocr' : 'parsing', errorCode, errorMessage],
    );

    await tx.unsafe(
      `UPDATE documents
       SET parse_status = \$1,
           chunk_count = 0,
           metadata = metadata || \$2,
           updated_at = NOW()
       WHERE tenant_id = \$3 AND id = \$4`,
      [ocr ? 'parse_low_confidence' : 'parse_failed',
        toJson(parseFailedMetadata(task, errorCode, errorMessage)), task.tenant_id, task.doc_id],
    );
  });
}

export function parseRunningMetadata(task: ParseJobTask): Record<string, unknown> {
  const ocr = isOcrTask(task);
  const metadata: Record<string, unknown> = {
    active_parse_job_id: task.parse_job_id,
    parse_progress: ocr ? 45 : 30,
  };
  if (ocr) metadata['ocr_status'] = 'running';
  return metadata;
}

export function parseFailedMetadata(
  task: ParseJobTask, errorCode: string, errorMessage: string,
): Record<string, unknown> {
  const ocr = isOcrTask(task);
  const metadata: Record<string, unknown> = {
    active_parse_job_id: task.parse_job_id,
    parse_progress: 100,
    error_code: errorCode,
    error_message: errorMessage,
  };
  if (ocr) metadata['ocr_status'] = 'failed';
  return metadata;
}

export async function buildParseArtifacts(task: ParseJobTask): Promise<ParseArtifacts> {
  const ocrTask = isOcrTask(task);
  let bundle: ParsedBundle;
  if (ocrTask) {
    bundle = await buildOcrBundle(task);
  } else {
    try {
      bundle = await parseDocument(
        task.doc_id, task.parse_job_id, task.file_name, task.mime_type, task.bytes,
      );
    } catch (error) {
      throw AppError.badRequest('DOCUMENT_PARSE_FAILED', (error as Error).message);
    }
  }
  let automaticOcrPages: number[] = [];
  if (!ocrTask && bundle.file_type === 'pdf') {
    automaticOcrPages = bundle.parsed.warnings.flatMap((warning) => {
      const match = /^pdf_page_(\d+)_no_text_layer$/u.exec(warning);
      return match ? [Number(match[1])] : [];
    });
    if (automaticOcrPages.length > 0) {
      try {
        bundle = await buildSelectiveOcrBundle(task, bundle, automaticOcrPages);
      } catch (error) {
        bundle.parsed.warnings.push(`automatic_ocr_failed:${appErrorDetails(
          error instanceof AppError ? error : AppError.internal((error as Error).message),
        )[0]}`);
      }
    }
  }
  bundle.parsed.title = task.title;
  const scannedPdfNoTextLayer = isScannedPdfNoTextLayer(bundle);
  const ocrEnhanced = ocrTask || bundle.parsed.warnings.some((warning) => warning.startsWith('automatic_ocr_pages:'));

  if (bundle.parsed.blocks.length === 0 && !scannedPdfNoTextLayer) {
    throw AppError.badRequest('DOCUMENT_EMPTY', '未能从文档中提取到可检索文本');
  }
  if (bundle.chunks.length === 0 && !scannedPdfNoTextLayer) {
    throw AppError.badRequest('DOCUMENT_EMPTY', '文档解析成功但没有生成有效切片');
  }

  const parseIdentity = task.parse_identity;
  const qualityScore = bundle.parsed.quality_score;
  let parseStatus = parseStatusForResult(qualityScore, scannedPdfNoTextLayer, ocrEnhanced);
  if (task.force_index && parseStatus === 'parse_low_confidence') {
    if (bundle.chunks.length === 0) {
      throw AppError.invalidState('FORCE_INDEX_UNAVAILABLE', '当前低置信文档没有有效切片，不能强制进入索引');
    }
    parseStatus = 'chunked';
  }

  const cleanStats = bundle.clean_stats as CleanStats;
  const cleanedBlocks = bundle.cleaned_blocks as CleanedBlock[];
  const parserConfig: Record<string, unknown> = {
    ...task.parser_config,
    warnings: bundle.parsed.warnings,
    quality_score: qualityScore,
    parse_status: parseStatus,
    force_index: task.force_index,
  };
  if (ocrEnhanced) {
    parserConfig['ocr_status'] = 'completed';
    parserConfig['ocr_engine'] = 'tesseract';
    parserConfig['ocr_render_dpi'] = OCR_RENDER_DPI;
    parserConfig['ocr_page_segmentation_mode'] = 3;
    parserConfig['ocr_mode'] = ocrTask ? 'manual_full' : 'automatic_missing_pages';
    parserConfig['ocr_pages'] = automaticOcrPages;
  }
  parserConfig['block_count'] = bundle.parsed.blocks.length;
  parserConfig['cleaned_block_count'] = cleanStats.output_blocks;
  parserConfig['removed_block_count'] = cleanStats.removed_blocks;
  parserConfig['table_count'] = bundle.parsed.tables.length;
  parserConfig['page_count'] = bundle.parsed.pages;
  parserConfig['chunk_count'] = bundle.chunks.length;
  parserConfig['char_count'] = cleanedBlocks
    .filter((block) => !block.is_removed)
    .reduce((sum, block) => sum + Array.from(block.cleaned_text).length, 0);
  parserConfig['clean_stats'] = cleanStats;

  return { bundle, parser_config: parserConfig, parse_identity: parseIdentity, quality_score: qualityScore, parse_status: parseStatus };
}

/** Rust: resume_pending_document_jobs */
export async function resumePendingDocumentJobs(state: AppState): Promise<number> {
  const sql = state.sql;
  if (sql === null) return 0;
  const rows = await sql.unsafe(
    `SELECT j.tenant_id, j.kb_id, j.doc_id, j.parse_job_id, j.parser_config,
            j.parse_identity, d.parse_version, d.title, d.file_type,
            COALESCE(d.metadata->>'original_filename', d.storage_key) AS file_name,
            COALESCE(d.metadata->>'mime_type', 'application/octet-stream') AS mime_type,
            d.storage_key
     FROM document_parse_jobs j
     JOIN documents d ON d.id = j.doc_id
     WHERE j.status IN ('pending', 'ocr_queued')
     ORDER BY j.created_at`,
  );
  let resumed = 0;
  for (const row of rows) {
    const storageKey = String(row.storage_key);
    let bytes: Uint8Array;
    try {
      bytes = await state.storage.get(storageKey);
    } catch (error) {
      await sql.unsafe(
        `UPDATE document_parse_jobs SET status = 'failed', error_code = 'ORIGINAL_FILE_MISSING',
         error_message = \$1, completed_at = NOW(), updated_at = NOW() WHERE parse_job_id = \$2`,
        [(error as Error).message, String(row.parse_job_id)],
      );
      continue;
    }
    const parserConfig = (row.parser_config ?? {}) as Record<string, unknown>;
    spawnParseJob(sql, {
      tenant_id: String(row.tenant_id),
      kb_id: String(row.kb_id),
      doc_id: String(row.doc_id),
      parse_job_id: String(row.parse_job_id),
      parse_version: Number(row.parse_version),
      title: String(row.title),
      file_name: String(row.file_name),
      mime_type: String(row.mime_type),
      file_type: String(row.file_type),
      force_index: parserConfig['force_index'] === true,
      parser_config: parserConfig,
      parse_identity: String(row.parse_identity),
      bytes,
      embedding_config: state.config.rag.embedding,
    });
    resumed += 1;
  }
  return resumed;
}

/** Rust: recover_interrupted_document_jobs */
export async function recoverInterruptedDocumentJobs(sql: Sql): Promise<number> {
  return sql.begin(async (tx) => {
    await tx.unsafe(
      `UPDATE document_parse_jobs
       SET status = 'failed',
           worker_id = NULL,
           heartbeat_at = NULL,
           error_code = 'RUNTIME_INTERRUPTED_RETRY_EXHAUSTED',
           error_message = '任务因服务反复中断，已达到最大重试次数',
           completed_at = NOW(),
           finished_at = NOW(),
           updated_at = NOW()
       WHERE status = 'running' AND attempt_count >= max_attempts`,
    );
    const result = await tx.unsafe(
      `UPDATE document_parse_jobs
       SET status = CASE WHEN parser_config->>'job_kind' = 'ocr' THEN 'ocr_queued' ELSE 'pending' END,
           worker_id = NULL,
           heartbeat_at = NULL,
           available_at = NOW(),
           error_code = 'RUNTIME_INTERRUPTED',
           error_message = '任务因服务重启已自动重新排队',
           started_at = NULL,
           completed_at = NULL,
           finished_at = NULL,
           updated_at = NOW()
       WHERE status = 'running' AND attempt_count < max_attempts`,
    );
    await tx.unsafe(
      `UPDATE documents d
       SET parse_status = CASE
             WHEN j.status = 'failed' AND j.parser_config->>'job_kind' = 'ocr' THEN 'parse_low_confidence'
             WHEN j.status = 'failed' THEN 'parse_failed'
             WHEN j.parser_config->>'job_kind' = 'ocr' THEN 'ocr_pending'
             ELSE 'uploaded'
           END,
           metadata = d.metadata || jsonb_build_object(
               'parse_progress', CASE WHEN j.status = 'failed' THEN 100 ELSE 10 END,
               'recovered_at', NOW(),
               'recovery_message', j.error_message
           ),
           updated_at = NOW()
       FROM document_parse_jobs j
       WHERE j.doc_id = d.id
         AND (
           j.status IN ('pending', 'ocr_queued')
           OR (j.status = 'failed' AND j.error_code = 'RUNTIME_INTERRUPTED_RETRY_EXHAUSTED')
         )
         AND (d.latest_parse_job_id = j.parse_job_id OR d.metadata->>'active_ocr_job_id' = j.parse_job_id::text)`,
    );
    return result.count;
  });
}

/** Rust: #[cfg(test)] interrupted_document_final_status */
export function interruptedDocumentFinalStatus(parseStatus: string, jobKind: string): string {
  if (parseStatus === 'embedding') return 'embedding_failed';
  if (parseStatus === 'ocr_pending' || jobKind === 'ocr') return 'parse_low_confidence';
  return 'parse_failed';
}

/** 供上传/重处理流程使用：新 job 的 pending 记录 */
export function newParseJobId(): string { return newUuid(); }

export { SCHEMA_VERSION };

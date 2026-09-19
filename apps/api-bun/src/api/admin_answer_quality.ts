import type { TransactionSql } from 'postgres';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { findPublishedCorrection, normalizeQuestion, QUALITY_CASE_STATUSES, QUALITY_ROOT_CAUSES } from '../answer_quality.ts';
import { recordAuditEvent } from '../auth/audit.ts';
import { requireTenantAdmin } from '../auth/permissions.ts';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import { newUuid, isUuid } from '../infra/uuid.ts';
import type { CurrentActor } from '../models/identity.ts';
import type { Sql } from '../repositories/sqlx_core.ts';

interface CorrectionSourceInput {
  kb_id?: string | null;
  doc_id?: string | null;
  chunk_id?: string | null;
  parse_job_id?: string | null;
  source_title?: string | null;
  quote?: string | null;
  page_range?: number[];
}

interface CorrectionInput {
  source_case_id?: string | null;
  canonical_question?: string;
  aliases?: string[];
  answer_markdown?: string;
  required_kb_ids?: string[];
  sources?: CorrectionSourceInput[];
  valid_until?: string | null;
  change_note?: string | null;
}
interface NormalizedCorrectionInput {
  sourceCaseId: string | null;
  canonicalQuestion: string;
  aliases: string[];
  answerMarkdown: string;
  requiredKbIds: string[];
  sources: CorrectionSourceInput[];
  validUntil: string | null;
  changeNote: string | null;
}

export function adminAnswerQualityRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/admin/answer-quality/summary', summary);
  router.get('/api/admin/answer-quality/cases', listCases);
  router.get('/api/admin/answer-quality/cases/:id', getCase);
  router.post('/api/admin/answer-quality/cases/:id/diagnose', diagnoseCase);
  router.patch('/api/admin/answer-quality/cases/:id', updateCase);
  router.get('/api/admin/answer-corrections', listCorrections);
  router.post('/api/admin/answer-corrections', createCorrection);
  router.post('/api/admin/answer-corrections/match-preview', matchPreview);
  router.get('/api/admin/answer-corrections/:id', getCorrection);
  router.patch('/api/admin/answer-corrections/:id', updateCorrection);
  router.post('/api/admin/answer-corrections/:id/publish', publishCorrection);
  router.post('/api/admin/answer-corrections/:id/archive', archiveCorrection);
  return router;
}

async function summary(c: Context<AppEnv>): Promise<Response> {
  const { sql, tenantId } = adminContext(c);
  const rows = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM answer_quality_cases WHERE tenant_id = ${tenantId} AND status IN ('open', 'in_review')) AS pending_cases,
      (SELECT COUNT(*)::int FROM answer_corrections WHERE tenant_id = ${tenantId} AND status = 'published') AS published_corrections,
      (SELECT COUNT(*)::int FROM answer_corrections WHERE tenant_id = ${tenantId} AND status = 'needs_review') AS needs_review,
      (SELECT COUNT(*)::int FROM conversation_feedback f
         JOIN conversation_messages m ON m.id = f.assistant_message_id
        WHERE m.tenant_id = ${tenantId} AND f.rating = 'down' AND f.cleared_at IS NULL
          AND f.updated_at >= NOW() - INTERVAL '7 days') AS down_count,
      (SELECT COUNT(*)::int FROM conversation_feedback f
         JOIN conversation_messages m ON m.id = f.assistant_message_id
        WHERE m.tenant_id = ${tenantId} AND f.cleared_at IS NULL
          AND f.updated_at >= NOW() - INTERVAL '7 days') AS rated_count,
      (SELECT COUNT(*)::int FROM conversation_messages
        WHERE tenant_id = ${tenantId} AND role = 'assistant' AND status = 'completed'
          AND created_at >= NOW() - INTERVAL '7 days') AS answer_count
  `;
  const row = rows[0] ?? {};
  const downCount = Number(row.down_count ?? 0);
  const ratedCount = Number(row.rated_count ?? 0);
  const answerCount = Number(row.answer_count ?? 0);
  return c.json({
    pending_cases: Number(row.pending_cases ?? 0),
    published_corrections: Number(row.published_corrections ?? 0),
    needs_review: Number(row.needs_review ?? 0),
    downvote_rate: ratedCount === 0 ? 0 : downCount / ratedCount,
    feedback_coverage: answerCount === 0 ? 0 : ratedCount / answerCount,
  });
}

async function listCases(c: Context<AppEnv>): Promise<Response> {
  const { sql, tenantId } = adminContext(c);
  const status = optionalEnum(c.req.query('status'), QUALITY_CASE_STATUSES, 'INVALID_CASE_STATUS');
  const rootCause = optionalEnum(c.req.query('root_cause'), QUALITY_ROOT_CAUSES, 'INVALID_ROOT_CAUSE');
  const kbId = optionalUuid(c.req.query('kb_id'), 'INVALID_KB_ID');
  const searchText = c.req.query('q')?.trim() ?? '';
  const q = searchText === '' ? null : `%${searchText}%`;
  const limit = boundedInt(c.req.query('limit'), 50, 1, 200);
  const offset = boundedInt(c.req.query('cursor'), 0, 0, 1_000_000);
  const rows = await sql`
    SELECT quality_case.*,
           COALESCE(stats.active_downvotes, 0)::int AS active_downvotes,
           COALESCE(stats.affected_users, 0)::int AS affected_users,
           COALESCE(stats.total_reports, 0)::int AS total_reports
    FROM answer_quality_cases quality_case
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE item.active)::int AS active_downvotes,
             COUNT(DISTINCT item.user_id) FILTER (WHERE item.active)::int AS affected_users,
             COUNT(*)::int AS total_reports
      FROM answer_quality_case_items item
      WHERE item.case_id = quality_case.id
    ) stats ON TRUE
    WHERE quality_case.tenant_id = ${tenantId}
      AND (${status}::text IS NULL OR quality_case.status = ${status})
      AND (${rootCause}::text IS NULL OR quality_case.root_cause = ${rootCause})
      AND (${kbId}::uuid IS NULL OR ${kbId}::uuid = ANY(quality_case.kb_ids))
      AND (${q}::text IS NULL OR quality_case.canonical_question ILIKE ${q})
    ORDER BY COALESCE(stats.active_downvotes, 0) DESC, quality_case.last_seen_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return c.json({
    items: rows.map(caseSummary),
    next_cursor: rows.length === limit ? String(offset + limit) : null,
  });
}

async function getCase(c: Context<AppEnv>): Promise<Response> {
  const { sql, tenantId } = adminContext(c);
  const caseId = pathUuid(c, 'id');
  const rows = await sql`
    SELECT quality_case.*,
           (SELECT COUNT(*)::int FROM answer_quality_case_items item
             WHERE item.case_id = quality_case.id AND item.active) AS active_downvotes,
           (SELECT COUNT(DISTINCT item.user_id)::int FROM answer_quality_case_items item
             WHERE item.case_id = quality_case.id AND item.active) AS affected_users,
           (SELECT COUNT(*)::int FROM answer_quality_case_items item
             WHERE item.case_id = quality_case.id) AS total_reports
    FROM answer_quality_cases quality_case
    WHERE quality_case.id = ${caseId} AND quality_case.tenant_id = ${tenantId}
  `;
  const qualityCase = rows[0];
  if (qualityCase === undefined) throw AppError.notFound('QUALITY_CASE_NOT_FOUND', '质量问题不存在');
  const items = await sql`
    SELECT item.*, COALESCE(app_user.name, app_user.email, '未知用户') AS user_name
    FROM answer_quality_case_items item
    LEFT JOIN app_user ON app_user.id = item.user_id
    WHERE item.case_id = ${caseId}
    ORDER BY item.updated_at DESC
    LIMIT 100
  `;
  const first = items[0];
  const evidence = first?.assistant_message_id
    ? await caseEvidence(sql, String(first.assistant_message_id))
    : null;
  return c.json({ ...caseSummary(qualityCase), items: items.map(caseItem), evidence });
}

async function diagnoseCase(c: Context<AppEnv>): Promise<Response> {
  const { sql, tenantId, actor } = adminContext(c);
  const caseId = pathUuid(c, 'id');
  const rows = await sql`
    SELECT item.assistant_message_id
    FROM answer_quality_cases quality_case
    JOIN answer_quality_case_items item ON item.case_id = quality_case.id
    WHERE quality_case.id = ${caseId} AND quality_case.tenant_id = ${tenantId}
      AND item.active = TRUE AND item.assistant_message_id IS NOT NULL
    ORDER BY item.updated_at DESC LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) throw AppError.notFound('QUALITY_CASE_NOT_FOUND', '没有可诊断的活跃反馈');
  const evidence = await caseEvidence(sql, String(row.assistant_message_id));
  const retrievals = evidence.retrieval_traces as Array<Record<string, unknown>>;
  const citations = evidence.citations as Array<Record<string, unknown>>;
  const hasRetrieved = retrievals.some((trace) => trace.source !== 'rerank');
  const hasReranked = retrievals.some((trace) => trace.source === 'rerank');
  let suggestedCause = 'retrieval_miss';
  let reason = '原回答没有形成可用引用，需要确认知识是否存在以及检索范围是否正确。';
  if (hasRetrieved && !hasReranked) {
    suggestedCause = 'rerank_drop';
    reason = '原始召回存在候选，但没有片段进入重排后的证据集。';
  } else if (hasReranked && citations.length > 0) {
    suggestedCause = 'generation_error';
    reason = '已有重排证据和引用，优先检查答案生成是否误读或遗漏证据。';
  } else if (!hasRetrieved && citations.length === 0) {
    suggestedCause = 'retrieval_miss';
    reason = '未保存到有效召回或引用，优先检查问题改写、知识库范围和知识缺失。';
  }
  const snapshot = {
    suggested_cause: suggestedCause,
    reason,
    retrieval_count: retrievals.length,
    citation_count: citations.length,
    diagnosed_at: new Date().toISOString(),
  };
  await sql`
    UPDATE answer_quality_cases
    SET suggested_cause = ${suggestedCause}, diagnostic_snapshot = ${sql.json(snapshot)},
        status = CASE WHEN status = 'open' THEN 'in_review' ELSE status END,
        updated_at = NOW()
    WHERE id = ${caseId} AND tenant_id = ${tenantId}
  `;
  await recordAuditEvent(sql, actor, 'answer_quality.case.diagnose', 'answer_quality_case', caseId, snapshot);
  return c.json(snapshot);
}

async function updateCase(c: Context<AppEnv>): Promise<Response> {
  const { sql, tenantId, actor } = adminContext(c);
  const caseId = pathUuid(c, 'id');
  const request = await c.req.json() as Record<string, unknown>;
  const status = optionalEnum(stringValue(request.status), QUALITY_CASE_STATUSES, 'INVALID_CASE_STATUS');
  const rootCause = optionalEnum(stringValue(request.root_cause), QUALITY_ROOT_CAUSES, 'INVALID_ROOT_CAUSE');
  const resolutionNote = nullableTrimmed(request.resolution_note, 4_000);
  if (status === null && rootCause === null && resolutionNote === null) {
    throw AppError.badRequest('EMPTY_UPDATE', '至少提供一个需要修改的字段');
  }
  const rows = await sql`
    UPDATE answer_quality_cases
    SET status = COALESCE(${status}, status),
        root_cause = COALESCE(${rootCause}, root_cause),
        resolution_note = COALESCE(${resolutionNote}, resolution_note),
        updated_at = NOW()
    WHERE id = ${caseId} AND tenant_id = ${tenantId}
    RETURNING *
  `;
  const row = rows[0];
  if (row === undefined) throw AppError.notFound('QUALITY_CASE_NOT_FOUND', '质量问题不存在');
  await recordAuditEvent(sql, actor, 'answer_quality.case.update', 'answer_quality_case', caseId, {
    status, root_cause: rootCause, resolution_note: resolutionNote,
  });
  return c.json(caseSummary(row));
}

async function listCorrections(c: Context<AppEnv>): Promise<Response> {
  const { sql, tenantId } = adminContext(c);
  const status = c.req.query('status')?.trim() || null;
  const qText = c.req.query('q')?.trim() ?? '';
  const q = qText === '' ? null : `%${qText}%`;
  const limit = boundedInt(c.req.query('limit'), 100, 1, 200);
  const rows = await sql`
    SELECT correction.*, version.version, version.canonical_question, version.answer_markdown,
           COALESCE(hit_stats.hit_count, 0)::int AS hit_count
    FROM answer_corrections correction
    LEFT JOIN answer_correction_versions version
      ON version.id = COALESCE(correction.draft_version_id, correction.published_version_id)
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS hit_count FROM conversation_messages message
      WHERE message.correction_id = correction.id AND message.answer_source = 'manual_correction'
    ) hit_stats ON TRUE
    WHERE correction.tenant_id = ${tenantId}
      AND (${status}::text IS NULL OR correction.status = ${status})
      AND (${q}::text IS NULL OR version.canonical_question ILIKE ${q} OR version.answer_markdown ILIKE ${q})
    ORDER BY correction.updated_at DESC
    LIMIT ${limit}
  `;
  return c.json({ items: rows.map(correctionSummary) });
}

async function getCorrection(c: Context<AppEnv>): Promise<Response> {
  const { sql, tenantId } = adminContext(c);
  return c.json(await correctionDetail(sql, tenantId, pathUuid(c, 'id')));
}

async function createCorrection(c: Context<AppEnv>): Promise<Response> {
  const { sql, tenantId, actor } = adminContext(c);
  const input = await correctionInput(c, tenantId, sql);
  const correctionId = newUuid();
  const versionId = newUuid();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO answer_corrections (
        id, tenant_id, source_case_id, status, required_kb_ids,
        valid_until, created_by
      ) VALUES (
        ${correctionId}, ${tenantId}, ${input.sourceCaseId}, 'draft', ${input.requiredKbIds},
        ${input.validUntil}, ${actor.user_id}
      )
    `;
    await insertVersion(tx, tenantId, correctionId, versionId, 1, actor.user_id, input);
    await tx`
      UPDATE answer_corrections SET draft_version_id = ${versionId} WHERE id = ${correctionId}
    `;
  });
  await recordAuditEvent(sql, actor, 'answer_correction.create', 'answer_correction', correctionId, {
    source_case_id: input.sourceCaseId, required_kb_ids: input.requiredKbIds,
  });
  return c.json(await correctionDetail(sql, tenantId, correctionId), 201);
}

async function updateCorrection(c: Context<AppEnv>): Promise<Response> {
  const { sql, tenantId, actor } = adminContext(c);
  const correctionId = pathUuid(c, 'id');
  const existing = await correctionDetail(sql, tenantId, correctionId);
  if (existing.status === 'archived') throw AppError.invalidState('CORRECTION_ARCHIVED', '已归档答案不能编辑');
  const input = await correctionInput(c, tenantId, sql, existing);
  const versionId = newUuid();
  const nextVersion = Number(existing.latest_version ?? 0) + 1;
  await sql.begin(async (tx) => {
    await insertVersion(tx, tenantId, correctionId, versionId, nextVersion, actor.user_id, input);
    await tx`
      UPDATE answer_corrections
      SET draft_version_id = ${versionId}, required_kb_ids = ${input.requiredKbIds},
          valid_until = ${input.validUntil}, updated_at = NOW(), index_status = 'pending'
      WHERE id = ${correctionId} AND tenant_id = ${tenantId}
    `;
  });
  await recordAuditEvent(sql, actor, 'answer_correction.update', 'answer_correction', correctionId, {
    version: nextVersion, required_kb_ids: input.requiredKbIds,
  });
  return c.json(await correctionDetail(sql, tenantId, correctionId));
}

async function publishCorrection(c: Context<AppEnv>): Promise<Response> {
  const { sql, tenantId, actor } = adminContext(c);
  const correctionId = pathUuid(c, 'id');
  const rows = await sql`
    SELECT draft_version_id FROM answer_corrections
    WHERE id = ${correctionId} AND tenant_id = ${tenantId} AND status <> 'archived'
  `;
  const draftVersionId = nullableString(rows[0]?.draft_version_id);
  if (draftVersionId === null) throw AppError.invalidState('NO_DRAFT_VERSION', '没有可发布的草稿版本');
  const conflicts = await sql`
    SELECT candidate.normalized_text
    FROM answer_correction_aliases candidate
    JOIN answer_correction_aliases active
      ON active.tenant_id = candidate.tenant_id
     AND active.normalized_text = candidate.normalized_text
     AND active.active = TRUE
     AND active.correction_id <> candidate.correction_id
    WHERE candidate.version_id = ${draftVersionId}
    LIMIT 1
  `;
  if (conflicts[0] !== undefined) {
    throw AppError.conflictWith('CORRECTION_ALIAS_CONFLICT', `问法“${String(conflicts[0].normalized_text)}”已由其他标准答案使用`);
  }
  await sql.begin(async (tx) => {
    await tx`UPDATE answer_correction_aliases SET active = FALSE WHERE correction_id = ${correctionId}`;
    await tx`UPDATE answer_correction_aliases SET active = TRUE WHERE version_id = ${draftVersionId}`;
    await tx`
      UPDATE answer_corrections
      SET status = 'published', published_version_id = ${draftVersionId}, draft_version_id = NULL,
          published_by = ${actor.user_id}, published_at = NOW(), updated_at = NOW(), index_status = 'indexed'
      WHERE id = ${correctionId} AND tenant_id = ${tenantId}
    `;
    await tx`
      UPDATE answer_quality_cases
      SET status = 'resolved', correction_id = ${correctionId}, updated_at = NOW()
      WHERE tenant_id = ${tenantId} AND id = (
        SELECT source_case_id FROM answer_corrections WHERE id = ${correctionId}
      )
    `;
  });
  await recordAuditEvent(sql, actor, 'answer_correction.publish', 'answer_correction', correctionId, {
    version_id: draftVersionId,
  });
  return c.json(await correctionDetail(sql, tenantId, correctionId));
}

async function archiveCorrection(c: Context<AppEnv>): Promise<Response> {
  const { sql, tenantId, actor } = adminContext(c);
  const correctionId = pathUuid(c, 'id');
  const result = await sql.begin(async (tx) => {
    await tx`UPDATE answer_correction_aliases SET active = FALSE WHERE correction_id = ${correctionId}`;
    return tx`
      UPDATE answer_corrections
      SET status = 'archived', updated_at = NOW()
      WHERE id = ${correctionId} AND tenant_id = ${tenantId}
      RETURNING id
    `;
  });
  if (result[0] === undefined) throw AppError.notFound('CORRECTION_NOT_FOUND', '标准答案不存在');
  await recordAuditEvent(sql, actor, 'answer_correction.archive', 'answer_correction', correctionId, {});
  return c.json(await correctionDetail(sql, tenantId, correctionId));
}

async function matchPreview(c: Context<AppEnv>): Promise<Response> {
  const { sql, tenantId } = adminContext(c);
  const request = await c.req.json() as Record<string, unknown>;
  const question = requiredText(request.question, 'question', 4_000);
  const kbIds = uuidArray(request.kb_ids);
  const match = await findPublishedCorrection(sql, tenantId, question, kbIds);
  return c.json({ matched: match !== null, match });
}

async function correctionInput(
  c: Context<AppEnv>, tenantId: string, sql: Sql, defaults?: Record<string, unknown>,
): Promise<NormalizedCorrectionInput> {
  const request = await c.req.json() as CorrectionInput;
  const canonicalQuestion = request.canonical_question === undefined
    ? requiredText(defaults?.canonical_question, 'canonical_question', 4_000)
    : requiredText(request.canonical_question, 'canonical_question', 4_000);
  const answerMarkdown = request.answer_markdown === undefined
    ? requiredText(defaults?.answer_markdown, 'answer_markdown', 40_000)
    : requiredText(request.answer_markdown, 'answer_markdown', 40_000);
  const requiredKbIds = request.required_kb_ids === undefined
    ? uuidArray(defaults?.required_kb_ids)
    : uuidArray(request.required_kb_ids);
  await validateTenantKnowledgeBases(sql, tenantId, requiredKbIds);
  const aliases = request.aliases === undefined
    ? stringArray(defaults?.aliases)
    : stringArray(request.aliases);
  const sourceCaseId = request.source_case_id === undefined
    ? nullableUuid(defaults?.source_case_id, 'INVALID_CASE_ID')
    : nullableUuid(request.source_case_id, 'INVALID_CASE_ID');
  const validUntil = request.valid_until === undefined
    ? nullableDate(defaults?.valid_until)
    : nullableDate(request.valid_until);
  const sources = request.sources === undefined
    ? sourceArray(defaults?.sources)
    : sourceArray(request.sources);
  return {
    sourceCaseId, canonicalQuestion, aliases, answerMarkdown, requiredKbIds, sources, validUntil,
    changeNote: request.change_note === undefined
      ? nullableTrimmed(defaults?.change_note, 4_000)
      : nullableTrimmed(request.change_note, 4_000),
  };
}

async function insertVersion(
  tx: TransactionSql, tenantId: string, correctionId: string,
  versionId: string, version: number, userId: string,
  input: NormalizedCorrectionInput,
): Promise<void> {
  await tx`
    INSERT INTO answer_correction_versions (
      id, correction_id, version, canonical_question, answer_markdown, change_note, created_by
    ) VALUES (
      ${versionId}, ${correctionId}, ${version}, ${input.canonicalQuestion},
      ${input.answerMarkdown}, ${input.changeNote}, ${userId}
    )
  `;
  const aliases = dedupeQuestions(input.canonicalQuestion, input.aliases);
  for (let index = 0; index < aliases.length; index += 1) {
    const question = aliases[index]!;
    await tx`
      INSERT INTO answer_correction_aliases (
        tenant_id, correction_id, version_id, question_text, normalized_text, is_primary
      ) VALUES (
        ${tenantId}, ${correctionId}, ${versionId}, ${question}, ${normalizeQuestion(question)}, ${index === 0}
      )
    `;
  }
  for (const source of input.sources) {
    await tx`
      INSERT INTO answer_correction_sources (
        version_id, kb_id, doc_id, chunk_id, parse_job_id, source_title, quote, page_range
      ) VALUES (
        ${versionId}, ${nullableUuid(source.kb_id, 'INVALID_SOURCE_KB_ID')},
        ${nullableUuid(source.doc_id, 'INVALID_SOURCE_DOC_ID')},
        ${nullableUuid(source.chunk_id, 'INVALID_SOURCE_CHUNK_ID')},
        ${nullableUuid(source.parse_job_id, 'INVALID_SOURCE_PARSE_JOB_ID')},
        ${source.source_title?.trim() || '租户标准答案'}, ${source.quote?.trim() ?? ''},
        ${Array.isArray(source.page_range) ? source.page_range.map(Number).filter(Number.isFinite) : []}
      )
    `;
  }
}

async function correctionDetail(sql: Sql, tenantId: string, correctionId: string): Promise<Record<string, unknown>> {
  const rows = await sql`
    SELECT correction.*, version.version AS latest_version, version.canonical_question,
           version.answer_markdown, version.change_note
    FROM answer_corrections correction
    LEFT JOIN answer_correction_versions version
      ON version.id = COALESCE(correction.draft_version_id, correction.published_version_id)
    WHERE correction.id = ${correctionId} AND correction.tenant_id = ${tenantId}
  `;
  const row = rows[0];
  if (row === undefined) throw AppError.notFound('CORRECTION_NOT_FOUND', '标准答案不存在');
  const versionId = nullableString(row.draft_version_id) ?? nullableString(row.published_version_id);
  const aliases = versionId === null ? [] : await sql`
    SELECT question_text, is_primary FROM answer_correction_aliases
    WHERE version_id = ${versionId} ORDER BY is_primary DESC, created_at ASC
  `;
  const sources = versionId === null ? [] : await sql`
    SELECT kb_id, doc_id, chunk_id, parse_job_id, source_title, quote, page_range
    FROM answer_correction_sources WHERE version_id = ${versionId} ORDER BY created_at ASC
  `;
  return {
    ...correctionSummary(row),
    aliases: aliases.map((alias) => String(alias.question_text)).filter((_, index) => index > 0),
    sources: sources.map((source) => ({
      kb_id: nullableString(source.kb_id), doc_id: nullableString(source.doc_id),
      chunk_id: nullableString(source.chunk_id), parse_job_id: nullableString(source.parse_job_id),
      source_title: String(source.source_title), quote: String(source.quote),
      page_range: Array.isArray(source.page_range) ? source.page_range.map(Number) : [],
    })),
  };
}

async function caseEvidence(sql: Sql, assistantMessageId: string): Promise<Record<string, unknown>> {
  const messages = await sql`
    SELECT assistant.content AS answer, assistant.parent_message_id,
           question.content AS question, query.original_query, query.rewritten_query,
           query.keywords, query.effective_kb_ids
    FROM conversation_messages assistant
    LEFT JOIN conversation_messages question ON question.id = assistant.parent_message_id
    LEFT JOIN conversation_query_traces query ON query.message_id = question.id
    WHERE assistant.id = ${assistantMessageId}
  `;
  const retrievals = await sql`
    SELECT source, rank, score, doc_id, chunk_id, heading_path, page_range, content_preview
    FROM conversation_retrieval_traces
    WHERE message_id = (SELECT parent_message_id FROM conversation_messages WHERE id = ${assistantMessageId})
    ORDER BY CASE source WHEN 'rerank' THEN 2 ELSE 1 END, rank ASC
  `;
  const citations = await sql`
    SELECT citation.index, citation.doc_id, citation.chunk_id, citation.doc_title,
           citation.page_range, citation.quote, citation.score,
           CASE
             WHEN document.id IS NULL OR document.parse_status = 'deleted' THEN 'deleted'
             ELSE 'available'
           END AS source_status
    FROM conversation_citations citation
    LEFT JOIN documents document ON document.id = citation.doc_id
    WHERE citation.assistant_message_id = ${assistantMessageId}
    ORDER BY citation.index ASC
  `;
  return { ...(messages[0] ?? {}), retrieval_traces: retrievals, citations };
}

function caseSummary(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id), canonical_question: String(row.canonical_question),
    kb_ids: Array.isArray(row.kb_ids) ? row.kb_ids.map(String) : [],
    status: String(row.status), suggested_cause: nullableString(row.suggested_cause),
    root_cause: nullableString(row.root_cause), resolution_note: nullableString(row.resolution_note),
    correction_id: nullableString(row.correction_id),
    active_downvotes: Number(row.active_downvotes ?? 0), affected_users: Number(row.affected_users ?? 0),
    total_reports: Number(row.total_reports ?? 0), diagnostic_snapshot: row.diagnostic_snapshot ?? {},
    first_seen_at: dateString(row.first_seen_at), last_seen_at: dateString(row.last_seen_at),
    updated_at: dateString(row.updated_at),
  };
}

function caseItem(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id), feedback_id: nullableString(row.feedback_id),
    assistant_message_id: nullableString(row.assistant_message_id), user_id: nullableString(row.user_id),
    user_name: String(row.user_name), question: String(row.question_snapshot), answer: String(row.answer_snapshot),
    reason: nullableString(row.reason), comment: nullableString(row.comment),
    suggested_correction: nullableString(row.suggested_correction), active: row.active === true,
    created_at: dateString(row.created_at), updated_at: dateString(row.updated_at),
  };
}

function correctionSummary(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id), status: String(row.status),
    source_case_id: nullableString(row.source_case_id),
    required_kb_ids: Array.isArray(row.required_kb_ids) ? row.required_kb_ids.map(String) : [],
    published_version_id: nullableString(row.published_version_id), draft_version_id: nullableString(row.draft_version_id),
    latest_version: Number(row.latest_version ?? row.version ?? 0),
    canonical_question: String(row.canonical_question ?? ''), answer_markdown: String(row.answer_markdown ?? ''),
    change_note: nullableString(row.change_note), index_status: String(row.index_status),
    hit_count: Number(row.hit_count ?? 0), valid_until: dateStringOrNull(row.valid_until),
    published_at: dateStringOrNull(row.published_at), created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function adminContext(c: Context<AppEnv>): { sql: Sql; tenantId: string; actor: CurrentActor } {
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  const sql = c.get('appState').sql;
  if (!sql) throw AppError.internal('数据库未配置');
  return { sql, tenantId: actor.tenant_id, actor };
}

function pathUuid(c: Context<AppEnv>, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || !isUuid(value)) {
    throw AppError.badRequest('INVALID_PATH_PARAM', '路径参数必须是 UUID');
  }
  return value;
}

function optionalUuid(value: string | undefined, code: string): string | null {
  if (value === undefined || value.trim() === '') return null;
  if (!isUuid(value)) throw AppError.badRequest(code, '参数必须是 UUID');
  return value;
}

function nullableUuid(value: unknown, code: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !isUuid(value)) throw AppError.badRequest(code, '参数必须是 UUID');
  return value;
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

function optionalEnum<T extends string>(
  value: string | null | undefined, allowed: readonly T[], code: string,
): T | null {
  if (value === null || value === undefined || value === '') return null;
  if (!allowed.includes(value as T)) throw AppError.badRequest(code, `无效值：${value}`);
  return value as T;
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw AppError.badRequest('INVALID_REQUEST_BODY', `${field} 字段必填`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw AppError.badRequest('INVALID_REQUEST_BODY', `${field} 内容过长`);
  return trimmed;
}

function nullableTrimmed(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw AppError.badRequest('INVALID_REQUEST_BODY', '文本字段类型错误');
  const trimmed = value.trim();
  if (trimmed.length > max) throw AppError.badRequest('INVALID_REQUEST_BODY', '文本字段内容过长');
  return trimmed === '' ? null : trimmed;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw AppError.badRequest('INVALID_REQUEST_BODY', 'aliases 必须是字符串数组');
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function uuidArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !isUuid(item))) {
    throw AppError.badRequest('INVALID_REQUEST_BODY', '知识库列表必须是 UUID 数组');
  }
  return [...new Set(value as string[])];
}

function sourceArray(value: unknown): CorrectionSourceInput[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'object' || item === null)) {
    throw AppError.badRequest('INVALID_REQUEST_BODY', 'sources 必须是对象数组');
  }
  return value as CorrectionSourceInput[];
}

function nullableDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw AppError.badRequest('INVALID_REQUEST_BODY', 'valid_until 必须是有效时间');
  }
  return new Date(value).toISOString();
}

async function validateTenantKnowledgeBases(sql: Sql, tenantId: string, kbIds: string[]): Promise<void> {
  if (kbIds.length === 0) return;
  const rows = await sql`
    SELECT COUNT(*)::int AS count FROM knowledge_base
    WHERE tenant_id = ${tenantId} AND id = ANY(${kbIds}::uuid[]) AND status = 'active'
  `;
  if (Number(rows[0]?.count ?? 0) !== kbIds.length) throw AppError.kbScopeDenied();
}

function dedupeQuestions(canonical: string, aliases: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const question of [canonical, ...aliases]) {
    const normalized = normalizeQuestion(question);
    if (normalized === '' || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(question.trim());
  }
  return result;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function dateString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function dateStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : dateString(value);
}

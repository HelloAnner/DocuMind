import { createHash } from 'node:crypto';
import type { Feedback } from './models/feedback.ts';
import type { ConversationRepository } from './repositories/types.ts';
import type { Sql } from './repositories/sqlx_core.ts';

export const QUALITY_CASE_STATUSES = ['open', 'in_review', 'resolved', 'dismissed'] as const;
export const QUALITY_ROOT_CAUSES = [
  'knowledge_missing', 'knowledge_outdated', 'knowledge_conflict',
  'query_rewrite_error', 'retrieval_miss', 'rerank_drop', 'kb_scope_error',
  'generation_error', 'citation_mismatch', 'ambiguous_question', 'no_issue', 'unknown',
] as const;

export type QualityCaseStatus = typeof QUALITY_CASE_STATUSES[number];
export type QualityRootCause = typeof QUALITY_ROOT_CAUSES[number];

export interface CorrectionSourceMatch {
  kb_id: string | null;
  doc_id: string | null;
  chunk_id: string | null;
  parse_job_id: string | null;
  source_title: string;
  quote: string;
  page_range: number[];
}

export interface PublishedCorrectionMatch {
  correction_id: string;
  version_id: string;
  answer_markdown: string;
  match_type: 'exact' | 'alias';
  match_score: number;
  sources: CorrectionSourceMatch[];
}

export function normalizeQuestion(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .replace(/[，,。.!！?？;；:：、]+$/u, '')
    .replace(/\s+/gu, ' ');
}

export function questionFingerprint(value: string): string {
  return sha256(normalizeQuestion(value));
}

export function kbScopeHash(kbIds: string[]): string {
  return sha256([...new Set(kbIds)].sort().join(','));
}

export async function syncFeedbackQualityCase(
  sql: Sql | null,
  repo: ConversationRepository,
  tenantId: string,
  conversationId: string,
  assistantMessageId: string,
  feedback: Feedback,
): Promise<void> {
  if (!sql) return;
  if (feedback.rating !== 'down' || feedback.cleared_at !== null) {
    await deactivateFeedbackCaseItem(sql, feedback.id);
    return;
  }
  const [session, assistant] = await Promise.all([
    repo.getSession(tenantId, conversationId),
    repo.getMessage(tenantId, assistantMessageId),
  ]);
  if (session === null || assistant === null || assistant.parent_message_id === null) return;
  const question = await repo.getMessage(tenantId, assistant.parent_message_id);
  if (question === null) return;
  const trace = await repo.getQueryTrace(question.id);
  const kbIds = trace?.effective_kb_ids ?? session.kb_ids;
  const fingerprint = questionFingerprint(question.content);
  const scopeHash = kbScopeHash(kbIds);

  await sql.begin(async (tx) => {
    const cases = await tx`
      INSERT INTO answer_quality_cases (
        tenant_id, canonical_question, question_fingerprint, kb_ids, kb_scope_hash
      ) VALUES (${tenantId}, ${question.content}, ${fingerprint}, ${kbIds}, ${scopeHash})
      ON CONFLICT (tenant_id, question_fingerprint, kb_scope_hash)
      DO UPDATE SET
        last_seen_at = NOW(),
        updated_at = NOW(),
        status = CASE
          WHEN answer_quality_cases.status IN ('resolved', 'dismissed') THEN 'open'
          ELSE answer_quality_cases.status
        END
      RETURNING id
    `;
    const qualityCase = cases[0];
    if (qualityCase === undefined) return;
    await tx`
      INSERT INTO answer_quality_case_items (
        case_id, feedback_id, assistant_message_id, user_id,
        question_snapshot, answer_snapshot, reason, comment,
        suggested_correction, kb_ids, active
      ) VALUES (
        ${String(qualityCase.id)}, ${feedback.id}, ${assistantMessageId}, ${feedback.user_id},
        ${question.content}, ${assistant.content}, ${feedback.reason}, ${feedback.comment},
        ${feedback.correction}, ${kbIds}, TRUE
      )
      ON CONFLICT (feedback_id)
      DO UPDATE SET
        reason = EXCLUDED.reason,
        comment = EXCLUDED.comment,
        suggested_correction = EXCLUDED.suggested_correction,
        active = TRUE,
        updated_at = NOW()
    `;
  });
}

export async function deactivateFeedbackCaseItem(
  sql: Sql | null, feedbackId: string,
): Promise<void> {
  if (!sql) return;
  await sql`
    UPDATE answer_quality_case_items
    SET active = FALSE, updated_at = NOW()
    WHERE feedback_id = ${feedbackId}
  `;
}

export async function deactivateFeedbackCaseItemByMessage(
  sql: Sql | null, assistantMessageId: string, userId: string,
): Promise<void> {
  if (!sql) return;
  await sql`
    UPDATE answer_quality_case_items item
    SET active = FALSE, updated_at = NOW()
    FROM conversation_feedback feedback
    WHERE item.feedback_id = feedback.id
      AND feedback.assistant_message_id = ${assistantMessageId}
      AND feedback.user_id = ${userId}
  `;
}

export async function findPublishedCorrection(
  sql: Sql | null,
  tenantId: string,
  question: string,
  effectiveKbIds: string[],
): Promise<PublishedCorrectionMatch | null> {
  if (!sql) return null;
  const normalized = normalizeQuestion(question);
  if (normalized === '') return null;
  const rows = await sql`
    SELECT c.id AS correction_id,
           v.id AS version_id,
           v.answer_markdown,
           a.is_primary
    FROM answer_correction_aliases a
    JOIN answer_corrections c
      ON c.id = a.correction_id AND c.tenant_id = a.tenant_id
    JOIN answer_correction_versions v
      ON v.id = a.version_id AND v.id = c.published_version_id
    WHERE a.tenant_id = ${tenantId}
      AND a.active = TRUE
      AND a.normalized_text = ${normalized}
      AND c.status = 'published'
      AND (c.valid_until IS NULL OR c.valid_until > NOW())
      AND c.required_kb_ids <@ ${effectiveKbIds}::uuid[]
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) return null;
  const versionId = String(row.version_id);
  const sources = await sql`
    SELECT kb_id, doc_id, chunk_id, parse_job_id, source_title, quote, page_range
    FROM answer_correction_sources
    WHERE version_id = ${versionId}
    ORDER BY created_at ASC
  `;
  return {
    correction_id: String(row.correction_id),
    version_id: versionId,
    answer_markdown: String(row.answer_markdown),
    match_type: row.is_primary === true ? 'exact' : 'alias',
    match_score: 1,
    sources: sources.map((source) => ({
      kb_id: nullableString(source.kb_id),
      doc_id: nullableString(source.doc_id),
      chunk_id: nullableString(source.chunk_id),
      parse_job_id: nullableString(source.parse_job_id),
      source_title: String(source.source_title),
      quote: String(source.quote),
      page_range: Array.isArray(source.page_range)
        ? source.page_range.map((value) => Number(value)).filter(Number.isFinite)
        : [],
    })),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

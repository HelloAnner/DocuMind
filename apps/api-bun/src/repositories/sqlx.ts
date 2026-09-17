// 移植自 apps/api-rs/src/repositories/sqlx.rs
// SqlxConversationRepository 完整实现 ConversationRepository；
// session/message 方法继承自 SqlxConversationCore（sqlx_core.ts）。
import type { AgentTrace } from '../models/agent.ts';
import type { Citation, CitationAnchor } from '../models/citation.ts';
import type { ConversationFile } from '../models/conversation_file.ts';
import type { Feedback, FeedbackReason, Rating } from '../models/feedback.ts';
import type { QueryTrace, RetrievalSource, RetrievalTrace } from '../models/trace.ts';
import type { ConversationRepository } from './types.ts';
import {
  SqlxConversationCore, type Row, type Sql,
  dateCol, numCol, numListOrEmpty, strCol, strListOrEmpty, strOrNullCol,
} from './sqlx_core.ts';
import { queryConversationFiles } from './conversation_files.ts';

const RATINGS: Rating[] = ['up', 'down'];
const FEEDBACK_REASONS: FeedbackReason[] = [
  'helpful', 'wrong_answer', 'missing_source', 'outdated', 'not_helpful', 'other',
];
const RETRIEVAL_SOURCES: RetrievalSource[] = ['dense', 'bm25', 'rrf', 'rerank'];

function parseRating(value: string): Rating {
  if ((RATINGS as string[]).includes(value)) return value as Rating;
  throw new Error('unknown rating: ' + value);
}

function parseFeedbackReason(value: string): FeedbackReason {
  if ((FEEDBACK_REASONS as string[]).includes(value)) return value as FeedbackReason;
  throw new Error('unknown feedback reason: ' + value);
}

function parseRetrievalSource(value: string): RetrievalSource {
  if ((RETRIEVAL_SOURCES as string[]).includes(value)) return value as RetrievalSource;
  throw new Error('invalid retrieval source: unknown retrieval source: ' + value);
}

function parseFeedback(row: Row): Feedback {
  const rating = parseRating(strCol(row, 'rating'));
  const reasonText = strOrNullCol(row, 'reason');
  return {
    id: strCol(row, 'id'),
    assistant_message_id: strCol(row, 'assistant_message_id'),
    user_id: strCol(row, 'user_id'),
    rating,
    reason: reasonText === null ? null : parseFeedbackReason(reasonText),
    comment: strOrNullCol(row, 'comment'),
    correction: strOrNullCol(row, 'correction'),
    created_at: dateCol(row, 'created_at'),
    updated_at: dateCol(row, 'updated_at'),
  };
}

export class SqlxConversationRepository
  extends SqlxConversationCore
  implements ConversationRepository
{
  constructor(pool: Sql) {
    super(pool);
  }

  // ---- citation snapshot（对应 Rust save_citation_snapshot） ----

  private async saveCitationSnapshot(citation: Citation): Promise<void> {
    const anchorId = citation.anchor ? citation.anchor.anchor_id : null;
    let parseJobId = citation.anchor ? citation.anchor.parse_job_id : null;
    if (parseJobId === null) {
      const rows = await this.pool`
        SELECT latest_parse_job_id FROM documents WHERE id = ${citation.doc_id} LIMIT 1
      `;
      const value: unknown = rows[0]?.['latest_parse_job_id'];
      parseJobId = typeof value === 'string' ? value : null;
    }
    if (parseJobId === null) return;

    let anchorSnapshot: unknown;
    if (anchorId !== null) {
      const rows = await this.pool.unsafe(
        `SELECT jsonb_build_object(
            'anchor_id', a.id,
            'doc_id', a.doc_id,
            'parse_job_id', a.parse_job_id,
            'tenant_id', a.tenant_id,
            'format', a.format,
            'kind', a.kind,
            'page', a.page,
            'slide', a.slide,
            'block_id', a.block_id,
            'table_id', a.table_id,
            'cell_range', a.cell_range,
            'char_range', a.char_range,
            'bbox', a.bbox,
            'source_ref', a.source_ref,
            'text', a.text,
            'text_hash', a.text_hash,
            'anchor_quality', a.anchor_quality
         )
         FROM document_source_anchors a
         WHERE a.id = $1 AND a.doc_id = $2
         LIMIT 1`,
        [anchorId, citation.doc_id],
      );
      const built: unknown = rows[0]?.['jsonb_build_object'];
      anchorSnapshot = built === undefined || built === null ? (citation.anchor ?? {}) : built;
    } else {
      anchorSnapshot = citation.anchor ?? {};
    }

    const locationStatus = citation.anchor ? citation.anchor.location_status : 'unavailable';

    await this.pool`
      INSERT INTO conversation_citation_snapshots (
        citation_id, message_id, doc_id, parse_job_id, anchor_id,
        citation_index, quote, anchor_snapshot, claim_refs,
        source_status, location_status
      )
      VALUES (${citation.id}, ${citation.assistant_message_id}, ${citation.doc_id},
        ${parseJobId}, ${anchorId}, ${citation.index}, ${citation.quote},
        ${anchorSnapshot as never}, '[]'::jsonb, ${citation.source_status}, ${locationStatus})
      ON CONFLICT (citation_id) DO UPDATE SET
        message_id = EXCLUDED.message_id,
        doc_id = EXCLUDED.doc_id,
        parse_job_id = EXCLUDED.parse_job_id,
        anchor_id = EXCLUDED.anchor_id,
        citation_index = EXCLUDED.citation_index,
        quote = EXCLUDED.quote,
        anchor_snapshot = EXCLUDED.anchor_snapshot,
        source_status = EXCLUDED.source_status,
        location_status = EXCLUDED.location_status
    `;
  }

  // ---- query trace ----

  async saveQueryTrace(trace: QueryTrace): Promise<void> {
    await this.pool`
      INSERT INTO conversation_query_traces (
        id, message_id, original_query, rewritten_query, keywords,
        hypothetical_answer, resolved_refs, effective_kb_ids, rewrite_model, created_at
      ) VALUES (${trace.id}, ${trace.message_id}, ${trace.original_query},
        ${trace.rewritten_query}, ${trace.keywords}, ${trace.hypothetical_answer},
        ${trace.resolved_refs}, ${trace.effective_kb_ids}, ${trace.rewrite_model},
        ${trace.created_at})
    `;
  }

  async getQueryTrace(messageId: string): Promise<QueryTrace | null> {
    const rows = await this.pool`
      SELECT id, message_id, original_query, rewritten_query, keywords,
             hypothetical_answer, resolved_refs, effective_kb_ids, rewrite_model, created_at
      FROM conversation_query_traces
      WHERE message_id = ${messageId}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: strCol(row, 'id'),
      message_id: strCol(row, 'message_id'),
      original_query: strCol(row, 'original_query'),
      rewritten_query: strOrNullCol(row, 'rewritten_query'),
      keywords: strListOrEmpty(row, 'keywords'),
      hypothetical_answer: strOrNullCol(row, 'hypothetical_answer'),
      resolved_refs: row['resolved_refs'] as QueryTrace['resolved_refs'],
      effective_kb_ids: strListOrEmpty(row, 'effective_kb_ids'),
      rewrite_model: strCol(row, 'rewrite_model'),
      created_at: dateCol(row, 'created_at'),
    };
  }

  // ---- retrieval trace ----

  async saveRetrievalTraces(traces: RetrievalTrace[]): Promise<void> {
    for (const trace of traces) {
      await this.pool`
        INSERT INTO conversation_retrieval_traces (
          id, message_id, chunk_id, doc_id, source, rank, score,
          heading_path, page_range, content_preview
        ) VALUES (${trace.id}, ${trace.message_id}, ${trace.chunk_id}, ${trace.doc_id},
          ${trace.source}, ${trace.rank}, ${trace.score}, ${trace.heading_path},
          ${trace.page_range}, ${trace.content_preview})
      `;
    }
  }

  async getRetrievalTraces(messageId: string): Promise<RetrievalTrace[]> {
    const rows = await this.pool`
      SELECT id, message_id, chunk_id, doc_id, source, rank, score,
             heading_path, page_range, content_preview
      FROM conversation_retrieval_traces
      WHERE message_id = ${messageId}
      ORDER BY rank ASC
    `;
    return rows.map((row) => ({
      id: strCol(row, 'id'),
      message_id: strCol(row, 'message_id'),
      chunk_id: strCol(row, 'chunk_id'),
      doc_id: strCol(row, 'doc_id'),
      source: parseRetrievalSource(strCol(row, 'source')),
      rank: numCol(row, 'rank'),
      score: numCol(row, 'score'),
      heading_path: strListOrEmpty(row, 'heading_path'),
      page_range: numListOrEmpty(row, 'page_range'),
      content_preview: strCol(row, 'content_preview'),
    }));
  }

  // ---- citations ----

  async saveCitations(citations: Citation[]): Promise<void> {
    for (const citation of citations) {
      const locationStatus = citation.anchor ? citation.anchor.location_status : 'unavailable';
      await this.pool`
        INSERT INTO conversation_citations (
          id, assistant_message_id, index, chunk_id, doc_id, doc_title,
          page_range, heading_path, quote, score, anchor, location_status
        ) VALUES (${citation.id}, ${citation.assistant_message_id}, ${citation.index},
          ${citation.chunk_id}, ${citation.doc_id}, ${citation.doc_title},
          ${citation.page_range}, ${citation.heading_path}, ${citation.quote},
          ${citation.score}, ${citation.anchor as never}, ${locationStatus})
      `;
      await this.saveCitationSnapshot(citation);
    }
  }

  async getCitations(assistantMessageId: string): Promise<Citation[]> {
    const rows = await this.pool`
      SELECT c.id, c.assistant_message_id, c.index, c.chunk_id, c.doc_id, c.doc_title,
             c.page_range, c.heading_path, c.quote, c.score, c.anchor,
             CASE
                 WHEN d.id IS NULL THEN 'deleted'
                 WHEN d.parse_status = 'deleted' THEN 'deleted'
                 ELSE 'available'
             END AS source_status
      FROM conversation_citations c
      LEFT JOIN documents d ON d.id = c.doc_id
      WHERE assistant_message_id = ${assistantMessageId}
      ORDER BY index ASC
    `;
    return rows.map((row) => {
      const anchorValue: unknown = row['anchor'];
      return {
        id: strCol(row, 'id'),
        assistant_message_id: strCol(row, 'assistant_message_id'),
        index: numCol(row, 'index'),
        chunk_id: strCol(row, 'chunk_id'),
        doc_id: strCol(row, 'doc_id'),
        doc_title: strCol(row, 'doc_title'),
        page_range: numListOrEmpty(row, 'page_range'),
        heading_path: strListOrEmpty(row, 'heading_path'),
        quote: strCol(row, 'quote'),
        score: numCol(row, 'score'),
        source_status: strCol(row, 'source_status'),
        anchor: anchorValue === null || anchorValue === undefined
          ? null
          : (anchorValue as CitationAnchor),
      };
    });
  }

  // ---- agent trace ----

  async saveAgentTrace(assistantMessageId: string, trace: AgentTrace): Promise<void> {
    await this.pool`
      INSERT INTO conversation_agent_traces (assistant_message_id, trace, created_at)
      VALUES (${assistantMessageId}, ${trace as never}, ${new Date()})
      ON CONFLICT (assistant_message_id) DO UPDATE SET trace = EXCLUDED.trace, created_at = EXCLUDED.created_at
    `;
  }

  async getAgentTrace(assistantMessageId: string): Promise<AgentTrace | null> {
    const rows = await this.pool`
      SELECT trace FROM conversation_agent_traces WHERE assistant_message_id = ${assistantMessageId}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return row['trace'] as AgentTrace;
  }

  // ---- feedback ----

  async upsertFeedback(feedback: Feedback): Promise<Feedback> {
    const rows = await this.pool`
      INSERT INTO conversation_feedback (
        id, assistant_message_id, user_id, rating, reason, comment, correction,
        created_at, updated_at
      ) VALUES (${feedback.id}, ${feedback.assistant_message_id}, ${feedback.user_id},
        ${feedback.rating}, ${feedback.reason}, ${feedback.comment}, ${feedback.correction},
        ${feedback.created_at}, ${feedback.updated_at})
      ON CONFLICT (assistant_message_id, user_id)
      DO UPDATE SET
        rating = EXCLUDED.rating,
        reason = EXCLUDED.reason,
        comment = EXCLUDED.comment,
        correction = EXCLUDED.correction,
        updated_at = EXCLUDED.updated_at
      RETURNING
        id, assistant_message_id, user_id, rating, reason, comment, correction,
        created_at, updated_at
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('upsert feedback returned no row');
    return parseFeedback(row);
  }

  async getFeedback(assistantMessageId: string, userId: string): Promise<Feedback | null> {
    const rows = await this.pool`
      SELECT
        id, assistant_message_id, user_id, rating, reason, comment, correction,
        created_at, updated_at
      FROM conversation_feedback
      WHERE assistant_message_id = ${assistantMessageId}
        AND user_id = ${userId}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return parseFeedback(row);
  }

  async deleteFeedback(assistantMessageId: string, userId: string): Promise<boolean> {
    const result = await this.pool`
      DELETE FROM conversation_feedback
      WHERE assistant_message_id = ${assistantMessageId}
        AND user_id = ${userId}
    `;
    return result.count > 0;
  }

  // ---- conversation files ----

  async listConversationFiles(
    tenantId: string, conversationId: string, allowedKbIds: string[],
  ): Promise<ConversationFile[]> {
    return queryConversationFiles(this.pool, tenantId, conversationId, allowedKbIds);
  }
}

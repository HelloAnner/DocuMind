// 移植自 apps/api-rs/src/repositories/sqlx.rs 的 CONVERSATION_FILES_SQL
// 与 memory.rs 的 FileAccumulator/citation_file_type。
// 会话文件列表的两种实现共享这里的行为逻辑。
import type { Citation } from '../models/citation.ts';
import type { ConversationFile } from '../models/conversation_file.ts';
import type { ConversationMessage } from '../models/message.ts';
import type { Row, Sql } from './sqlx_core.ts';
import { dateCol, numCol, strCol, strOrNullCol, numListOrEmpty } from './sqlx_core.ts';

export const CONVERSATION_FILES_SQL = `
WITH citation_rows AS (
    SELECT
        c.doc_id,
        c.page_range,
        c.quote,
        c.anchor,
        c.doc_title AS snapshot_title,
        c.score,
        m.created_at AS used_at
    FROM conversation_citations c
    JOIN conversation_messages m ON m.id = c.assistant_message_id
    WHERE m.tenant_id = $1 AND m.conversation_id = $2
),
preview_rows AS (
    SELECT DISTINCT ON (doc_id)
        doc_id, page_range, quote, anchor, snapshot_title, used_at
    FROM citation_rows
    ORDER BY doc_id, used_at DESC, score DESC
)
SELECT
    preview.doc_id,
    COALESCE(d.title, preview.snapshot_title, '已删除文档') AS doc_title,
    COALESCE(
        NULLIF(d.metadata->>'original_filename', ''),
        NULLIF(d.storage_key, ''),
        d.title,
        preview.snapshot_title,
        '已删除文档'
    ) AS file_name,
    COALESCE(
        NULLIF(d.file_type, ''),
        NULLIF(preview.anchor->>'format', ''),
        'unknown'
    ) AS file_type,
    d.kb_id,
    kb.name AS kb_name,
    CASE
        WHEN d.id IS NULL OR d.parse_status = 'deleted' THEN 'deleted'
        ELSE 'available'
    END AS source_status,
    0::bigint AS retrieval_count,
    1::bigint AS citation_count,
    preview.used_at AS last_used_at,
    preview.page_range AS preview_page_range,
    preview.quote AS preview_quote,
    preview.anchor AS preview_anchor
FROM preview_rows preview
LEFT JOIN documents d ON d.id = preview.doc_id AND d.tenant_id = $1
LEFT JOIN knowledge_base kb ON kb.id = d.kb_id AND kb.tenant_id = $1
WHERE d.kb_id = ANY($3) OR d.id IS NULL
ORDER BY preview.used_at DESC, doc_title ASC
`;

export function parseConversationFileRow(row: Row): ConversationFile {
  const anchorValue: unknown = row['preview_anchor'];
  return {
    doc_id: strCol(row, 'doc_id'),
    doc_title: strCol(row, 'doc_title'),
    file_name: strCol(row, 'file_name'),
    file_type: strCol(row, 'file_type'),
    kb_id: strOrNullCol(row, 'kb_id'),
    kb_name: strOrNullCol(row, 'kb_name'),
    source_status: strCol(row, 'source_status'),
    retrieval_count: numCol(row, 'retrieval_count'),
    citation_count: numCol(row, 'citation_count'),
    last_used_at: dateCol(row, 'last_used_at'),
    preview_page_range: numListOrEmpty(row, 'preview_page_range'),
    preview_quote: strCol(row, 'preview_quote'),
    preview_anchor: anchorValue === null || anchorValue === undefined
      ? null
      : (anchorValue as ConversationFile['preview_anchor']),
  };
}

export async function queryConversationFiles(
  pool: Sql, tenantId: string, conversationId: string, allowedKbIds: string[],
): Promise<ConversationFile[]> {
  if (allowedKbIds.length === 0) return [];
  const rows = await pool.unsafe(CONVERSATION_FILES_SQL, [tenantId, conversationId, allowedKbIds]);
  return rows.map((row) => parseConversationFileRow(row));
}

// ---- 内存版聚合（对应 Rust memory.rs 的 FileAccumulator / citation_file_type） ----

export function citationFileType(citation: Citation): string {
  const anchorFormat = citation.anchor
    ? citation.anchor.format.trim()
    : '';
  if (anchorFormat !== '') return anchorFormat;
  const lastDot = citation.doc_title.lastIndexOf('.');
  if (lastDot >= 0) return citation.doc_title.slice(lastDot + 1).toLowerCase();
  return 'unknown';
}

export class FileAccumulator {
  file: ConversationFile;
  private previewAt: string;

  constructor(citation: Citation, message: ConversationMessage) {
    this.file = {
      doc_id: citation.doc_id,
      doc_title: citation.doc_title,
      file_name: citation.doc_title,
      file_type: citationFileType(citation),
      kb_id: null,
      kb_name: null,
      source_status: citation.source_status,
      retrieval_count: 0,
      citation_count: 0,
      last_used_at: message.created_at,
      preview_page_range: citation.page_range,
      preview_quote: citation.quote,
      preview_anchor: citation.anchor,
    };
    this.previewAt = message.created_at;
  }

  recordCitation(citation: Citation, message: ConversationMessage): void {
    this.file.citation_count = 1;
    this.file.doc_title = citation.doc_title;
    this.file.file_name = citation.doc_title;
    this.file.file_type = citationFileType(citation);
    this.file.source_status = citation.source_status;
    this.file.last_used_at = Date.parse(message.created_at) > Date.parse(this.file.last_used_at)
      ? message.created_at
      : this.file.last_used_at;
    if (Date.parse(message.created_at) >= Date.parse(this.previewAt)) {
      this.file.preview_page_range = citation.page_range;
      this.file.preview_quote = citation.quote;
      this.file.preview_anchor = citation.anchor;
      this.previewAt = message.created_at;
    }
  }
}

ALTER TABLE conversation_messages
    DROP CONSTRAINT IF EXISTS conversation_messages_correction_version_fk,
    DROP CONSTRAINT IF EXISTS conversation_messages_correction_fk,
    DROP CONSTRAINT IF EXISTS conversation_messages_correction_match_type_check,
    DROP CONSTRAINT IF EXISTS conversation_messages_answer_source_check;

ALTER TABLE answer_quality_cases
    DROP CONSTRAINT IF EXISTS answer_quality_cases_correction_fk;

ALTER TABLE answer_corrections
    DROP CONSTRAINT IF EXISTS answer_corrections_draft_version_fk,
    DROP CONSTRAINT IF EXISTS answer_corrections_published_version_fk;

DROP TABLE IF EXISTS answer_correction_sources;
DROP TABLE IF EXISTS answer_correction_aliases;
DROP TABLE IF EXISTS answer_correction_versions;
DROP TABLE IF EXISTS answer_corrections;
DROP TABLE IF EXISTS answer_quality_case_items;
DROP TABLE IF EXISTS answer_quality_cases;

ALTER TABLE conversation_messages
    DROP COLUMN IF EXISTS correction_match_score,
    DROP COLUMN IF EXISTS correction_match_type,
    DROP COLUMN IF EXISTS correction_version_id,
    DROP COLUMN IF EXISTS correction_id,
    DROP COLUMN IF EXISTS answer_source;

ALTER TABLE conversation_feedback
    DROP COLUMN IF EXISTS cleared_at;

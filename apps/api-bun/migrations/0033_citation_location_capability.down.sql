UPDATE conversation_citations
SET anchor = jsonb_set(anchor, '{location_status}', '"structural_only"'::jsonb, true),
    location_status = 'structural_only'
WHERE anchor IS NOT NULL
  AND anchor->>'location_status' = 'file_only';

UPDATE conversation_citation_snapshots
SET location_status = 'structural_only'
WHERE location_status = 'file_only';

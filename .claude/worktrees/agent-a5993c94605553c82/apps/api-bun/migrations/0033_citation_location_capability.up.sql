UPDATE conversation_citations
SET anchor = jsonb_set(anchor, '{location_status}', '"file_only"'::jsonb, true),
    location_status = 'file_only'
WHERE anchor IS NOT NULL
  AND COALESCE(anchor->>'location_status', 'unavailable') IN ('structural_only', 'unavailable');

UPDATE conversation_citation_snapshots
SET location_status = 'file_only'
WHERE location_status IN ('structural_only', 'unavailable');

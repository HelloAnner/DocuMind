ALTER TABLE api_client
  ALTER COLUMN scopes SET DEFAULT ARRAY[
    'knowledge_bases:read',
    'chat:write',
    'conversations:read',
    'conversations:write'
  ];


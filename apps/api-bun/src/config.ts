// 移植自 apps/api-rs/src/config.rs —— 环境变量加载与校验
export type RuntimeEnvironment = 'development' | 'production';

export interface RewriteConfig { enabled: boolean; hydeEnabled: boolean; model: string; }
export interface RetrievalConfig { denseTopK: number; bm25TopK: number; rrfTopK: number; effectiveTopK: number; }
export interface RerankConfig { enabled: boolean; provider: string; model: string; apiUrl: string | null; apiKey: string | null; }
export interface EmbeddingConfig {
  model: string; baseUrl: string; apiKey: string | null; batchSize: number; dimension: number;
  retryMax: number; workerPollMs: number; indexSchemaVersion: number; indexName: string; indexAlias: string; enabled: boolean;
}
export interface GenerationConfig {
  model: string; baseUrl: string; apiKey: string; useRealLlm: boolean;
  temperature: number; maxOutputTokens: number; contextWindow: number;
}
export interface CitationConfig { requireCitation: boolean; verifyClaims: boolean; verifyConsensus: boolean; }
/** 对齐 Rust document::ChunkConfig::default()（RAG_* 环境变量，见 apps/api-rs/src/document/chunking.rs） */
export interface ChunkingConfig {
  targetChunkTokens: number; maxChunkTokens: number; hardSplitTokens: number; minChunkTokens: number;
  overlapTokens: number; maxTableRowsPerChunk: number; maxTableTokenPerChunk: number;
}
export interface RagConfig { rewrite: RewriteConfig; retrieval: RetrievalConfig; rerank: RerankConfig; embedding: EmbeddingConfig; generation: GenerationConfig; citation: CitationConfig; chunking: ChunkingConfig; }
export interface AgentConfig {
  reasoningModel: string; defaultTone: string; proactiveFollowup: boolean; maxFollowupSuggestions: number;
  allowAnalystMode: boolean; requireCitationForAnalysis: boolean; clarificationStyle: string;
  maxReactSteps: number; maxQueriesPerStep: number; maxHistoryTurns: number; maxHistoryChars: number;
  maxContextChars: number; maxRepairAttempts: number; totalTimeoutSeconds: number;
}
export interface AppConfig {
  environment: RuntimeEnvironment; serverHost: string; serverPort: number;
  databaseUrl: string | null; redisUrl: string | null; rabbitmqUrl: string | null; elasticsearchUrl: string | null;
  objectStorageProvider: string; objectStorageEndpoint: string | null; objectStorageRegion: string; objectStorageBucket: string;
  objectStorageAccessKey: string | null; objectStorageSecretKey: string | null;
  objectStorageForcePathStyle: boolean; objectStorageTlsVerify: boolean; objectStoragePresignExpireSeconds: number;
  blobStorageDir: string; jwtSecret: string; authTokenExpireHours: number; authLoginMode: string;
  portalBaseUrl: string; portalExchangeEndpoint: string;
  defaultTenantId: string; defaultUserId: string; defaultRole: string; defaultKbIds: string[];
  defaultTenantName: string; defaultTenantSlug: string;
  superAdminUserId: string; standardUserId: string;
  superAdminEmail: string; superAdminPassword: string;
  enterpriseAdminEmail: string; enterpriseAdminPassword: string;
  standardUserEmail: string; standardUserPassword: string;
  rag: RagConfig; agent: AgentConfig; chatModels: string[];
}

const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000002';
const DEFAULT_KB_ID = '00000000-0000-0000-0000-000000000003';
const SUPER_ADMIN_USER_ID = '00000000-0000-0000-0000-000000000003';
const STANDARD_USER_ID = '00000000-0000-0000-0000-000000000004';

let cachedChunkingConfig: ChunkingConfig | null = null;

/**
 * 仅读取 RAG_* 切片参数（与 Rust document::ChunkConfig::default() 一致）。
 * 结果缓存；供解析指纹等轻量场景使用，不触发全量配置校验。
 */
export function loadChunkingConfig(
  env: Record<string, string | undefined> = process.env,
): ChunkingConfig {
  if (cachedChunkingConfig !== null) return cachedChunkingConfig;
  const int32 = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || !/^[+-]?\d+$/.test(raw)) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return parsed < -2147483648 || parsed > 2147483647 ? fallback : parsed;
  };
  const usize = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) ? parsed : fallback;
  };
  cachedChunkingConfig = {
    targetChunkTokens: int32('RAG_TARGET_CHUNK_TOKENS', 800),
    maxChunkTokens: int32('RAG_MAX_CHUNK_TOKENS', 1500),
    hardSplitTokens: int32('RAG_HARD_SPLIT_TOKENS', 2000),
    minChunkTokens: int32('RAG_MIN_CHUNK_TOKENS', 200),
    overlapTokens: int32('RAG_CHUNK_OVERLAP_TOKENS', 200),
    maxTableRowsPerChunk: usize('RAG_MAX_TABLE_ROWS_PER_CHUNK', 50),
    maxTableTokenPerChunk: int32('RAG_MAX_TABLE_TOKEN_PER_CHUNK', 1200),
  };
  return cachedChunkingConfig;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const envStr = (...keys: string[]): string | undefined => {
    for (const key of keys) { const value = env[key]; if (value !== undefined && value !== '') return value; }
    return undefined;
  };
  const envBool = (key: string, defaultValue: boolean): boolean => {
    const value = env[key];
    if (value === undefined || value === '') return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  };
  const envNum = (keys: string[], defaultValue: number): number => {
    const raw = envStr(...keys);
    if (raw === undefined) return defaultValue;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  };
  const envUuid = (key: string, defaultValue: string): string =>
    envStr(key) ?? defaultValue;
  const isUuid = (value: string): boolean =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  // Rust 用 std::env::var(name).ok().and_then(|v| v.parse().ok())：严格整数解析，失败回退默认值
  const envRustI32 = (key: string, defaultValue: number): number => {
    const raw = env[key];
    if (raw === undefined || !/^[+-]?\d+$/.test(raw)) return defaultValue;
    const parsed = Number.parseInt(raw, 10);
    return parsed < -2147483648 || parsed > 2147483647 ? defaultValue : parsed;
  };
  const envRustUsize = (key: string, defaultValue: number): number => {
    const raw = env[key];
    if (raw === undefined || !/^\d+$/.test(raw)) return defaultValue;
    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) ? parsed : defaultValue;
  };
  const envUuidList = (key: string, defaultValue: string[]): string[] => {
    const raw = envStr(key);
    if (raw === undefined) return defaultValue;
    return raw.split(',').map((item) => item.trim()).filter(isUuid);
  };
  const envList = (key: string, defaultValue: string[]): string[] => {
    const raw = envStr(key);
    if (raw === undefined) return defaultValue;
    return raw.split(',').map((item) => item.trim()).filter(Boolean);
  };

  const environment: RuntimeEnvironment = (() => {
    const raw = (envStr('DOCUMIND_ENV', 'APP_ENV', 'RUST_ENV') ?? 'development').trim().toLowerCase();
    return raw === 'prod' || raw === 'production' || raw === 'release' ? 'production' : 'development';
  })();

  const legacyPortalAuth = envBool('PORTAL_MANAGED', false) && envBool('PORTAL_AUTH_ENABLED', false);
  const authLoginModeRaw = (envStr('AUTH_LOGIN_MODE') ?? (legacyPortalAuth ? 'portal' : 'local')).trim().toLowerCase();
  const authLoginMode = ['portal', 'portal_sso', 'portal-managed', 'portal_managed'].includes(authLoginModeRaw) ? 'portal' : 'local';

  const rewriteModel = envStr('RAG_REWRITE_MODEL') ?? 'qwen-turbo';
  const embedApiKey = envStr('EMBED_API_KEY', 'EMBED_KEY', 'EMBEDDING_API_KEY', 'LLM_API', 'LLM_API_KEY') ?? null;

  const rag: RagConfig = {
    rewrite: {
      enabled: envBool('RAG_REWRITE_ENABLED', true) || (envStr('RAG_REWRITE_ENABLED') === undefined ? true : ['1', 'true', 'yes', 'on'].includes((env['RAG_REWRITE_ENABLED'] ?? '').toLowerCase())),
      hydeEnabled: envBool('RAG_HYDE_ENABLED', true),
      model: rewriteModel,
    },
    retrieval: {
      denseTopK: envNum(['RAG_DENSE_TOP_K'], 100),
      bm25TopK: envNum(['RAG_BM25_TOP_K'], 100),
      rrfTopK: envNum(['RAG_RRF_TOP_K'], 20),
      effectiveTopK: envNum(['RAG_TOP_K'], 5),
    },
    rerank: {
      enabled: envBool('RAG_RERANK_ENABLED', true),
      provider: envStr('RAG_RERANK_PROVIDER') ?? 'dashscope',
      model: envStr('RAG_RERANK_MODEL') ?? 'gte-rerank-v2',
      apiUrl: envStr('RAG_RERANK_API_URL') ?? null,
      apiKey: envStr('RAG_RERANK_API_KEY') ?? null,
    },
    embedding: {
      model: envStr('EMBED_MODEL', 'EMBEDDING_MODEL') ?? 'text-embedding-v3',
      baseUrl: envStr('EMBED_BASE_URL', 'EMBEDDING_API_URL', 'LLM_BASE_URL') ?? 'http://localhost:11434/v1',
      apiKey: embedApiKey,
      batchSize: envNum(['EMBED_BATCH_SIZE', 'EMBEDDING_BATCH_SIZE'], 10),
      dimension: envNum(['EMBED_DIM', 'EMBEDDING_DIM'], 1024),
      retryMax: envNum(['EMBED_RETRY_MAX', 'EMBEDDING_RETRY_MAX'], 3),
      workerPollMs: envNum(['EMBED_WORKER_POLL_MS'], 1000),
      indexSchemaVersion: envNum(['ES_INDEX_SCHEMA_VERSION'], 3),
      indexName: envStr('ES_INDEX_CHUNKS') ?? 'chunks',
      indexAlias: envStr('ES_INDEX_ALIAS') ?? 'chunks_search',
      enabled: envBool('EMBED_ENABLED', true),
    },
    generation: {
      model: envStr('LLM_MODEL') ?? 'qwen-turbo',
      baseUrl: envStr('LLM_BASE_URL') ?? 'http://localhost:11434/v1',
      apiKey: envStr('LLM_API_KEY', 'LLM_API') ?? 'ollama',
      useRealLlm: (() => { const raw = envStr('USE_REAL_LLM'); if (raw === undefined) return false; return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase()) || raw === 'true'; })(),
      temperature: envNum(['LLM_TEMPERATURE'], 0.2),
      maxOutputTokens: envNum(['LLM_MAX_OUTPUT_TOKENS'], 1200),
      contextWindow: envNum(['LLM_CONTEXT_WINDOW'], 128_000),
    },
    citation: {
      requireCitation: envBool('RAG_REQUIRE_CITATION', true),
      verifyClaims: envBool('RAG_VERIFY_CLAIMS', false),
      verifyConsensus: envBool('RAG_VERIFY_CONSENSUS', false),
    },
    chunking: loadChunkingConfig(env),
  };

  const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
  const agent: AgentConfig = {
    reasoningModel: envStr('AGENT_REASONING_MODEL') ?? rewriteModel,
    defaultTone: envStr('AGENT_DEFAULT_TONE') ?? 'concise_warm',
    proactiveFollowup: envBool('AGENT_PROACTIVE_FOLLOWUP', true),
    maxFollowupSuggestions: envNum(['AGENT_MAX_FOLLOWUP_SUGGESTIONS'], 2),
    allowAnalystMode: envBool('AGENT_ALLOW_ANALYST_MODE', true),
    requireCitationForAnalysis: envBool('AGENT_REQUIRE_CITATION_FOR_ANALYSIS', true),
    clarificationStyle: envStr('AGENT_CLARIFICATION_STYLE') ?? 'short',
    maxReactSteps: clamp(envNum(['AGENT_MAX_REACT_STEPS'], 6), 2, 8),
    maxQueriesPerStep: clamp(envNum(['AGENT_MAX_QUERIES_PER_STEP'], 4), 1, 8),
    maxHistoryTurns: clamp(envNum(['AGENT_MAX_HISTORY_TURNS'], 12), 1, 50),
    maxHistoryChars: clamp(envNum(['AGENT_MAX_HISTORY_CHARS'], 24_000), 2_000, 100_000),
    maxContextChars: clamp(envNum(['AGENT_MAX_CONTEXT_CHARS'], 30_000), 4_000, 120_000),
    maxRepairAttempts: clamp(envNum(['AGENT_MAX_REPAIR_ATTEMPTS'], 1), 0, 1),
    totalTimeoutSeconds: envNum(['AGENT_TOTAL_TIMEOUT_SECONDS'], 240),
  };

  const config: AppConfig = {
    environment,
    serverHost: envStr('SERVER_HOST') ?? '127.0.0.1',
    serverPort: envNum(['SERVER_PORT'], 8089),
    databaseUrl: envStr('DATABASE_URL') ?? null,
    redisUrl: envStr('REDIS_URL') ?? null,
    rabbitmqUrl: envStr('RABBITMQ_URL') ?? null,
    elasticsearchUrl: envStr('ELASTICSEARCH_URL') ?? null,
    objectStorageProvider: envStr('OBJECT_STORAGE_PROVIDER') ?? 'minio',
    objectStorageEndpoint: envStr('OBJECT_STORAGE_ENDPOINT') ?? null,
    objectStorageRegion: envStr('OBJECT_STORAGE_REGION') ?? 'us-east-1',
    objectStorageBucket: envStr('OBJECT_STORAGE_BUCKET') ?? 'documind',
    objectStorageAccessKey: envStr('OBJECT_STORAGE_ACCESS_KEY') ?? null,
    objectStorageSecretKey: envStr('OBJECT_STORAGE_SECRET_KEY') ?? null,
    objectStorageForcePathStyle: envBool('OBJECT_STORAGE_FORCE_PATH_STYLE', true),
    objectStorageTlsVerify: envBool('OBJECT_STORAGE_TLS_VERIFY', false),
    objectStoragePresignExpireSeconds: envNum(['OBJECT_STORAGE_PRESIGN_EXPIRE_SECONDS'], 900),
    blobStorageDir: envStr('BLOB_STORAGE_DIR', 'OBJECT_STORAGE_LOCAL_DIR') ?? './data/objects',
    jwtSecret: envStr('JWT_SECRET') ?? 'documind-dev-secret-change-me',
    authTokenExpireHours: envNum(['AUTH_TOKEN_EXPIRE_HOURS', 'JWT_EXPIRE_HOURS'], 24),
    authLoginMode,
    portalBaseUrl: envStr('PORTAL_BASE_URL') ?? 'http://localhost:8080',
    portalExchangeEndpoint: envStr('PORTAL_EXCHANGE_ENDPOINT') ?? '/api/auth/exchange-ticket',
    defaultTenantId: envUuid('DEFAULT_TENANT_ID', DEFAULT_TENANT_ID),
    defaultUserId: envUuid('DEFAULT_USER_ID', DEFAULT_USER_ID),
    defaultRole: envStr('DEFAULT_ROLE') ?? 'enterprise_admin',
    defaultKbIds: envUuidList('DEFAULT_KB_IDS', [DEFAULT_KB_ID]),
    defaultTenantName: envStr('DEFAULT_TENANT_NAME') ?? 'Acme Corp',
    defaultTenantSlug: envStr('DEFAULT_TENANT_SLUG') ?? 'acme',
    superAdminUserId: envUuid('SUPER_ADMIN_USER_ID', SUPER_ADMIN_USER_ID),
    standardUserId: envUuid('STANDARD_USER_ID', STANDARD_USER_ID),
    superAdminEmail: envStr('SUPER_ADMIN_EMAIL') ?? 'Anner',
    superAdminPassword: envStr('SUPER_ADMIN_PASSWORD') ?? '1',
    enterpriseAdminEmail: envStr('ENTERPRISE_ADMIN_EMAIL') ?? 'admin@documind.local',
    enterpriseAdminPassword: envStr('ENTERPRISE_ADMIN_PASSWORD') ?? 'documind123',
    standardUserEmail: envStr('STANDARD_USER_EMAIL') ?? 'user@documind.local',
    standardUserPassword: envStr('STANDARD_USER_PASSWORD') ?? 'documind123',
    rag,
    agent,
    chatModels: envList('CHAT_MODELS', ['deepseek-v4.1-flash', 'qwen3.8-max', 'glm-5.3']),
  };
  validateConfig(config);
  return config;
}

export function isProduction(config: AppConfig): boolean {
  return config.environment === 'production';
}

function validateConfig(config: AppConfig): void {
  if (config.rag.embedding.dimension === 0) throw new Error('EMBED_DIM must be greater than zero');
  if (config.rag.embedding.batchSize === 0 || config.rag.embedding.batchSize > 100) throw new Error('EMBED_BATCH_SIZE must be between 1 and 100');
  if (config.rag.embedding.retryMax < 1 || config.rag.embedding.retryMax > 20) throw new Error('EMBED_RETRY_MAX must be between 1 and 20');
  if (!isProduction(config)) return;

  const missing: string[] = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.redisUrl) missing.push('REDIS_URL');
  if (!config.rabbitmqUrl) missing.push('RABBITMQ_URL');
  if (!config.elasticsearchUrl) missing.push('ELASTICSEARCH_URL');
  if (!config.objectStorageEndpoint) missing.push('OBJECT_STORAGE_ENDPOINT');
  if (!config.objectStorageAccessKey) missing.push('OBJECT_STORAGE_ACCESS_KEY');
  if (!config.objectStorageSecretKey) missing.push('OBJECT_STORAGE_SECRET_KEY');
  if (!config.rag.generation.useRealLlm) missing.push('USE_REAL_LLM=true');
  if (!config.rag.generation.apiKey || config.rag.generation.apiKey === 'ollama') missing.push('LLM_API_KEY');
  if (!config.rag.embedding.enabled) missing.push('EMBED_ENABLED=true');
  if (!config.rag.embedding.apiKey) missing.push('EMBED_API_KEY');
  if (!config.rag.rewrite.enabled) missing.push('RAG_REWRITE_ENABLED=true');
  if (!config.rag.rerank.enabled) missing.push('RAG_RERANK_ENABLED=true');
  if (!config.rag.rerank.apiUrl) missing.push('RAG_RERANK_API_URL');
  if (!config.rag.rerank.apiKey) missing.push('RAG_RERANK_API_KEY');
  if (config.jwtSecret.trim().length < 32 || config.jwtSecret === 'documind-dev-secret-change-me') missing.push('JWT_SECRET>=32');

  if (missing.length > 0) {
    throw new Error('production configuration is incomplete: ' + missing.join(', '));
  }
}

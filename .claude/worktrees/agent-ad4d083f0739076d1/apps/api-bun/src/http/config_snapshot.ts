// 移植自 apps/api-rs/src/lib.rs 的 /api/config
import type { AppConfig } from '../config.ts';

export function configSnapshotPayload(cfg: AppConfig): Record<string, unknown> {
  return {
    tenant: cfg.defaultTenantId,
    role: cfg.defaultRole,
    auth: 'jwt',
    environment: cfg.environment,
    storage: {
      provider: cfg.objectStorageProvider,
      blob_dir: cfg.blobStorageDir,
      object_endpoint: cfg.objectStorageEndpoint,
      object_region: cfg.objectStorageRegion,
      object_bucket: cfg.objectStorageBucket,
      object_force_path_style: cfg.objectStorageForcePathStyle,
      object_tls_verify: cfg.objectStorageTlsVerify,
      elasticsearch: cfg.elasticsearchUrl,
      rabbitmq: cfg.rabbitmqUrl,
      redis: cfg.redisUrl,
    },
    embedding: {
      enabled: cfg.rag.embedding.enabled,
      model: cfg.rag.embedding.model,
      base_url: cfg.rag.embedding.baseUrl,
      index: cfg.rag.embedding.indexName,
      alias: cfg.rag.embedding.indexAlias,
    },
    retrieval: {
      strategy: 'hybrid',
      topK: cfg.rag.retrieval.effectiveTopK,
      rerankTopK: cfg.rag.retrieval.rrfTopK,
    },
    llm: {
      use_real_llm: cfg.rag.generation.useRealLlm,
      model: cfg.rag.generation.model,
      base_url: cfg.rag.generation.baseUrl,
      streaming_enabled: cfg.rag.generation.useRealLlm,
      mock_enabled: !cfg.rag.generation.useRealLlm,
      temperature: cfg.rag.generation.temperature,
      max_output_tokens: cfg.rag.generation.maxOutputTokens,
    },
    agent: {
      default_tone: cfg.agent.defaultTone,
      proactive_followup: cfg.agent.proactiveFollowup,
      max_followup_suggestions: cfg.agent.maxFollowupSuggestions,
      allow_analyst_mode: cfg.agent.allowAnalystMode,
    },
  };
}

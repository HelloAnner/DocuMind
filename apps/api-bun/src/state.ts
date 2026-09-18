// 移植自 apps/api-rs/src/state.rs —— 应用状态装配
import type { Sql } from 'postgres';
import type Redis from 'ioredis';
import postgres from 'postgres';
import { Redis as RedisClient } from 'ioredis';
import type { AppConfig } from './config.ts';
import type { ConversationRepository } from './repositories/types.ts';
import { InMemoryConversationRepository, SqlxConversationRepository } from './repositories/index.ts';
import type { ObjectStorage } from './storage/types.ts';
import { buildStorage } from './storage/index.ts';
import { seedIdentity } from './auth/seed.ts';
import { OpenAiClient } from './llm/openai.ts';
import {
  BuiltinPromptRegistry, GroundedAnswerFinalizer, LlmClaimVerifier, PiAgentKernel,
  StructuralClaimVerifier, buildPiStreamFn, type PiModelSettings,
} from './agent/index.ts';
import type { ContextAssembler, Retriever, Reranker } from './rag/types.ts';
import { EsRetriever } from './rag/retriever.ts';
import { HttpReranker, parseRerankProvider } from './rag/reranker.ts';
import { SimpleContextAssembler } from './rag/context.ts';
import { embeddingClientConfigFrom } from './rag/embedding.ts';
import { quickConsistency, startVectorWorker } from './rag/vector_pipeline.ts';
import type { VectorConsistencySnapshot } from './http/health.ts';
import type { ClaimVerifier } from './agent/verifier/types.ts';
import { loadSystemSettings } from './system_settings.ts';

export interface AppState {
  config: AppConfig;
  sql: Sql | null;
  redis: Redis | null;
  repository: ConversationRepository;
  agentKernel: PiAgentKernel;
  storage: ObjectStorage;
  /** 健康检查用：rag/vector_pipeline.quickConsistency */
  vectorConsistency: (() => Promise<VectorConsistencySnapshot>) | null;
  llm: {
    generationClient: OpenAiClient;
    reasoningClient: OpenAiClient;
    retriever: Retriever;
    reranker: Reranker;
    contextAssembler: ContextAssembler;
  };
}

export async function buildState(config: AppConfig): Promise<AppState> {
  let sql: Sql | null = null;
  let repository: ConversationRepository;
  if (config.databaseUrl) {
    sql = postgres(config.databaseUrl, { max: 10 });
    await seedIdentity(sql, config);
    await loadSystemSettings(sql, config);
    await recoverInterruptedAgentRuns(sql);
    try {
      const { recoverInterruptedDocumentJobs } = await import('./api/documents.ts');
      await recoverInterruptedDocumentJobs(sql);
    } catch (error) {
      console.warn(`[documind][state] failed to recover interrupted document jobs: ${(error as Error).message}`);
    }
    repository = new SqlxConversationRepository(sql);
  } else {
    repository = new InMemoryConversationRepository();
  }

  let redis: Redis | null = null;
  if (config.redisUrl) {
    redis = new RedisClient(config.redisUrl, { maxRetriesPerRequest: 2 });
  }
  if (!config.rag.generation.useRealLlm) {
    throw new Error('DocuMind Agent requires USE_REAL_LLM=true; rule-based answer fallback was removed');
  }
  const generationClient = new OpenAiClient({
    baseUrl: config.rag.generation.baseUrl,
    apiKey: config.rag.generation.apiKey,
    model: config.rag.generation.model,
    timeoutSeconds: 120,
  });
  const reasoningClient = new OpenAiClient({
    baseUrl: config.rag.generation.baseUrl,
    apiKey: config.rag.generation.apiKey,
    model: config.agent.reasoningModel,
    timeoutSeconds: 120,
  });
  if (!config.rag.embedding.enabled) {
    throw new Error('DocuMind Agent requires EMBED_ENABLED=true');
  }
  const esUrl = config.elasticsearchUrl;
  if (!esUrl) {
    throw new Error('DocuMind Agent requires ELASTICSEARCH_URL');
  }
  if (!sql) {
    throw new Error('DocuMind Agent requires DATABASE_URL');
  }
  const embeddingConfig = embeddingClientConfigFrom(config.rag.embedding);
  const retriever: Retriever = new EsRetriever(
    esUrl, config.rag.embedding.indexAlias, embeddingConfig,
    config.rag.embedding.model, sql,
  );

  if (!config.rag.rerank.enabled) {
    throw new Error('DocuMind Agent requires RAG_RERANK_ENABLED=true; rule-based reranking was removed');
  }
  const rerankUrl = config.rag.rerank.apiUrl;
  if (!rerankUrl) {
    throw new Error('RAG_RERANK_API_URL is required');
  }
  const rerankerAdapter = new HttpReranker(
    rerankUrl, config.rag.rerank.apiKey, config.rag.rerank.model,
    parseRerankProvider(config.rag.rerank.provider),
  );
  await rerankerAdapter.probe();
  const reranker: Reranker = rerankerAdapter;
  const contextAssembler: ContextAssembler = new SimpleContextAssembler();

  const verifier: ClaimVerifier = config.rag.citation.verifyClaims
    ? new LlmClaimVerifier(reasoningClient, config.agent.reasoningModel, config.rag.citation.verifyConsensus)
    : new StructuralClaimVerifier();
  const modelSettings: PiModelSettings = {
    model: config.rag.generation.model,
    baseUrl: config.rag.generation.baseUrl,
    apiKey: config.rag.generation.apiKey,
    contextWindow: config.rag.generation.contextWindow,
    maxTokens: config.rag.generation.maxOutputTokens,
    temperature: config.rag.generation.temperature,
  };
  const agentKernel = new PiAgentKernel({
    settings: modelSettings,
    streamFn: buildPiStreamFn(modelSettings),
    retriever: retriever,
    reranker: reranker,
    contextAssembler: contextAssembler,
    promptRegistry: new BuiltinPromptRegistry(),
    answerFinalizer: new GroundedAnswerFinalizer(verifier),
  });

  const storage = buildStorage(config);
  const vectorConsistency = () => quickConsistency(sql, config.rag.embedding, esUrl);
  // 与 Rust 一致：有数据库时启动后台向量 worker（DB 轮询消费，无 AMQP 队列加速）
  startVectorWorker(sql, config.rag.embedding, esUrl, config.rabbitmqUrl);

  const state: AppState = {
    config, sql, redis, repository, agentKernel, storage, vectorConsistency,
    llm: { generationClient, reasoningClient, retriever, reranker, contextAssembler },
  };
  // 与 Rust 一致：恢复上次中断遗留的待处理解析任务
  try {
    const { resumePendingDocumentJobs } = await import('./api/documents.ts');
    const resumed = await resumePendingDocumentJobs(state);
    if (resumed > 0) {
      console.warn(`[documind][state] resumed ${resumed} pending document jobs`);
    }
  } catch (error) {
    throw new Error(`failed to resume document jobs: ${(error as Error).message}`);
  }
  return state;
}

async function recoverInterruptedAgentRuns(sql: Sql): Promise<void> {
  const result = await sql.unsafe(`
    UPDATE conversation_messages
    SET status = 'failed',
        error_code = 'EXECUTION_INTERRUPTED',
        error_message = 'Agent execution was interrupted before completion; retry this message.',
        completed_at = NOW()
    WHERE role = 'assistant' AND status = 'answering'
  `);
  if (result.count > 0) {
    console.warn(`[documind][state] recovered ${result.count} interrupted agent messages`);
  }
}

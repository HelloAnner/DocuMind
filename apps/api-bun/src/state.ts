// 移植自 apps/api-rs/src/state.rs —— 应用状态装配
import type { Sql } from 'postgres';
import type Redis from 'ioredis';
import postgres from 'postgres';
import { Redis as RedisClient } from 'ioredis';
import type { AppConfig } from './config.ts';
import type { ConversationRepository, AnswerCache } from './repositories/types.ts';
import { InMemoryConversationRepository, SqlxConversationRepository } from './repositories/index.ts';
import { InMemoryAnswerCache, RedisAnswerCache } from './repositories/cache.ts';
import type { ObjectStorage } from './storage/types.ts';
import { buildStorage } from './storage/index.ts';
import { seedIdentity } from './auth/seed.ts';
import { OpenAiClient } from './llm/openai.ts';
import { asAgentModel } from './llm/agent_adapter.ts';
import type { AgentModel } from './agent/model.ts';
import {
  AgentKernel, AgentToolRegistry, BuiltinPromptRegistry, ClarificationTool,
  GroundedAnswerFinalizer, KnowledgeSearchTool, LlmClaimVerifier, StructuralClaimVerifier,
} from './agent/index.ts';
import type { ContextAssembler, Retriever, Reranker } from './rag/types.ts';
import { EsRetriever } from './rag/retriever.ts';
import { HttpReranker, parseRerankProvider } from './rag/reranker.ts';
import { SimpleContextAssembler } from './rag/context.ts';
import { embeddingClientConfigFrom } from './rag/embedding.ts';
import { quickConsistency, startVectorWorker } from './rag/vector_pipeline.ts';
import type { VectorConsistencySnapshot } from './http/health.ts';
import type { ClaimVerifier } from './agent/verifier/types.ts';

export interface AppState {
  config: AppConfig;
  sql: Sql | null;
  redis: Redis | null;
  repository: ConversationRepository;
  agentKernel: AgentKernel;
  cache: AnswerCache;
  storage: ObjectStorage;
  /** 健康检查用：rag/vector_pipeline.quickConsistency */
  vectorConsistency: (() => Promise<VectorConsistencySnapshot>) | null;
  llm: {
    generationClient: OpenAiClient;
    reasoningClient: OpenAiClient;
    agentModel: AgentModel;
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
  const cache: AnswerCache = redis ? new RedisAnswerCache(redis) : new InMemoryAnswerCache();

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
  const agentModel: AgentModel = asAgentModel(generationClient);

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
  const tools = new AgentToolRegistry([
    new KnowledgeSearchTool(retriever, reranker),
    new ClarificationTool(),
  ]);
  const agentKernel = new AgentKernel(
    agentModel, tools, contextAssembler,
    new BuiltinPromptRegistry(), new GroundedAnswerFinalizer(verifier),
  );

  const storage = buildStorage(config);
  const vectorConsistency = () => quickConsistency(sql, config.rag.embedding, esUrl);
  // 后台向量 worker：构建时不自动运行（由入口按需启动）
  void startVectorWorker;

  return {
    config, sql, redis, repository, agentKernel, cache, storage, vectorConsistency,
    llm: { generationClient, reasoningClient, agentModel, retriever, reranker, contextAssembler },
  };
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

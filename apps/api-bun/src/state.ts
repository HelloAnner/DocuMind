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
import type { AgentKernel } from './agent/kernel.ts';
import type { Retriever, Reranker, ContextAssembler } from './rag/types.ts';
import type { VectorConsistencySnapshot } from './http/health.ts';

export interface AppState {
  config: AppConfig;
  sql: Sql | null;
  redis: Redis | null;
  repository: ConversationRepository;
  agentKernel: AgentKernel;
  cache: AnswerCache;
  storage: ObjectStorage;
  /** 注入的健康检查回调：rag/vector_pipeline.quick_consistency */
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
    redis = new RedisClient(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  }
  const cache: AnswerCache = redis
    ? new RedisAnswerCache(redis)
    : new InMemoryAnswerCache();

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
  if (!config.elasticsearchUrl) {
    throw new Error('DocuMind Agent requires ELASTICSEARCH_URL');
  }

  // rag 组件由 src/rag 模块提供（移植中）：按下列签名装配
  const ragModule = await import('./rag/index.ts');
  const embeddingConfig = ragModule.embeddingClientConfigFromAppConfig(config);
  const retriever: Retriever = new ragModule.EsRetriever({
    esUrl: config.elasticsearchUrl,
    indexAlias: config.rag.embedding.indexAlias,
    embedding: embeddingConfig,
    embeddingModel: config.rag.embedding.model,
  });
  const contextAssembler: ContextAssembler = new ragModule.SimpleContextAssembler();

  if (!config.rag.rerank.enabled) {
    throw new Error('DocuMind Agent requires RAG_RERANK_ENABLED=true; rule-based reranking was removed');
  }
  if (!config.rag.rerank.apiUrl) {
    throw new Error('RAG_RERANK_API_URL is required');
  }
  const rerankerAdapter = new ragModule.HttpReranker({
    apiUrl: config.rag.rerank.apiUrl,
    apiKey: config.rag.rerank.apiKey,
    model: config.rag.rerank.model,
    provider: ragModule.parseRerankProvider(config.rag.rerank.provider),
  });
  await rerankerAdapter.probe();
  const reranker: Reranker = rerankerAdapter;

  // agent 组件由 src/agent 模块提供（移植中）
  const agentModule = await import('./agent/index.ts');
  const verifier = config.rag.citation.verifyClaims
    ? new agentModule.LlmClaimVerifier({
      client: reasoningClient,
      model: config.agent.reasoningModel,
      useConsensus: config.rag.citation.verifyConsensus,
    })
    : new agentModule.StructuralClaimVerifier();
  const tools = new agentModule.AgentToolRegistry([
    new ragModule.KnowledgeSearchTool(retriever, reranker),
    new agentModule.ClarificationTool(),
  ]);
  const agentKernel: AgentKernel = new agentModule.AgentKernel({
    model: agentModel,
    tools,
    contextAssembler,
    promptRegistry: new agentModule.BuiltinPromptRegistry(),
    finalizer: new agentModule.GroundedAnswerFinalizer(verifier),
  });

  const storage = buildStorage(config);

  let vectorConsistency: AppState['vectorConsistency'] = null;
  if (sql && config.elasticsearchUrl) {
    vectorConsistency = () => ragModule.quickConsistency(sql!, config);
    // 后台向量 worker：只定义启动，不在构建时自动执行
    void ragModule.startVectorWorker;
  }

  return {
    config, sql, redis, repository, agentKernel, cache, storage, vectorConsistency,
    llm: {
      generationClient, reasoningClient, agentModel,
      retriever, reranker, contextAssembler,
    },
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

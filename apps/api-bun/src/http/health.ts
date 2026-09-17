// 移植自 apps/api-rs/src/lib.rs 的依赖探测与 /api/health
import type Redis from 'ioredis';
import type { Sql } from 'postgres';
import type { AppConfig } from '../config.ts';

const HEALTH_TIMEOUT_MS = 2_000;

export interface DependencyCheck {
  ok: boolean;
  reason: string | null;
  fields: Record<string, unknown>;
}
export function checkOk(): DependencyCheck { return { ok: true, reason: null, fields: {} }; }
export function checkFailed(reason: string): DependencyCheck { return { ok: false, reason, fields: {} }; }
export function withField(check: DependencyCheck, key: string, value: unknown): DependencyCheck {
  check.fields[key] = value;
  return check;
}
export function checkIntoJson(check: DependencyCheck): Record<string, unknown> {
  const payload: Record<string, unknown> = { ok: check.ok };
  if (check.reason !== null) payload.reason = check.reason;
  for (const [key, value] of Object.entries(check.fields)) payload[key] = value;
  return payload;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(label)), HEALTH_TIMEOUT_MS)),
  ]);
}

export async function checkPostgres(sql: Sql | null): Promise<DependencyCheck> {
  if (!sql) return checkFailed('DATABASE_URL is not configured');
  try {
    const rows = await withTimeout(sql`SELECT 1 AS one`, 'database health check timed out');
    if (Number(rows[0]?.one) === 1) return checkOk();
    return checkFailed('unexpected database health response');
  } catch (error) {
    return checkFailed((error as Error).message);
  }
}

export async function checkRedis(redis: Redis | null): Promise<DependencyCheck> {
  if (!redis) return checkFailed('REDIS_URL is not configured');
  try {
    const result = await withTimeout(redis.ping(), 'redis connection timed out');
    if (result === 'PONG') return checkOk();
    return checkFailed(`unexpected redis ping response: ${result}`);
  } catch (error) {
    return checkFailed((error as Error).message);
  }
}

function present(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

async function checkHttpGet(url: string, label: string): Promise<DependencyCheck> {
  try {
    const response = await withTimeout(fetch(url), `${label} health check timed out`);
    if (httpStatusAllowsReachable(response.status)) return checkOk();
    return checkFailed(`${label} returned HTTP ${response.status}`);
  } catch (error) {
    return checkFailed((error as Error).message);
  }
}

function httpStatusAllowsReachable(status: number): boolean {
  return (status >= 200 && status < 300) || status === 401 || status === 403;
}

export async function checkElasticsearch(
  url: string | null, indexName: string,
): Promise<DependencyCheck> {
  const base = present(url);
  if (!base) return checkFailed('ELASTICSEARCH_URL is not configured');
  const cluster = await checkHttpGet(`${base.replace(/\/+$/, '')}/_cluster/health`, 'elasticsearch cluster');
  if (!cluster.ok) return withField(cluster, 'index', indexName);
  const index = present(indexName);
  if (!index) return checkFailed('ES_INDEX_CHUNKS is not configured');
  return withField(
    await checkHttpGet(`${base.replace(/\/+$/, '')}/${index}/_mapping`, 'elasticsearch retrieval index'),
    'index', index);
}

export async function checkObjectStorage(
  provider: string, endpoint: string | null, bucket: string,
): Promise<DependencyCheck> {
  const ep = present(endpoint);
  if (!ep) return checkFailed('OBJECT_STORAGE_ENDPOINT is not configured');
  const url = provider.toLowerCase() === 'minio'
    ? `${ep.replace(/\/+$/, '')}/minio/health/live` : ep;
  const check = await checkHttpGet(url, 'object storage');
  withField(check, 'provider', provider);
  withField(check, 'bucket', bucket);
  return check;
}

export function openaiModelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/embeddings')) return `${base.slice(0, -'/embeddings'.length)}/models`;
  if (base.endsWith('/chat/completions')) return `${base.slice(0, -'/chat/completions'.length)}/models`;
  return `${base}/models`;
}

export async function checkOpenAiCompatibleEndpoint(
  enabled: boolean, baseUrl: string, apiKey: string | null, label: string,
): Promise<DependencyCheck> {
  if (!enabled) return checkFailed(`${label} is disabled`);
  const key = present(apiKey);
  if (!key) return checkFailed(`${label} API key is not configured`);
  const url = openaiModelsUrl(baseUrl);
  try {
    const response = await withTimeout(
      fetch(url, { headers: { Authorization: `Bearer ${key}` } }),
      `${label} provider health check timed out`,
    );
    if (response.ok) return checkOk();
    return checkFailed(`${label} provider returned HTTP ${response.status}`);
  } catch (error) {
    return checkFailed((error as Error).message);
  }
}

export function parseHostPort(rawUrl: string, defaultPort: number): [string, number] | null {
  const afterScheme = rawUrl.includes('://') ? rawUrl.split('://')[1]! : rawUrl;
  const authority = afterScheme.split('/')[0]?.trim();
  if (!authority) return null;
  const hostPort = authority.includes('@') ? authority.split('@').pop()!.trim() : authority;
  if (hostPort.length === 0) return null;
  if (hostPort.startsWith('[')) {
    const closing = hostPort.indexOf(']');
    if (closing === -1) return null;
    const host = hostPort.slice(1, closing);
    const after = hostPort.slice(closing + 1);
    const port = after.startsWith(':') ? Number(after.slice(1)) : defaultPort;
    return Number.isFinite(port) ? [host, port] : null;
  }
  if (hostPort.includes(':')) {
    const index = hostPort.lastIndexOf(':');
    const host = hostPort.slice(0, index).trim();
    const port = Number(hostPort.slice(index + 1));
    if (host.length === 0 || !Number.isFinite(port)) return null;
    return [host, port];
  }
  return [hostPort, defaultPort];
}

export async function checkTcpUrl(url: string | null, defaultPort: number): Promise<DependencyCheck> {
  const raw = present(url);
  if (!raw) return checkFailed('RABBITMQ_URL is not configured');
  const parsed = parseHostPort(raw, defaultPort);
  if (!parsed) return checkFailed('RABBITMQ_URL host or port is invalid');
  const [host, port] = parsed;
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const socket = new (require('node:net')).Socket();
        socket.connect(port, host, () => { socket.destroy(); resolve(); });
        socket.on('error', (error: Error) => { socket.destroy(); reject(error); });
      }),
      'rabbitmq tcp connection timed out',
    );
    return withField(withField(checkOk(), 'host', host), 'port', port);
  } catch (error) {
    return withField(withField(checkFailed((error as Error).message), 'host', host), 'port', port);
  }
}

export interface VectorConsistencySnapshot {
  consistent: boolean;
  expected_chunks: number;
  actual_chunks: number;
  missing_or_stale_chunks: number;
}

export interface HealthDeps {
  config: AppConfig;
  sql: Sql | null;
  redis: Redis | null;
  /** 注入 rag/vector_pipeline.quick_consistency，避免循环依赖 */
  vectorConsistency: (() => Promise<VectorConsistencySnapshot>) | null;
}

export async function healthPayload(deps: HealthDeps): Promise<Record<string, unknown>> {
  const { config } = deps;
  const postgres = await checkPostgres(deps.sql);
  const redis = await checkRedis(deps.redis);
  const elasticsearch = await checkElasticsearch(
    config.elasticsearchUrl, config.rag.embedding.indexAlias);
  const objectStorage = await checkObjectStorage(
    config.objectStorageProvider, config.objectStorageEndpoint, config.objectStorageBucket);
  const rabbitmq = await checkTcpUrl(config.rabbitmqUrl, 5672);
  const realLlm = withField(
    await checkOpenAiCompatibleEndpoint(
      config.rag.generation.useRealLlm, config.rag.generation.baseUrl,
      config.rag.generation.apiKey, 'LLM'),
    'model', config.rag.generation.model);
  const embedding = withField(withField(
    await checkOpenAiCompatibleEndpoint(
      config.rag.embedding.enabled, config.rag.embedding.baseUrl,
      config.rag.embedding.apiKey, 'Embedding'),
    'model', config.rag.embedding.model),
    'index', config.rag.embedding.indexAlias);

  let vectorConsistency: VectorConsistencySnapshot | { consistent: boolean; error: string };
  if (deps.sql && config.elasticsearchUrl && deps.vectorConsistency) {
    try {
      vectorConsistency = await deps.vectorConsistency();
    } catch (error) {
      vectorConsistency = { consistent: false, error: (error as Error).message };
    }
  } else {
    vectorConsistency = { consistent: false, error: 'vector index dependencies are not configured' };
  }
  const vectorIndexConsistent = 'consistent' in vectorConsistency && vectorConsistency.consistent;

  const reranker = withField(withField(withField(checkOk(),
    'provider', config.rag.rerank.provider),
    'model', config.rag.rerank.model),
    'startup_probe', 'passed');

  const ok = [postgres.ok, redis.ok, elasticsearch.ok, objectStorage.ok, rabbitmq.ok,
    realLlm.ok, embedding.ok, vectorIndexConsistent, reranker.ok].every(Boolean);

  return {
    ok, service: 'documind', mode: 'release', environment: config.environment,
    version: '0.1.0',
    checks: {
      postgres: postgres.ok, redis: redis.ok, elasticsearch: elasticsearch.ok,
      object_storage: objectStorage.ok, rabbitmq: rabbitmq.ok, real_llm: realLlm.ok,
      embedding: embedding.ok, vector_index_consistent: vectorIndexConsistent,
      reranker: reranker.ok,
    },
    details: {
      postgres: checkIntoJson(postgres), redis: checkIntoJson(redis),
      elasticsearch: checkIntoJson(elasticsearch),
      object_storage: checkIntoJson(objectStorage), rabbitmq: checkIntoJson(rabbitmq),
      real_llm: checkIntoJson(realLlm), embedding: checkIntoJson(embedding),
      vector_index: vectorConsistency, reranker: checkIntoJson(reranker),
    },
  };
}

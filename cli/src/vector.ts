import { ApiClient } from "./api.ts";
import { ApiError, CliError } from "./errors.ts";
import type { Identity, JsonObject, VectorIndexSummary } from "./types.ts";

export interface VectorBrowseOptions {
  kbId?: string;
  docId?: string;
  limit?: number;
  offset?: number;
  includeEmbedding?: boolean;
}

export interface VectorSearchOptions extends VectorBrowseOptions {
  query: string;
}

export interface VectorHit {
  index: string;
  id: string;
  score?: number | null;
  source: JsonObject;
  highlight?: Record<string, string[]>;
}

export interface VectorResult {
  took_ms: number;
  total: number;
  hits: VectorHit[];
}

export interface VectorAuditItem {
  kb_id: string;
  kb_name: string;
  postgres_chunks: number;
  postgres_embedded_chunks?: number;
  elasticsearch_chunks: number;
  delta: number;
  consistent: boolean;
  backend_status?: string;
}

export interface VectorAuditResult {
  tenant_id: string;
  tenant: string;
  consistent: boolean;
  items: VectorAuditItem[];
}

interface ElasticsearchResponse {
  took?: number;
  hits?: {
    total?: number | { value?: number };
    hits?: Array<{
      _index?: string;
      _id?: string;
      _score?: number | null;
      _source?: JsonObject;
      highlight?: Record<string, string[]>;
    }>;
  };
  count?: number;
}

export class VectorDiagnostics {
  constructor(private readonly api: ApiClient) {}

  async indexes(): Promise<VectorIndexSummary[]> {
    const identity = await this.api.me();
    try {
      const indexes = await this.api.listVectorIndexes();
      return indexes.filter((item) =>
        item.tenant_id === identity.tenant.id && identity.allowed_kb_ids.includes(item.kb_id));
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 403) throw error;
      const knowledgeBases = await this.api.listKnowledgeBases();
      const fallback: VectorIndexSummary[] = [];
      for (const kb of knowledgeBases) {
        const esDocuments = await this.count({ kbId: kb.id });
        fallback.push({
          id: `${kb.id}:unknown`,
          name: this.api.config.diagnostics.elasticsearch_index,
          alias: this.api.config.diagnostics.elasticsearch_index,
          tenant_id: identity.tenant.id,
          tenant: identity.tenant.name,
          kb_id: kb.id,
          kb_name: kb.name,
          embedding_model: "unknown",
          index_version: "unknown",
          dimension: 0,
          documents: kb.doc_count,
          building_documents: 0,
          degraded_documents: 0,
          chunks: kb.chunk_count,
          embedded_chunks: 0,
          es_documents: esDocuments,
          status: esDocuments === kb.chunk_count ? "healthy" : "degraded",
        });
      }
      return fallback;
    }
  }

  async audit(): Promise<VectorAuditResult> {
    const identity = await this.api.me();
    const [knowledgeBases, indexes] = await Promise.all([
      this.api.listKnowledgeBases(),
      this.indexes(),
    ]);
    const items: VectorAuditItem[] = [];
    for (const kb of knowledgeBases) {
      const index = indexes.find((item) => item.kb_id === kb.id);
      const elasticsearchChunks = await this.count({ kbId: kb.id });
      const delta = elasticsearchChunks - kb.chunk_count;
      items.push({
        kb_id: kb.id,
        kb_name: kb.name,
        postgres_chunks: kb.chunk_count,
        ...(index ? { postgres_embedded_chunks: index.embedded_chunks } : {}),
        elasticsearch_chunks: elasticsearchChunks,
        delta,
        consistent: delta === 0,
        ...(index ? { backend_status: index.status } : {}),
      });
    }
    return {
      tenant_id: identity.tenant.id,
      tenant: identity.tenant.slug,
      consistent: items.every((item) => item.consistent),
      items,
    };
  }

  async count(options: VectorBrowseOptions = {}): Promise<number> {
    const identity = await this.identityAndScope(options.kbId);
    const query = scopedQuery(identity, options, { match_all: {} });
    const result = await this.remoteJson<ElasticsearchResponse>("_count", { query });
    if (typeof result.count !== "number") throw new CliError("Elasticsearch _count 响应缺少 count", 1, result);
    return result.count;
  }

  async browse(options: VectorBrowseOptions = {}): Promise<VectorResult> {
    const identity = await this.identityAndScope(options.kbId);
    const result = await this.remoteJson<ElasticsearchResponse>("_search", {
      from: options.offset ?? 0,
      size: options.limit ?? 20,
      _source: sourceFilter(options.includeEmbedding),
      query: scopedQuery(identity, options, { match_all: {} }),
      sort: [{ doc_id: "asc" }, { chunk_index: "asc" }],
    });
    return normalizeResult(result);
  }

  async search(options: VectorSearchOptions): Promise<VectorResult> {
    if (!options.query.trim()) throw new CliError("vector search 需要查询文本", 2);
    const identity = await this.identityAndScope(options.kbId);
    const result = await this.remoteJson<ElasticsearchResponse>("_search", {
      from: options.offset ?? 0,
      size: options.limit ?? 20,
      _source: sourceFilter(options.includeEmbedding),
      query: scopedQuery(identity, options, {
        multi_match: {
          query: options.query,
          fields: ["content^3", "doc_title^2", "heading_path"],
          type: "best_fields",
        },
      }),
      highlight: {
        fields: { content: { fragment_size: 240, number_of_fragments: 2 } },
        pre_tags: [""],
        post_tags: [""],
      },
    });
    return normalizeResult(result);
  }

  async get(chunkId: string, includeEmbedding = false): Promise<VectorHit | undefined> {
    const identity = await this.identityAndScope(undefined);
    const result = await this.remoteJson<ElasticsearchResponse>("_search", {
      size: 1,
      _source: sourceFilter(includeEmbedding),
      query: {
        bool: {
          filter: [
            { term: { tenant_id: identity.tenant.id } },
            { terms: { kb_id: identity.allowed_kb_ids } },
            { term: { chunk_id: chunkId } },
          ],
        },
      },
    });
    return normalizeResult(result).hits[0];
  }

  private async identityAndScope(kbId: string | undefined): Promise<Identity> {
    const identity = await this.api.me();
    if (identity.allowed_kb_ids.length === 0) {
      throw new CliError("当前用户没有可访问的知识库", 2);
    }
    if (kbId && !identity.allowed_kb_ids.includes(kbId)) {
      throw new CliError(`当前用户无权访问知识库: ${kbId}`, 2);
    }
    return identity;
  }

  private async remoteJson<T>(operation: "_search" | "_count", body: unknown): Promise<T> {
    const diagnostics = this.api.config.diagnostics;
    if (!diagnostics.ssh_host) {
      throw new CliError("未配置 diagnostics.ssh_host，无法从服务器内部访问向量库", 2);
    }
    if (!diagnostics.elasticsearch_url) {
      throw new CliError("未配置 diagnostics.elasticsearch_url", 2);
    }
    if (!Bun.which("ssh")) throw new CliError("本机找不到 ssh 命令", 2);
    validateRemoteConfiguration(
      diagnostics.ssh_host,
      diagnostics.elasticsearch_url,
      diagnostics.elasticsearch_index,
    );
    const url = `${diagnostics.elasticsearch_url.replace(/\/+$/, "")}/` +
      `${diagnostics.elasticsearch_index}/${operation}`;
    const command = [
      "curl",
      "-sS",
      "--max-time",
      "90",
      "-H",
      "Content-Type: application/json",
      "-X",
      "POST",
      url,
      "--data-binary",
      "@-",
      "-w",
      "\\n__DOCUMIND_HTTP_STATUS__:%{http_code}",
    ].map(shellQuote).join(" ");
    const processHandle = Bun.spawn(
      ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", diagnostics.ssh_host, command],
      {
        stdin: new Blob([JSON.stringify(body)]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ]);
    if (exitCode !== 0) {
      throw new CliError(
        `通过 SSH 访问 Elasticsearch 失败（exit ${exitCode}）: ${stderr.trim() || "无错误输出"}`,
      );
    }
    const marker = "\n__DOCUMIND_HTTP_STATUS__:";
    const markerIndex = stdout.lastIndexOf(marker);
    if (markerIndex === -1) {
      throw new CliError("Elasticsearch 响应缺少 HTTP 状态标记", 1, stdout.slice(0, 500));
    }
    const responseText = stdout.slice(0, markerIndex);
    const status = Number(stdout.slice(markerIndex + marker.length).trim());
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText) as unknown;
    } catch {
      throw new CliError("Elasticsearch 返回了非 JSON 内容", 1, responseText.slice(0, 500));
    }
    if (!Number.isFinite(status) || status < 200 || status >= 300) {
      throw new CliError(`Elasticsearch 返回 HTTP ${status}`, 1, parsed);
    }
    return parsed as T;
  }
}

function scopedQuery(
  identity: Identity,
  options: VectorBrowseOptions,
  query: JsonObject,
): JsonObject {
  const filters: JsonObject[] = [
    { term: { tenant_id: identity.tenant.id } },
    options.kbId
      ? { term: { kb_id: options.kbId } }
      : { terms: { kb_id: identity.allowed_kb_ids } },
  ];
  if (options.docId) filters.push({ term: { doc_id: options.docId } });
  return { bool: { filter: filters, must: [query] } };
}

function sourceFilter(includeEmbedding = false): JsonObject | boolean {
  return includeEmbedding ? true : { excludes: ["embedding"] };
}

function normalizeResult(result: ElasticsearchResponse): VectorResult {
  const totalValue = result.hits?.total;
  const total = typeof totalValue === "number" ? totalValue : totalValue?.value ?? 0;
  return {
    took_ms: result.took ?? 0,
    total,
    hits: (result.hits?.hits ?? []).map((hit) => ({
      index: hit._index ?? "",
      id: hit._id ?? "",
      ...(hit._score !== undefined ? { score: hit._score } : {}),
      source: hit._source ?? {},
      ...(hit.highlight ? { highlight: hit.highlight } : {}),
    })),
  };
}

function validateRemoteConfiguration(host: string, url: string, index: string): void {
  if (!/^[a-zA-Z0-9_.@:-]+$/.test(host)) throw new CliError("ssh_host 包含非法字符", 2);
  if (!/^[a-zA-Z0-9_.-]+$/.test(index)) throw new CliError("Elasticsearch index 包含非法字符", 2);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError("elasticsearch_url 不是有效 URL", 2);
  }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) {
    throw new CliError("elasticsearch_url 只支持 http/https", 2);
  }
  if (parsed.username || parsed.password) {
    throw new CliError("不要在 elasticsearch_url 中填写凭据；应使用服务器内部受控地址", 2);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

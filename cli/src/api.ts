import { ApiError, CliError } from "./errors.ts";
import {
  clearSession,
  configuredPassword,
  readSession,
  writeSession,
} from "./config.ts";
import type {
  AdminDocument,
  AdminDocumentDetail,
  CliConfig,
  ConversationSummary,
  Identity,
  KnowledgeBase,
  LoginResponse,
  MessageListResponse,
  MessageTraceResponse,
  SessionState,
  VectorIndexSummary,
} from "./types.ts";

export class ApiClient {
  readonly baseUrl: string;
  private session: SessionState | undefined;

  constructor(
    readonly config: CliConfig,
    readonly configPath: string,
  ) {
    this.baseUrl = buildBaseUrl(config);
  }

  async login(force = false): Promise<Identity> {
    const previous = await this.getSession();
    if (!force) {
      if (previous.access_token) {
        try {
          return await this.me(false);
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 401) throw error;
        }
      }
    }
    const response = await this.requestJson<LoginResponse>(
      "/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify({
          username: this.config.auth.username,
          password: configuredPassword(this.config),
          tenant_slug: this.config.auth.tenant,
        }),
      },
      false,
      false,
    );
    this.session = {
      access_token: response.access_token,
      user: response.user,
      tenant: response.tenant,
      roles: response.roles,
      permissions: response.permissions,
      allowed_kb_ids: response.allowed_kb_ids,
      ...(previous.last_conversation_id
        ? { last_conversation_id: previous.last_conversation_id }
        : {}),
      saved_at: new Date().toISOString(),
    };
    await writeSession(this.configPath, this.session);
    return response;
  }

  async logout(): Promise<void> {
    const current = await this.getSession();
    if (current.access_token) {
      try {
        await this.requestJson("/api/auth/logout", { method: "POST" }, true, false);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
      }
    }
    this.session = {};
    await clearSession(this.configPath);
  }

  async me(autoLogin = true): Promise<Identity> {
    const identity = await this.requestJson<Identity>(
      "/api/me",
      undefined,
      true,
      autoLogin,
    );
    await this.updateSession(identity);
    return identity;
  }

  async health(): Promise<unknown> {
    return this.requestJson("/api/health", undefined, false, false);
  }

  async listKnowledgeBases(): Promise<KnowledgeBase[]> {
    return this.requestJson("/api/knowledge-bases");
  }

  async listConversations(limit = 20, cursor?: string): Promise<{
    items: ConversationSummary[];
    next_cursor?: string;
  }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return this.requestJson(`/api/conversations?${query}`);
  }

  async createConversation(kbIds: string[], title?: string): Promise<ConversationSummary> {
    return this.requestJson("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ kb_ids: kbIds, ...(title ? { title } : {}) }),
    });
  }

  async getConversation(id: string): Promise<ConversationSummary> {
    return this.requestJson(`/api/conversations/${encodeURIComponent(id)}`);
  }

  async deleteConversation(id: string): Promise<unknown> {
    return this.requestJson(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async getMessages(conversationId: string): Promise<MessageListResponse> {
    return this.requestJson(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
  }

  async getMessageTrace(
    conversationId: string,
    messageId: string,
  ): Promise<MessageTraceResponse> {
    return this.requestJson(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/traces`,
    );
  }

  async listDocuments(options: {
    kbId?: string;
    status?: string;
    query?: string;
    limit?: number;
  } = {}): Promise<AdminDocument[]> {
    const query = new URLSearchParams();
    if (options.kbId) query.set("kb_id", options.kbId);
    if (options.status) query.set("status", options.status);
    if (options.query) query.set("q", options.query);
    if (options.limit) query.set("limit", String(options.limit));
    const suffix = query.size ? `?${query}` : "";
    return this.requestJson(`/api/admin/documents${suffix}`);
  }

  async getDocument(id: string): Promise<AdminDocumentDetail> {
    return this.requestJson(`/api/admin/documents/${encodeURIComponent(id)}`);
  }

  async listVectorIndexes(): Promise<VectorIndexSummary[]> {
    return this.requestJson("/api/system/vector-indexes");
  }

  async saveLastConversation(conversationId: string): Promise<void> {
    const state = await this.getSession();
    state.last_conversation_id = conversationId;
    state.saved_at = new Date().toISOString();
    await writeSession(this.configPath, state);
  }

  async lastConversationId(): Promise<string | undefined> {
    return (await this.getSession()).last_conversation_id;
  }

  async sse(path: string, body: unknown, retryAuthentication = true): Promise<Response> {
    const token = await this.accessToken();
    const response = await fetch(this.url(path), {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-DocuMind-Event-Protocol": "atom",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.server.timeout_seconds * 1000),
    });
    if (response.status === 401 && retryAuthentication) {
      await this.login(true);
      return this.sse(path, body, false);
    }
    if (!response.ok) {
      throw new ApiError("POST", this.url(path), response.status, await responseBody(response));
    }
    if (!response.body) throw new CliError("SSE 响应没有 body");
    return response;
  }

  async requestJson<T = unknown>(
    path: string,
    init: RequestInit = {},
    authenticated = true,
    retryAuthentication = true,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (authenticated) headers.set("Authorization", `Bearer ${await this.accessToken()}`);
    const method = init.method ?? "GET";
    const url = this.url(path);
    const response = await fetch(url, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(this.config.server.timeout_seconds * 1000),
    });
    if (authenticated && retryAuthentication && response.status === 401) {
      await this.login(true);
      return this.requestJson<T>(path, init, authenticated, false);
    }
    if (!response.ok) {
      throw new ApiError(method, url, response.status, await responseBody(response));
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CliError(`API ${method} ${url} 返回了非 JSON 内容`, 1, text.slice(0, 500));
    }
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private async accessToken(): Promise<string> {
    const state = await this.getSession();
    if (state.access_token) return state.access_token;
    await this.login(true);
    const refreshed = await this.getSession();
    if (!refreshed.access_token) throw new CliError("登录成功但未得到 access token");
    return refreshed.access_token;
  }

  private async getSession(): Promise<SessionState> {
    this.session ??= await readSession(this.configPath);
    return this.session;
  }

  private async updateSession(identity: Identity): Promise<void> {
    const state = await this.getSession();
    this.session = {
      ...state,
      ...identity,
      saved_at: new Date().toISOString(),
    };
    await writeSession(this.configPath, this.session);
  }
}

function buildBaseUrl(config: CliConfig): string {
  const server = config.server.url.replace(/\/+$/, "");
  const path = config.server.base_path.trim();
  if (!path || path === "/") return server;
  return `${server}/${path.replace(/^\/+|\/+$/g, "")}`;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

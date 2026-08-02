import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiClient } from "../src/api.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { AdminDocument, CliConfig, KnowledgeBase } from "../src/types.ts";

interface CapturedRequest {
  method: string;
  path: string;
  authorization?: string;
  contentType?: string;
  json?: unknown;
  file?: { name: string; size: number };
  batchId?: string;
}

describe("ApiClient admin management", () => {
  test("maps every knowledge-base and document action to the backend contract", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "documind-cli-admin-"));
    const requests: CapturedRequest[] = [];
    const fetcher = createFetcher(requests);
    const config: CliConfig = {
      ...DEFAULT_CONFIG,
      server: { ...DEFAULT_CONFIG.server, url: "https://documind.test", base_path: "" },
      auth: { ...DEFAULT_CONFIG.auth, password: "secret" },
    };
    const api = new ApiClient(config, join(temporary, "config.toml"), fetcher);

    try {
      await api.listAdminKnowledgeBases();
      await api.listVectorIndexes();
      await api.createKnowledgeBase({ name: "Legal", status: "active", tags: ["law"] });
      await api.updateKnowledgeBase("kb/1", { name: "Legal 2", status: "archived", tags: [] });
      await api.deleteKnowledgeBase("kb/1");
      await api.uploadDocument("kb/1", new Blob(["document"]), "policy.md", "batch-1");
      await api.listDocumentJobs({ status: "processing", batchId: "batch-1" });
      await api.getDocumentJob("job/1");
      await api.retryDocument("doc/1");
      await api.retryDocuments(["doc/1", "doc-2"]);
      await api.forceIndexDocument("doc/1");
      await api.excludeDocumentFromSearch("doc/1");
      await api.replaceDocumentFile("doc/1", new Blob(["replacement"]), "policy-v2.md");
      await api.sendDocumentToOcr("doc/1");
      await api.moveDocument("doc/1", "kb-2");
      await api.deleteDocument("doc/1");
      const downloaded = await api.downloadDocument("doc/1");

      expect(new TextDecoder().decode(downloaded.bytes)).toBe("original");
      expect(downloaded.content_type).toBe("application/pdf");
      expect(requests.map((item) => `${item.method} ${item.path}`)).toEqual([
        "POST /api/auth/login",
        "GET /api/admin/knowledge-bases",
        "GET /api/diagnostics/vector-indexes",
        "POST /api/admin/knowledge-bases",
        "PUT /api/admin/knowledge-bases/kb%2F1",
        "DELETE /api/admin/knowledge-bases/kb%2F1",
        "POST /api/knowledge-bases/kb%2F1/documents",
        "GET /api/admin/document-jobs",
        "GET /api/admin/document-jobs/job%2F1",
        "POST /api/admin/documents/doc%2F1/retry",
        "POST /api/admin/documents/retry",
        "POST /api/admin/documents/doc%2F1/force-index",
        "POST /api/admin/documents/doc%2F1/exclude-from-search",
        "POST /api/admin/documents/doc%2F1/replace-file",
        "POST /api/admin/documents/doc%2F1/send-to-ocr",
        "POST /api/admin/documents/doc%2F1/move",
        "DELETE /api/admin/documents/doc%2F1",
        "GET /api/admin/documents/doc%2F1/original",
      ]);
      expect(requests.slice(1).every((item) => item.authorization === "Bearer token")).toBe(true);

      const upload = requests.find((item) => item.path.endsWith("/documents") && item.file);
      expect(upload?.file).toEqual({ name: "policy.md", size: 8 });
      expect(upload?.batchId).toBe("batch-1");
      expect(upload?.contentType).toBeUndefined();
      const replacement = requests.find((item) => item.path.endsWith("/replace-file"));
      expect(replacement?.file).toEqual({ name: "policy-v2.md", size: 11 });
      expect(replacement?.contentType).toBeUndefined();
      expect(requests.find((item) => item.path === "/api/admin/documents/retry")?.json)
        .toEqual({ doc_ids: ["doc/1", "doc-2"] });
      expect(requests.find((item) => item.path.endsWith("/move"))?.json)
        .toEqual({ kb_id: "kb-2" });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("retries platform login without tenant scope", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "documind-cli-platform-"));
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse(
          { code: "PLATFORM_ADMIN_TENANT_LOGIN_FORBIDDEN", message: "use platform login" },
          403,
        );
      }
      return jsonResponse(identity());
    }) as typeof fetch;
    const config: CliConfig = {
      ...DEFAULT_CONFIG,
      server: { ...DEFAULT_CONFIG.server, url: "https://documind.test", base_path: "" },
      auth: { ...DEFAULT_CONFIG.auth, password: "secret", tenant: "acme" },
    };

    try {
      await new ApiClient(config, join(temporary, "config.toml"), fetcher).login(true);
      expect(bodies).toEqual([
        { username: config.auth.username, password: "secret", tenant_slug: "acme" },
        { username: config.auth.username, password: "secret" },
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

function createFetcher(requests: CapturedRequest[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    const captured: CapturedRequest = {
      method: init?.method ?? "GET",
      path: url.pathname,
      ...(headers.get("authorization") ? { authorization: headers.get("authorization") ?? "" } : {}),
      ...(headers.get("content-type") ? { contentType: headers.get("content-type") ?? "" } : {}),
    };
    if (init?.body instanceof FormData) {
      const file = init.body.get("file");
      if (file instanceof File) captured.file = { name: file.name, size: file.size };
      const batchId = init.body.get("upload_batch_id");
      if (typeof batchId === "string") captured.batchId = batchId;
    } else if (typeof init?.body === "string") {
      captured.json = JSON.parse(init.body) as unknown;
    }
    requests.push(captured);

    if (url.pathname === "/api/auth/login") return jsonResponse(identity());
    if (url.pathname.endsWith("/original")) {
      return new Response("original", { headers: { "Content-Type": "application/pdf" } });
    }
    if (url.pathname === "/api/admin/knowledge-bases" && captured.method === "GET") {
      return jsonResponse([]);
    }
    if (url.pathname === "/api/diagnostics/vector-indexes") return jsonResponse([]);
    if (url.pathname === "/api/admin/document-jobs") return jsonResponse({ items: [], summary: { queued: 0, processing: 0, failed_24h: 0, completed_24h: 0, stalled: 0 } });
    if (url.pathname.startsWith("/api/admin/document-jobs/")) return jsonResponse({ job: {}, events: [] });
    if (url.pathname.includes("knowledge-bases") && captured.method !== "DELETE") {
      if (url.pathname.endsWith("/documents")) return jsonResponse(uploadResponse());
      return jsonResponse(knowledgeBase());
    }
    if (url.pathname.includes("/retry") && url.pathname.endsWith("/retry") && captured.json) {
      return jsonResponse({ retried: 2 });
    }
    if (url.pathname.endsWith("/retry")) return jsonResponse(document());
    if (url.pathname.endsWith("/force-index")) return jsonResponse(reprocessResponse());
    if (url.pathname.endsWith("/exclude-from-search")) {
      return jsonResponse({ document_id: "doc-1", status: "excluded_from_search", es_deleted_chunks: 2 });
    }
    if (url.pathname.endsWith("/replace-file")) {
      return jsonResponse({ ...reprocessResponse(), title: "policy", file_type: "md", file_sha256: "sha", storage_key: "key" });
    }
    if (url.pathname.endsWith("/send-to-ocr")) {
      return jsonResponse({ document_id: "doc-1", ocr_job_id: "ocr-1", parse_status: "ocr_pending", ocr_status: "pending" });
    }
    if (url.pathname.endsWith("/move")) return jsonResponse(document());
    if (captured.method === "DELETE" && url.pathname.includes("knowledge-bases")) {
      return jsonResponse({ kb_id: "kb-1", status: "deleted" });
    }
    if (captured.method === "DELETE") return jsonResponse({ document_id: "doc-1", status: "deleted" });
    return jsonResponse({});
  }) as typeof fetch;
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Content-Type": "application/json" } });
}

function identity(): unknown {
  return {
    access_token: "token",
    token_type: "Bearer",
    user: { id: "user", email: "admin@example.com", status: "active" },
    tenant: { id: "tenant", name: "Acme", slug: "acme", plan: "enterprise", status: "active" },
    roles: ["tenant_admin"],
    permissions: ["kb.manage", "document.upload"],
    allowed_kb_ids: ["kb-1"],
  };
}

function knowledgeBase(): KnowledgeBase {
  return {
    id: "kb-1",
    tenant_id: "tenant",
    name: "Legal",
    status: "active",
    tags: [],
    doc_count: 0,
    chunk_count: 0,
    query_count: 0,
    updated_at: "2026-07-22T00:00:00Z",
  };
}

function document(): AdminDocument {
  return {
    doc_id: "doc-1",
    kb_id: "kb-1",
    kb_name: "Legal",
    title: "Policy",
    file_name: "policy.md",
    file_type: "md",
    mime_type: "text/markdown",
    file_size: 8,
    file_sha256: "sha",
    parse_status: "uploaded",
    parse_version: 1,
    chunk_count: 0,
    table_count: 0,
    uploaded_at: "2026-07-22T00:00:00Z",
    updated_at: "2026-07-22T00:00:00Z",
  };
}

function uploadResponse(): unknown {
  return {
    document_id: "doc-1",
    parse_job_id: "job-1",
    title: "Policy",
    file_type: "md",
    parse_status: "uploaded",
    block_count: 0,
    table_count: 0,
    chunk_count: 0,
    storage_key: "key",
  };
}

function reprocessResponse(): Record<string, unknown> {
  return {
    document_id: "doc-1",
    parse_job_id: "job-2",
    parse_status: "uploaded",
    parse_version: 2,
    block_count: 0,
    table_count: 0,
    chunk_count: 0,
    reused_existing_parse: false,
  };
}

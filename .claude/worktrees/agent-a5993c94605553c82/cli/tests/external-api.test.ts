import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { ApiClient } from "../src/api.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const previousToken = process.env.DOCUMIND_API_TOKEN;
afterEach(() => {
  if (previousToken === undefined) delete process.env.DOCUMIND_API_TOKEN;
  else process.env.DOCUMIND_API_TOKEN = previousToken;
});

describe("external API mode", () => {
  test("uses the API token without password login for identity, KB and chat", async () => {
    process.env.DOCUMIND_API_TOKEN = "dm_live_test_secret";
    const requests: Array<{ path: string; authorization: string }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      requests.push({ path: url.pathname, authorization: headers.get("authorization") ?? "" });
      if (url.pathname.endsWith("/api/v1/external/me")) {
        return Response.json({ client_id: "client", client_name: "crm", tenant_id: "tenant", scopes: ["chat:write"], allowed_kb_ids: ["kb"], token_expires_at: "2030-01-01T00:00:00Z" });
      }
      if (url.pathname.endsWith("/api/v1/external/knowledge-bases")) return Response.json([]);
      if (url.pathname.endsWith("/api/v1/external/conversations")) return Response.json({ conversation_id: "conversation", title: "test", updated_at: "now" });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const directory = await mkdtemp(join(tmpdir(), "documind-external-"));
    const api = new ApiClient(structuredClone(DEFAULT_CONFIG), join(directory, "config.toml"), fetcher).enableExternalMode();

    expect((await api.externalMe()).client_name).toBe("crm");
    expect(await api.listKnowledgeBases()).toEqual([]);
    expect((await api.createConversation(["kb"])).conversation_id).toBe("conversation");
    expect(requests.map((request) => request.path)).not.toContain("/api/auth/login");
    expect(requests.every((request) => request.authorization === "Bearer dm_live_test_secret")).toBe(true);
  });

  test("sends current MCP protocol metadata and parses SSE", async () => {
    process.env.DOCUMIND_API_TOKEN = "dm_live_test_secret";
    let request: { headers: Headers; body: { params: { _meta: Record<string, unknown> } } } | null = null;
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      request = {
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as { params: { _meta: Record<string, unknown> } },
      };
      return new Response(
        `data: {"jsonrpc":"2.0","id":"documind-cli","result":{"tools":[]}}

`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;
    const directory = await mkdtemp(join(tmpdir(), "documind-mcp-"));
    const api = new ApiClient(structuredClone(DEFAULT_CONFIG), join(directory, "config.toml"), fetcher);

    expect((await api.mcpCall("tools/list")).result).toEqual({ tools: [] });
    expect(request!.headers.get("Mcp-Method")).toBe("tools/list");
    expect(request!.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
    expect(request!.body.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
  });
});

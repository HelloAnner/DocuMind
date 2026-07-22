import { describe, expect, test } from "bun:test";
import { waitForDocument } from "../src/admin_commands.ts";
import { CliError } from "../src/errors.ts";
import type { AdminDocument, AdminDocumentDetail } from "../src/types.ts";

describe("waitForDocument", () => {
  test("polls until the requested searchable state", async () => {
    const statuses = ["uploaded", "parsing", "embedding", "indexed"];
    let calls = 0;
    const api = {
      getDocument: async (): Promise<AdminDocumentDetail> => {
        const status = statuses[Math.min(calls, statuses.length - 1)] ?? "indexed";
        calls += 1;
        return detail(status);
      },
    };

    const document = await waitForDocument(
      api,
      "doc-1",
      { until: "indexed", timeoutMs: 1000, intervalMs: 1 },
      async () => {},
    );

    expect(document.parse_status).toBe("indexed");
    expect(calls).toBe(4);
  });

  test("fails immediately when parsing reaches an actionable failure state", async () => {
    const api = { getDocument: async () => detail("parse_low_confidence") };

    try {
      await waitForDocument(
        api,
        "doc-2",
        { until: "indexed", timeoutMs: 1000, intervalMs: 1 },
        async () => {},
      );
      throw new Error("expected waitForDocument to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as Error).message).toContain("parse_low_confidence");
    }
  });

  test("can explicitly wait for a low-confidence review state", async () => {
    const api = { getDocument: async () => detail("parse_low_confidence") };
    const document = await waitForDocument(
      api,
      "doc-3",
      { until: "parse_low_confidence", timeoutMs: 1000, intervalMs: 1 },
      async () => {},
    );
    expect(document.parse_status).toBe("parse_low_confidence");
  });
});

function detail(status: string): AdminDocumentDetail {
  const document: AdminDocument = {
    doc_id: "doc",
    kb_id: "kb",
    kb_name: "Knowledge",
    title: "Document",
    file_name: "document.pdf",
    file_type: "pdf",
    mime_type: "application/pdf",
    file_size: 10,
    file_sha256: "sha",
    parse_status: status,
    parse_version: 1,
    chunk_count: 0,
    table_count: 0,
    uploaded_at: "2026-07-22T00:00:00Z",
    updated_at: "2026-07-22T00:00:00Z",
  };
  return {
    document,
    preview: {},
    blocks: [],
    cleaned_blocks: [],
    chunks: [],
    tables: [],
  };
}

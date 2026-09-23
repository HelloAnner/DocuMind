import { describe, expect, test } from "bun:test";
import { evaluateExpectations, loadScenario } from "../src/scenario.ts";
import type { ChatRunReport } from "../src/types.ts";

describe("scenario expectations", () => {
  test("checks answer quality, evidence and timing", () => {
    const assertions = evaluateExpectations(report(), {
      status: "completed",
      confidence: ["high", "medium"],
      citations_min: 1,
      retrievals_min: 2,
      react_rounds_min: 3,
      contains: "30 天",
      not_contains: "不知道",
      max_duration_ms: 10_000,
      files_min: 1,
      file_extensions: [".docx"],
    });
    expect(assertions).toHaveLength(10);
    expect(assertions.every((item) => item.passed)).toBe(true);
  });

  test("verifies that the inputs were modified in place instead of copied", () => {
    const passed = evaluateExpectations(report(), {
      file_ids: ["file"],
      input_files_modified: true,
    }, ["file", "other"]);
    expect(passed).toHaveLength(2);
    expect(passed.every((item) => item.passed)).toBe(true);

    const copied = evaluateExpectations(report(), {
      file_ids: ["other"],
      input_files_modified: true,
    }, ["other"]);
    expect(copied.map((item) => item.passed)).toEqual([false, false]);

    const withScratch = evaluateExpectations(report(), { input_files_modified: true }, ["file"]);
    expect(withScratch[0]!.passed).toBe(true);
  });

  test("loads the deterministic Office runner server scenario", async () => {
    const scenario = await loadScenario("examples/dm-be-files-scenario.json");
    expect(scenario.turns).toHaveLength(4);
    expect(scenario.turns[3]!.expect?.file_extensions).toEqual([".docx"]);
  });
});

function report(): ChatRunReport {
  return {
    schema_version: "documind.cli.chat.v1",
    server: "http://server:8089",
    identity: { user_id: "u", username: "Anner", tenant_id: "t", tenant: "acme" },
    request: {
      conversation_id: "c",
      content: "付款期限？",
      kb_ids: ["kb"],
      client_request_id: "r",
    },
    response: {
      assistant_message_id: "a",
      content: "付款期限为 30 天。",
      status: "completed",
      confidence: "high",
      files: [{
        id: "file",
        name: "result.docx",
        path: "generated/c/a/result.docx",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size_bytes: 100,
        source: "sandbox",
        conversation_id: "c",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        download_url: "/api/files/file/download",
      }],
    },
    timing: { total_ms: 9000 },
    execution: {
      round_source: "runtime_tool_events",
      react_round_count: 4,
      react_rounds: [],
    },
    citations: [{
      index: 1,
      doc_id: "d",
      chunk_id: "chunk",
      doc_title: "合同",
      page_range: [1],
      quote: "30 天",
    }],
    trace: {
      message_id: "a",
      retrieval_traces: [
        { id: "1", message_id: "m", chunk_id: "1", doc_id: "d", source: "dense", rank: 1, score: 1, heading_path: [], page_range: [], content_preview: "a" },
        { id: "2", message_id: "m", chunk_id: "2", doc_id: "d", source: "rerank", rank: 1, score: 1, heading_path: [], page_range: [], content_preview: "b" },
      ],
    },
    events: [],
  };
}

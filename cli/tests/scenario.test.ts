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

  test("rejects in-place claims satisfied only by a new copy of the expected type", () => {
    const scenario = report();
    scenario.response.files = [
      userFile("pptx-input", "in/deck.pptx"),
      userFile("xlsx-copy", "generated/c/a/result.xlsx"),
    ];
    const failed = evaluateExpectations(scenario, {
      input_files_modified: true,
      file_extensions: [".xlsx"],
    }, ["pptx-input"]);
    const inPlace = failed.find((item) => item.field === "input_files_modified");
    expect(inPlace?.passed).toBe(false);
    expect(inPlace?.actual).toMatchObject({
      written_back: ["pptx-input"],
      created: ["xlsx-copy"],
      matched: [],
    });
    // 期望扩展名由新建副本满足，不能算作输入文件被原地修改
    expect(failed.find((item) => item.field === "file_extension:.xlsx")?.passed).toBe(true);
    // 不指定扩展名时保持“任一输入文件被写回”语义
    const relaxed = evaluateExpectations(scenario, { input_files_modified: true }, ["pptx-input"]);
    expect(relaxed[0]!.passed).toBe(true);

    const satisfied = evaluateExpectations({
      ...scenario,
      response: {
        ...scenario.response,
        files: [userFile("xlsx-input", "in/table.xlsx"), userFile("xlsx-copy", "generated/c/a/result.xlsx")],
      },
    }, { input_files_modified: true, file_extensions: [".xlsx"] }, ["xlsx-input"]);
    const matched = satisfied.find((item) => item.field === "input_files_modified");
    expect(matched?.passed).toBe(true);
    expect(matched?.actual).toMatchObject({ matched: [{ file_id: "xlsx-input", suffixes: [".xlsx"] }] });
  });

  test("loads the deterministic Office runner server scenario", async () => {
    const scenario = await loadScenario("examples/dm-be-files-scenario.json");
    expect(scenario.turns).toHaveLength(4);
    expect(scenario.turns[3]!.expect?.file_extensions).toEqual([".docx"]);
  });
});

function userFile(id: string, path: string): ChatRunReport["response"]["files"][number] {
  const name = path.split("/").pop() ?? path;
  return {
    id,
    name,
    path,
    mime_type: "application/octet-stream",
    size_bytes: 100,
    source: "sandbox",
    conversation_id: "c",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    download_url: `/api/files/${id}/download`,
  };
}

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

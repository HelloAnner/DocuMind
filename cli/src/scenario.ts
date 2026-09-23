import { readFile } from "node:fs/promises";
import { ChatService } from "./chat.ts";
import { CliError } from "./errors.ts";
import type {
  AssertionResult,
  ChatRunReport,
  Scenario,
  ScenarioExpectation,
  ScenarioReport,
} from "./types.ts";

export async function loadScenario(path: string): Promise<Scenario> {
  const text = path === "-" ? await Bun.stdin.text() : await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliError(`场景 JSON 无法解析: ${path}`, 2, error);
  }
  validateScenario(parsed);
  return parsed;
}

export interface ScenarioRunOptions {
  onTurn?: (index: number, total: number, content: string) => void;
  /** 命令行 --file-id 提供的文件，应用于未在 turn.file_ids 中单独指定的每一轮。 */
  fileIds?: string[];
  /** 在既有会话中运行；会话文件（file_ids）只有属于该会话时才能在沙箱内读写。 */
  conversationId?: string;
}

export async function runScenario(
  service: ChatService,
  scenario: Scenario,
  options: ScenarioRunOptions = {},
): Promise<ScenarioReport> {
  const { onTurn, fileIds = [], conversationId: requestedConversationId } = options;
  const startedAt = new Date();
  const started = performance.now();
  const conversationKbIds = scenario.conversation?.kb_ids ?? [];
  const conversationId = requestedConversationId ?? scenario.conversation?.id ??
    await service.createConversation(
      conversationKbIds,
      scenario.conversation?.title ?? scenario.name ?? "CLI 场景测试",
    );
  const turns: ScenarioReport["turns"] = [];
  for (const [index, turn] of scenario.turns.entries()) {
    onTurn?.(index, scenario.turns.length, turn.content);
    const turnFileIds = turn.file_ids ?? fileIds;
    const report = await service.send({
      content: turn.content,
      conversation_id: conversationId,
      kb_ids: turn.kb_ids ?? conversationKbIds,
      file_ids: turnFileIds,
    });
    const assertions = evaluateExpectations(report, turn.expect, turnFileIds);
    turns.push({
      report,
      assertions,
      passed: assertions.every((assertion) => assertion.passed),
    });
  }
  return {
    schema_version: "documind.cli.scenario.v1",
    name: scenario.name ?? "DocuMind scenario",
    conversation_id: conversationId,
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: Math.round(performance.now() - started),
    passed: turns.every((turn) => turn.passed),
    turns,
  };
}

export function evaluateExpectations(
  report: ChatRunReport,
  expectation: ScenarioExpectation | undefined,
  inputFileIds: string[] = [],
): AssertionResult[] {
  if (!expectation) return [];
  const assertions: AssertionResult[] = [];
  if (expectation.status !== undefined) {
    assertions.push(assertion("status", expectation.status, report.response.status,
      report.response.status === expectation.status));
  }
  if (expectation.confidence !== undefined) {
    const accepted = array(expectation.confidence);
    assertions.push(assertion(
      "confidence",
      accepted,
      report.response.confidence,
      Boolean(report.response.confidence && accepted.includes(report.response.confidence)),
    ));
  }
  minimum(assertions, "citations_min", expectation.citations_min, report.citations.length);
  minimum(
    assertions,
    "retrievals_min",
    expectation.retrievals_min,
    report.trace.retrieval_traces.length,
  );
  minimum(
    assertions,
    "react_rounds_min",
    expectation.react_rounds_min,
    report.execution.react_round_count,
  );
  minimum(assertions, "files_min", expectation.files_min, report.response.files.length);
  const responseFileIds = report.response.files.map((file) => file.id);
  for (const fileId of expectation.file_ids ?? []) {
    assertions.push(assertion(
      `file_id:${fileId}`,
      fileId,
      responseFileIds,
      responseFileIds.includes(fileId),
    ));
  }
  if (expectation.input_files_modified !== undefined) {
    const created = responseFileIds.filter((fileId) => !inputFileIds.includes(fileId));
    assertions.push(assertion(
      "input_files_modified",
      true,
      { input_file_ids: inputFileIds, returned_file_ids: responseFileIds, created },
      inputFileIds.length > 0 && responseFileIds.length > 0 && created.length === 0,
    ));
  }
  for (const extension of expectation.file_extensions ?? []) {
    const suffix = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
    assertions.push(assertion(
      `file_extension:${suffix}`,
      suffix,
      report.response.files.map((file) => file.path),
      report.response.files.some((file) => file.path.toLowerCase().endsWith(suffix)),
    ));
  }
  if (expectation.max_duration_ms !== undefined) {
    assertions.push(assertion(
      "max_duration_ms",
      expectation.max_duration_ms,
      report.timing.total_ms,
      report.timing.total_ms <= expectation.max_duration_ms,
    ));
  }
  for (const value of array(expectation.contains)) {
    assertions.push(assertion(
      `contains:${value}`,
      value,
      report.response.content,
      report.response.content.includes(value),
    ));
  }
  for (const value of array(expectation.not_contains)) {
    assertions.push(assertion(
      `not_contains:${value}`,
      value,
      report.response.content,
      !report.response.content.includes(value),
    ));
  }
  return assertions;
}

function validateScenario(value: unknown): asserts value is Scenario {
  if (!value || typeof value !== "object") throw new CliError("场景根节点必须是对象", 2);
  const scenario = value as Record<string, unknown>;
  if (!Array.isArray(scenario.turns) || scenario.turns.length === 0) {
    throw new CliError("场景 turns 必须是非空数组", 2);
  }
  for (const [index, item] of scenario.turns.entries()) {
    if (!item || typeof item !== "object" ||
        typeof (item as Record<string, unknown>).content !== "string" ||
        !(item as Record<string, unknown>).content) {
      throw new CliError(`场景 turns[${index}].content 必须是非空字符串`, 2);
    }
    const fileIds = (item as Record<string, unknown>).file_ids;
    if (fileIds !== undefined &&
        (!Array.isArray(fileIds) || fileIds.some((id) => typeof id !== "string" || !id))) {
      throw new CliError(`场景 turns[${index}].file_ids 必须是非空字符串数组`, 2);
    }
    const expectation = (item as Record<string, unknown>).expect;
    if (expectation && typeof expectation === "object") {
      const fields = expectation as Record<string, unknown>;
      if (fields.files_min !== undefined &&
          (!Number.isInteger(fields.files_min) || Number(fields.files_min) < 0)) {
        throw new CliError(`场景 turns[${index}].expect.files_min 必须是非负整数`, 2);
      }
      if (fields.file_extensions !== undefined &&
          (!Array.isArray(fields.file_extensions) ||
            fields.file_extensions.some((extension) => typeof extension !== "string" || !extension))) {
        throw new CliError(
          `场景 turns[${index}].expect.file_extensions 必须是非空字符串数组`, 2,
        );
      }
      if (fields.file_ids !== undefined &&
          (!Array.isArray(fields.file_ids) ||
            fields.file_ids.some((id) => typeof id !== "string" || !id))) {
        throw new CliError(`场景 turns[${index}].expect.file_ids 必须是非空字符串数组`, 2);
      }
      if (fields.input_files_modified !== undefined &&
          typeof fields.input_files_modified !== "boolean") {
        throw new CliError(`场景 turns[${index}].expect.input_files_modified 必须是布尔值`, 2);
      }
    }
  }
}

function assertion(
  field: string,
  expected: unknown,
  actual: unknown,
  passed: boolean,
): AssertionResult {
  return { field, expected, actual, passed };
}

function minimum(
  assertions: AssertionResult[],
  field: string,
  expected: number | undefined,
  actual: number,
): void {
  if (expected === undefined) return;
  assertions.push(assertion(field, expected, actual, actual >= expected));
}

function array(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

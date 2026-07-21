import type {
  AdminDocument,
  AssertionResult,
  ChatRunReport,
  Identity,
  KnowledgeBase,
  ObservedEvent,
  ScenarioReport,
  VectorIndexSummary,
} from "./types.ts";
import type { VectorHit, VectorResult } from "./vector.ts";

const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
const ansi = {
  bold: (value: string) => useColor ? `\u001b[1m${value}\u001b[0m` : value,
  cyan: (value: string) => useColor ? `\u001b[36m${value}\u001b[0m` : value,
  dim: (value: string) => useColor ? `\u001b[2m${value}\u001b[0m` : value,
  green: (value: string) => useColor ? `\u001b[32m${value}\u001b[0m` : value,
  red: (value: string) => useColor ? `\u001b[31m${value}\u001b[0m` : value,
  yellow: (value: string) => useColor ? `\u001b[33m${value}\u001b[0m` : value,
};

export interface HumanChatOptions {
  trace: "off" | "summary" | "full";
  quiet: boolean;
  streamed: boolean;
}

export class LiveChatRenderer {
  private answerStarted = false;
  private readonly seenStarts = new Set<string>();

  constructor(private readonly quiet: boolean) {}

  onEvent(event: ObservedEvent): void {
    if (this.quiet) return;
    const envelope = event.envelope;
    if (!envelope) return;
    if (envelope.event_type === "execution.started") {
      process.stderr.write(`${ansi.dim("连接真实 Agent，开始执行…")}\n`);
      return;
    }
    if (envelope.event_type === "tool.call.started") {
      const id = String(envelope.payload.tool_call_id ?? envelope.step?.step_id ?? "tool");
      if (this.seenStarts.has(id)) return;
      this.seenStarts.add(id);
      const label = toolLabel(id);
      process.stderr.write(`${ansi.cyan("→")} ${label}\n`);
      return;
    }
    if (envelope.event_type === "tool.call.result") {
      const id = String(envelope.payload.tool_call_id ?? envelope.step?.step_id ?? "tool");
      const result = typeof envelope.payload.result === "string" ? envelope.payload.result : "完成";
      process.stderr.write(`${ansi.green("✓")} ${toolLabel(id)} ${ansi.dim(result)}\n`);
    }
  }

  onDelta(text: string): void {
    if (!this.answerStarted && !this.quiet) {
      process.stderr.write(`${ansi.bold("回答")}\n`);
      this.answerStarted = true;
    }
    process.stdout.write(text);
  }
}

export function printChatReport(report: ChatRunReport, options: HumanChatOptions): void {
  if (!options.streamed) process.stdout.write(report.response.content);
  process.stdout.write("\n");
  if (options.quiet || options.trace === "off") return;

  const usage = report.execution.usage;
  const usageText = usage
    ? ` · tokens ${String(usage.prompt_tokens ?? "?")}→${String(usage.completion_tokens ?? "?")}`
    : "";
  process.stdout.write(`\n${ansi.bold("执行摘要")}\n`);
  process.stdout.write(
    `状态 ${statusMark(report.response.status)} ${report.response.status}` +
    ` · 置信度 ${report.response.confidence ?? "-"}` +
    ` · 总耗时 ${formatDuration(report.timing.total_ms)}` +
    ` · 首 token ${formatDuration(report.timing.time_to_first_token_ms)}` +
    `${usageText}\n`,
  );
  process.stdout.write(
    `会话 ${report.request.conversation_id} · 消息 ${report.response.assistant_message_id}\n`,
  );

  process.stdout.write(`\n${ansi.bold(`ReAct / 工具轮次 (${report.execution.react_round_count})`)}\n`);
  if (report.execution.react_rounds.length === 0) {
    process.stdout.write(`${ansi.dim("本次运行未报告工具轮次")}\n`);
  }
  for (const round of report.execution.react_rounds) {
    const mark = round.status === "succeeded" ? ansi.green("✓") :
      round.status === "failed" ? ansi.red("✗") : ansi.yellow("•");
    const result = round.result === undefined ? "" : ` · ${truncate(formatValue(round.result), 120)}`;
    process.stdout.write(
      `${mark} ${round.round}. ${toolLabel(round.name)} · ${formatDuration(round.duration_ms)}${result}\n`,
    );
  }

  const query = report.trace.query_trace;
  const agent = report.trace.agent_trace;
  process.stdout.write(`\n${ansi.bold("查询与规划")}\n`);
  process.stdout.write(`原始查询: ${query?.original_query ?? report.request.content}\n`);
  if (query?.rewritten_query) process.stdout.write(`改写查询: ${query.rewritten_query}\n`);
  if (query?.keywords.length) process.stdout.write(`关键词: ${query.keywords.join(", ")}\n`);
  if (agent) {
    process.stdout.write(`模式: ${agent.mode} (${agent.mode_reason}) · 模型: ${agent.model}\n`);
    for (const [index, item] of agent.retrieval_plan.queries.entries()) {
      process.stdout.write(`计划 ${index + 1}: ${item.query}${item.reason ? ` — ${item.reason}` : ""}\n`);
    }
  }

  const retrievals = report.trace.retrieval_traces;
  const retrievalCounts = countBy(retrievals.map((item) => item.source));
  process.stdout.write(`\n${ansi.bold(`检索轨迹 (${retrievals.length})`)}\n`);
  process.stdout.write(
    `${Object.entries(retrievalCounts).map(([key, value]) => `${key}=${value}`).join(" · ") || "无检索结果"}\n`,
  );
  if (options.trace === "full") {
    for (const item of retrievals) {
      const pages = item.page_range.length ? ` p.${item.page_range.join("-")}` : "";
      process.stdout.write(
        `${item.source.padEnd(6)} #${String(item.rank).padEnd(3)} score=${item.score.toFixed(4)}${pages}` +
        ` · doc=${item.doc_id} · chunk=${item.chunk_id}\n`,
      );
      process.stdout.write(`  ${truncate(item.content_preview.replaceAll(/\s+/g, " "), 220)}\n`);
    }
  }

  process.stdout.write(`\n${ansi.bold(`引用 (${report.citations.length})`)}\n`);
  if (report.citations.length === 0) process.stdout.write(`${ansi.yellow("未返回引用")}\n`);
  for (const citation of report.citations) {
    const pages = citation.page_range.length ? ` · p.${citation.page_range.join("-")}` : "";
    const score = citation.score === undefined ? "" : ` · score=${citation.score.toFixed(4)}`;
    process.stdout.write(
      `[${citation.index}] ${citation.doc_title}${pages}${score} · doc=${citation.doc_id} · chunk=${citation.chunk_id}\n`,
    );
    process.stdout.write(`  ${truncate(citation.quote.replaceAll(/\s+/g, " "), 260)}\n`);
  }
}

export function printIdentity(identity: Identity): void {
  process.stdout.write(`${identity.user.email} (${identity.user.id})\n`);
  process.stdout.write(`租户 ${identity.tenant.name} / ${identity.tenant.slug} (${identity.tenant.id})\n`);
  process.stdout.write(`角色 ${identity.roles.join(", ")}\n`);
  process.stdout.write(`知识库 ${identity.allowed_kb_ids.join(", ") || "无"}\n`);
}

export function printKnowledgeBases(items: KnowledgeBase[]): void {
  printTable(
    ["ID", "名称", "状态", "文档", "分块", "标签"],
    items.map((item) => [
      item.id,
      item.name,
      item.status,
      item.doc_count,
      item.chunk_count,
      item.tags.join(","),
    ]),
  );
}

export function printDocuments(items: AdminDocument[]): void {
  printTable(
    ["ID", "知识库", "标题", "状态", "分块", "质量"],
    items.map((item) => [
      item.doc_id,
      item.kb_name,
      item.title,
      item.parse_status,
      item.chunk_count,
      item.quality_score?.toFixed(2) ?? "-",
    ]),
  );
}

export function printVectorIndexes(items: VectorIndexSummary[]): void {
  printTable(
    ["KB ID", "知识库", "索引", "模型", "维度", "chunks", "embedded", "状态"],
    items.map((item) => [
      item.kb_id,
      item.kb_name,
      item.name,
      item.embedding_model,
      item.dimension,
      item.chunks,
      item.embedded_chunks,
      item.status,
    ]),
  );
}

export function printVectorResult(
  result: VectorResult,
  json: boolean,
  includeEmbedding: boolean,
): void {
  if (json) {
    printJson(result);
    return;
  }
  process.stdout.write(`Elasticsearch took=${result.took_ms}ms total=${result.total} returned=${result.hits.length}\n\n`);
  for (const hit of result.hits) printVectorHit(hit, includeEmbedding);
}

export function printVectorHit(hit: VectorHit, includeEmbedding: boolean): void {
  const source = hit.source;
  process.stdout.write(
    `${String(source.chunk_id ?? hit.id)} · doc=${String(source.doc_id ?? "-")} ` +
    `· kb=${String(source.kb_id ?? "-")} · score=${hit.score ?? "-"}\n`,
  );
  process.stdout.write(`${String(source.doc_title ?? "")} ${String(source.heading_path ?? "")}\n`);
  process.stdout.write(`${String(source.content ?? "")}\n`);
  if (includeEmbedding && Array.isArray(source.embedding)) {
    process.stdout.write(`embedding dim=${source.embedding.length} head=${source.embedding.slice(0, 8).join(", ")}\n`);
  }
  process.stdout.write("\n");
}

export function printScenarioReport(report: ScenarioReport): void {
  process.stdout.write(`${ansi.bold(report.name)}: ${report.passed ? ansi.green("PASS") : ansi.red("FAIL")}\n`);
  process.stdout.write(`会话 ${report.conversation_id} · ${report.turns.length} 轮 · ${formatDuration(report.duration_ms)}\n`);
  for (const [index, turn] of report.turns.entries()) {
    process.stdout.write(
      `\n${index + 1}. ${truncate(turn.report.request.content, 100)} — ` +
      `${turn.passed ? ansi.green("PASS") : ansi.red("FAIL")}\n`,
    );
    process.stdout.write(`   ${truncate(turn.report.response.content.replaceAll(/\s+/g, " "), 180)}\n`);
    for (const assertion of turn.assertions) printAssertion(assertion);
  }
}

function printAssertion(assertion: AssertionResult): void {
  const mark = assertion.passed ? ansi.green("✓") : ansi.red("✗");
  process.stdout.write(
    `   ${mark} ${assertion.field}: expected=${formatValue(assertion.expected)} actual=${formatValue(assertion.actual)}\n`,
  );
}

export function printTable(headers: string[], rows: Array<Array<string | number>>): void {
  if (rows.length === 0) {
    process.stdout.write("(无数据)\n");
    return;
  }
  const widths = headers.map((header, index) => Math.min(
    48,
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)),
  ));
  const line = (values: Array<string | number>) => values.map((value, index) => {
    const width = widths[index] ?? 10;
    const text = truncate(String(value), width);
    return text.padEnd(width);
  }).join("  ").trimEnd();
  process.stdout.write(`${ansi.bold(line(headers))}\n`);
  process.stdout.write(`${widths.map((width) => "-".repeat(width)).join("  ")}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function formatDuration(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)}s`;
}

function statusMark(status: string): string {
  if (status === "completed") return ansi.green("✓");
  if (status === "failed") return ansi.red("✗");
  return ansi.yellow("•");
}

function toolLabel(name: string): string {
  return ({
    query_rewrite: "查询改写",
    hybrid_retrieval: "混合检索",
    rerank: "重排序",
    answer_generation: "答案生成",
  } as Record<string, string>)[name] ?? name;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

// A2A 客户端：读取系统 AgentCard，并以 Portal 一次性票据调用 message/stream(SSE)。
// 契约见 docs/15-a2a/a2a.txt。
import { ApiError, CliError } from "./errors.ts";
import { readSse } from "./sse.ts";

export interface A2ASourceEntry {
  title?: string;
  section?: string;
  doc_id?: string;
  quote?: string;
  page_range?: number[];
  score?: number;
  [key: string]: unknown;
}

export interface A2AAskOptions {
  ticket: string;
  contextId: string;
  text: string;
  timeoutSeconds?: number;
  onStatus?: (message: string) => void;
  onDelta?: (text: string) => void;
}

export interface A2ARunReport {
  schema_version: "documind.cli.a2a.v1";
  server: string;
  context_id: string;
  task_id: string | null;
  statuses: string[];
  text: string;
  sources: unknown[];
  frame_count: number;
}

export class A2AClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  async card(): Promise<Record<string, unknown>> {
    const url = this.url("/.well-known/agent-card.json");
    const response = await this.fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new ApiError("GET", url, response.status, await readBody(response));
    return await response.json() as Record<string, unknown>;
  }

  /** 调用 message/stream，顺序拼接 artifact 正文并收集 sources。 */
  async ask(options: A2AAskOptions): Promise<A2ARunReport> {
    const url = this.url("/a2a");
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/stream",
      params: {
        message: {
          role: "user",
          messageId: crypto.randomUUID(),
          contextId: options.contextId,
          parts: [{ kind: "text", text: options.text }],
        },
      },
    };
    const response = await this.fetcher(url, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${options.ticket}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((options.timeoutSeconds ?? 300) * 1000),
    });
    if (!response.ok) throw a2aHttpError("POST", url, response.status, await readBody(response));
    if (!response.body) throw new CliError("A2A 响应没有 body");

    let text = "";
    let sources: unknown[] = [];
    let taskId: string | null = null;
    let frameCount = 0;
    const statuses: string[] = [];

    for await (const frame of readSse(response)) {
      frameCount += 1;
      if (!frame.data || typeof frame.data !== "object") continue;
      const payload = frame.data as Record<string, unknown>;
      const error = payload.error;
      if (error && typeof error === "object") {
        const record = error as Record<string, unknown>;
        const data = (record.data ?? {}) as Record<string, unknown>;
        const message = typeof record.message === "string" ? record.message : "A2A 处理失败";
        const reason = typeof data.reason === "string" ? data.reason : "a2a_error";
        throw new CliError(`${message}（${reason}）`, 1, {
          reason, link_url: data.link_url, code: record.code,
        });
      }
      const result = (payload.result ?? payload) as Record<string, unknown>;
      const kind = typeof result.kind === "string" ? result.kind : frame.event;
      if (typeof result.id === "string") taskId = result.id;
      if (typeof result.taskId === "string") taskId = result.taskId;
      if (kind === "status-update") {
        const status = result.status as { message?: unknown } | undefined;
        if (typeof status?.message === "string" && status.message !== "") {
          statuses.push(status.message);
          options.onStatus?.(status.message);
        }
        continue;
      }
      if (kind === "artifact-update") {
        const artifact = result.artifact as { parts?: unknown; metadata?: unknown } | undefined;
        const chunk = textOfParts(artifact?.parts);
        if (chunk !== "") {
          text += chunk;
          options.onDelta?.(chunk);
        }
        const metadata = artifact?.metadata as { sources?: unknown } | undefined;
        if (Array.isArray(metadata?.sources)) sources = metadata.sources;
      }
    }

    return {
      schema_version: "documind.cli.a2a.v1",
      server: this.baseUrl,
      context_id: options.contextId,
      task_id: taskId,
      statuses,
      text,
      sources,
      frame_count: frameCount,
    };
  }
}

export function textOfParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => {
    if (!part || typeof part !== "object") return "";
    const record = part as Record<string, unknown>;
    return record.kind === "text" && typeof record.text === "string" ? record.text : "";
  }).join("");
}

export function printAgentCard(card: Record<string, unknown>): void {
  process.stdout.write(`${String(card.name ?? "")} · v${String(card.version ?? "")}\n`);
  if (typeof card.description === "string") process.stdout.write(`${card.description}\n`);
  if (typeof card.url === "string") process.stdout.write(`endpoint ${card.url}\n`);
  const skills = Array.isArray(card.skills) ? card.skills : [];
  for (const skill of skills) {
    if (!skill || typeof skill !== "object") continue;
    const record = skill as Record<string, unknown>;
    process.stdout.write(`- ${String(record.id ?? "")} ${String(record.name ?? "")}\n`);
    const examples = Array.isArray(record.examples) ? record.examples : [];
    for (const example of examples) process.stdout.write(`    e.g. ${String(example)}\n`);
  }
}

export function printA2AReport(report: A2ARunReport): void {
  const sources = report.sources as A2ASourceEntry[];
  if (sources.length > 0) {
    process.stdout.write("\n来源:\n");
    for (const source of sources) {
      const section = source.section ? ` · ${source.section}` : "";
      process.stdout.write(`- ${source.title ?? "未命名文档"}${section}\n`);
    }
  }
  process.stdout.write(`task=${report.task_id ?? "-"} context=${report.context_id} frames=${report.frame_count}\n`);
}

/** HTTP 层 JSON-RPC error：保留 reason / link_url 供 CLI 提示未关联账号。 */
function a2aHttpError(method: string, url: string, status: number, body: unknown): CliError {
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>).error;
    if (error && typeof error === "object") {
      const record = error as Record<string, unknown>;
      const data = (record.data ?? {}) as Record<string, unknown>;
      const reason = typeof data.reason === "string" ? data.reason : "remote_error";
      const message = typeof record.message === "string"
        ? record.message
        : `A2A 返回 HTTP ${status}`;
      return new CliError(`${message}（${reason}）`, 1, {
        type: "A2AError", status, method, url, reason,
        link_url: data.link_url, code: record.code, body,
      });
    }
  }
  return new ApiError(method, url, status, body);
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

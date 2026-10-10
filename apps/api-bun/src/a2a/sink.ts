// A2A 事件适配层：把 pi core 对话内核（Atom/Envelope 事件）映射为 A2A message/stream SSE 帧。
//
// 契约（Portal 客户端已实现，只读 result.*）：
//   task            {kind:"task", id, contextId, status:{state:"submitted"}}
//   status-update   {kind:"status-update", taskId, contextId, final:false, status:{state:"working",message}}
//   artifact-update {kind:"artifact-update", taskId, contextId, append:true,
//                    artifact:{artifactId, parts:[{kind:"text",text}], metadata:{sources:[...]}}}
//   completed       {kind:"status-update", taskId, contextId, final:true, status:{state:"completed"}}
//   error           {jsonrpc,id,error:{code,message,data:{reason}}}
import type { SSEStreamingApi } from 'hono/streaming';
import type { EventSink, OutboundSseEvent } from '../api/conversations_sse.ts';

export interface A2AMeta {
  rpcId: string | number | null;
  taskId: string;
  contextId: string;
}

export interface A2ASource {
  title: string;
  section: string;
  doc_id?: string;
  quote?: string;
  page_range?: number[];
  score?: number;
}

export interface A2AFrame { event: string; data: string; }

/** DocuMind 阶段文案（Portal 显示在 Agent 气泡上方）。 */
const STAGE_MESSAGES: Record<string, string> = {
  rewriting: '正在理解问题',
  query_rewriting: '正在理解问题',
  retrieving: '正在检索文档',
  searching: '正在检索文档',
  reranking: '正在筛选引用',
  generating: '正在生成答案',
  answering: '正在生成答案',
  thinking: '正在思考',
};

/**
 * 纯映射器：输入单个内核事件（event_type + payload），输出 0..n 个 A2A 帧。
 * 持有正文累计与来源累计状态；completed/error 后 done=true，后续事件被丢弃。
 */
export class A2AFrameMapper {
  private text = '';
  private readonly sources: A2ASource[] = [];
  private readonly sourceKeys = new Set<string>();
  private terminal = false;

  constructor(private readonly meta: A2AMeta) {}

  get done(): boolean { return this.terminal; }

  map(eventType: string, payload: unknown): A2AFrame[] {
    if (this.terminal) return [];
    switch (eventType) {
      case 'execution.started':
        return [this.result('task', {
          kind: 'task', id: this.meta.taskId, contextId: this.meta.contextId,
          status: { state: 'submitted' },
        }), this.statusFrame('正在检索文档')];
      case 'response.stage': {
        const message = STAGE_MESSAGES[stringField(payload, 'stage') ?? ''];
        return message === undefined ? [] : [this.statusFrame(message)];
      }
      case 'agent.query_understood':
        return [this.statusFrame('正在理解问题')];
      case 'response.delta': {
        const delta = stringField(payload, 'delta');
        if (!delta) return [];
        this.text += delta;
        return [this.artifactFrame('answer', delta)];
      }
      case 'response.replace': {
        // 内核用 replace 表示"用新正文覆盖已流式内容"（草稿 -> 最终答案）。
        // A2A 用 append:false 表达同一语义，Portal 会重置该消息正文再展示。
        const content = stringField(payload, 'content') ?? '';
        if (content === this.text) return [];
        this.text = content;
        return [this.artifactReplaceFrame('answer', content)];
      }
      case 'sources.reported':
        collectSources(payload, this.sources, this.sourceKeys);
        return [];
      case 'response.completed':
        return this.finish();
      case 'execution.completed':
        return this.finish();
      case 'execution.failed':
        this.terminal = true;
        return [this.errorFrame(failureOf(payload))];
      case 'execution.cancelled':
        this.terminal = true;
        return [this.errorFrame({ code: 'CANCELLED', message: '执行已取消', reason: 'cancelled' })];
      default:
        return [];
    }
  }

  private finish(): A2AFrame[] {
    if (this.terminal) return [];
    this.terminal = true;
    const frames: A2AFrame[] = [];
    if (this.sources.length > 0) {
      frames.push(this.result('artifact-update', {
        kind: 'artifact-update', taskId: this.meta.taskId, contextId: this.meta.contextId,
        append: true,
        artifact: { artifactId: 'sources', parts: [], metadata: { sources: this.sources } },
      }));
    }
    frames.push(this.result('status-update', {
      kind: 'status-update', taskId: this.meta.taskId, contextId: this.meta.contextId,
      final: true, status: { state: 'completed' },
    }));
    return frames;
  }

  private artifactReplaceFrame(artifactId: string, text: string): A2AFrame {
    return this.result('artifact-update', {
      kind: 'artifact-update', taskId: this.meta.taskId, contextId: this.meta.contextId,
      append: false,
      artifact: {
        artifactId,
        parts: [{ kind: 'text', text }],
        metadata: { sources: this.sources },
      },
    });
  }

  private statusFrame(message: string): A2AFrame {
    return this.result('status-update', {
      kind: 'status-update', taskId: this.meta.taskId, contextId: this.meta.contextId,
      final: false, status: { state: 'working', message },
    });
  }

  private artifactFrame(artifactId: string, text: string): A2AFrame {
    return this.result('artifact-update', {
      kind: 'artifact-update', taskId: this.meta.taskId, contextId: this.meta.contextId,
      append: true,
      artifact: {
        artifactId,
        parts: [{ kind: 'text', text }],
        metadata: { sources: this.sources },
      },
    });
  }

  private errorFrame(error: { code?: string; message?: string; reason?: string }): A2AFrame {
    return {
      event: 'error',
      data: JSON.stringify({
        jsonrpc: '2.0', id: this.meta.rpcId,
        error: {
          code: -32000,
          message: error.message ?? '执行失败',
          data: { reason: error.reason ?? 'agent_error' },
        },
      }),
    };
  }

  private result(event: string, result: unknown): A2AFrame {
    return {
      event,
      data: JSON.stringify({ jsonrpc: '2.0', id: this.meta.rpcId, result }),
    };
  }
}

/** 与 SseSink 同构：串行 promise 链保序，写失败只记日志。 */
export class A2ASink implements EventSink {
  private chain: Promise<void> = Promise.resolve();
  private broken = false;
  private readonly mapper: A2AFrameMapper;

  constructor(private readonly stream: SSEStreamingApi, meta: A2AMeta) {
    this.mapper = new A2AFrameMapper(meta);
  }

  send(event: OutboundSseEvent): void {
    if (this.broken || this.mapper.done) return;
    const parsed = parseEvent(event);
    if (parsed === null) return;
    for (const frame of this.mapper.map(parsed.eventType, parsed.payload)) {
      this.chain = this.chain
        .then(() => this.stream.writeSSE({ event: frame.event, data: frame.data }))
        .catch((error: unknown) => {
          this.broken = true;
          console.warn('[documind][a2a] SSE write failed: ' + (error as Error).message);
        });
    }
  }

  flush(): Promise<void> { return this.chain; }
}

export function parseEvent(event: OutboundSseEvent): { eventType: string; payload: unknown } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(event.data); } catch {
    return { eventType: event.event, payload: event.data };
  }
  if (parsed !== null && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (typeof record.event_type === 'string') {
      return { eventType: record.event_type, payload: record.payload ?? {} };
    }
  }
  return { eventType: event.event, payload: parsed };
}

/** 增量下发：previous 是已发送正文，返回 next 中尚未发送的后缀（尽力而为）。 */
export function appendableSuffix(previous: string, next: string): string {
  if (next.startsWith(previous)) return next.slice(previous.length);
  let index = 0;
  const max = Math.min(previous.length, next.length);
  while (index < max && previous[index] === next[index]) index += 1;
  return next.slice(index);
}

function collectSources(payload: unknown, out: A2ASource[], keys: Set<string>): void {
  if (payload === null || typeof payload !== 'object') return;
  const list = (payload as { sources?: unknown }).sources;
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const citation = raw.documind_citation !== null && typeof raw.documind_citation === 'object'
      ? raw.documind_citation as Record<string, unknown>
      : raw;
    const pageRange = Array.isArray(citation.page_range)
      ? citation.page_range.filter((value): value is number => typeof value === 'number')
      : undefined;
    const source: A2ASource = {
      title: stringField(citation, 'doc_title') ?? stringField(raw, 'title') ?? '未命名文档',
      section: sectionOf(pageRange),
    };
    const docId = stringField(citation, 'doc_id') ?? stringField(raw, 'uri');
    if (docId !== undefined) source.doc_id = docId;
    const quote = stringField(citation, 'quote');
    if (quote !== undefined) source.quote = quote;
    if (pageRange !== undefined && pageRange.length > 0) source.page_range = pageRange;
    const score = citation.score;
    if (typeof score === 'number') source.score = score;
    const key = JSON.stringify([source.title, source.section, source.doc_id, source.quote]);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(source);
  }
}

function sectionOf(pageRange: number[] | undefined): string {
  if (pageRange === undefined || pageRange.length === 0) return '';
  const min = Math.min(...pageRange);
  const max = Math.max(...pageRange);
  return min === max ? `第 ${min} 页` : `第 ${min}-${max} 页`;
}

function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function failureOf(payload: unknown): { code?: string; message?: string; reason?: string } {
  if (payload === null || typeof payload !== 'object') return {};
  const error = (payload as Record<string, unknown>).error;
  if (error === null || typeof error !== 'object') return {};
  const record = error as Record<string, unknown>;
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    message: typeof record.message === 'string' ? record.message : undefined,
    reason: typeof record.code === 'string' ? record.code.toLowerCase() : 'agent_error',
  };
}

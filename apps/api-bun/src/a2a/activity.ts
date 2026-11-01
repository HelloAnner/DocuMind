// 公开的工具活动，不包含原始结果、连接信息或隐藏思考。
export interface ActivityStep {
  id: string;
  kind: 'tool';
  tool: string;
  text: string;
  detail?: string;
  result?: string;
  status: 'running' | 'completed' | 'failed';
  started_at: number;
  ended_at?: number;
}

function publicText(value: unknown, limit = 4096): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(/\bBearer\s+[a-z\d._~+\/-]+=*/gi, 'Bearer [已隐藏]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization)["']?\s*[=:]\s*|--(?:password|passwd|secret|token|api[_-]?key)\s+)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏]')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}\n…内容已截断` : text;
}

export function mapToolActivity(event: string, payload: unknown, steps: Map<string, ActivityStep>): ActivityStep | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Record<string, any>;
  if (typeof data.tool_call_id !== 'string' || typeof data.name !== 'string') return null;
  const args = data.arguments ?? {};
  const labels: Record<string, string> = { knowledge_search: '检索知识库', bash: '执行 Shell 命令', skill_read: '加载技能', skill_save: '保存技能', ask_clarification: '确认检索问题' };
  const previous = steps.get(data.tool_call_id);
  const detail = data.name === 'knowledge_search'
    ? publicText((Array.isArray(args.queries) ? args.queries.filter((query: unknown) => typeof query === 'string') : []).join('\n'))
    : data.name === 'bash' ? publicText(args.command)
    : data.name === 'ask_clarification' ? publicText(args.question) : publicText(args.name, 160);
  const step: ActivityStep = {
    id: data.tool_call_id, kind: 'tool', tool: data.name,
    text: labels[data.name] ?? publicText(data.name, 160), detail,
    started_at: Date.now(), ...previous,
    status: event === 'tool.call.started' ? 'running' : event === 'tool.call.failed' ? 'failed' : 'completed',
  };
  if (step.status !== 'running') {
    step.ended_at = Date.now();
    if (step.status === 'failed') step.result = publicText(data.error, 240);
    else {
      const result = data.result ?? {};
      if (typeof result.retrieved_chunk_count === 'number') step.result = `找到 ${result.retrieved_chunk_count} 条证据`;
      else if (typeof result.exit_code === 'number') {
        step.result = `退出码 ${result.exit_code}${Array.isArray(result.files) && result.files.length ? ` · ${result.files.length} 个文件` : ''}`;
        if (result.exit_code !== 0) step.status = 'failed';
      }
      if (typeof result.display_name === 'string') step.detail = publicText(result.display_name, 160);
    }
  }
  steps.set(step.id, step);
  return step;
}

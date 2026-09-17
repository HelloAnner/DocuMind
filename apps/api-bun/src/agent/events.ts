// 移植自 apps/api-rs/src/agent/events.rs
export type AgentProgress =
  | { type: 'status_updated'; status: string }
  | { type: 'rewrite_completed'; rewritten_query: string; keywords: string[] }
  | { type: 'react_step_started'; step: number; action: string; decision_summary: string }
  | { type: 'tool_call_started'; tool_call_id: string; name: string; arguments: unknown }
  | { type: 'tool_call_completed'; tool_call_id: string; name: string; result: unknown }
  | { type: 'tool_call_failed'; tool_call_id: string; name: string; error: unknown }
  | { type: 'retrieval_completed'; chunk_count: number; warnings: string[] }
  | { type: 'rerank_completed'; top_chunk_ids: string[] }
  | { type: 'response_delta'; delta: string }
  | { type: 'response_reset' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'flush'; acknowledgement: () => void };

export type ProgressSender = ((event: AgentProgress) => void) | null;
export function emit(progress: ProgressSender, event: AgentProgress): void {
  if (progress) progress(event);
}

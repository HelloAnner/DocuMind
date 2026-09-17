// 移植自 apps/api-rs/src/agent/stream.rs
import type { AnswerStreamItem } from '../models/agent.ts';

/** AnswerStream 的 TS 形态：替代 tokio mpsc::UnboundedReceiver。 */
export type AnswerStream = AsyncGenerator<AnswerStreamItem>;

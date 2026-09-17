// 移植自 apps/api-rs/src/agent/tools/mod.rs 的 AgentTool 端口
import type { AgentToolDefinition } from '../model.ts';
import type { AgentRequest } from '../../models/agent.ts';
import type { ProgressSender } from '../events.ts';

export interface AgentToolContext {
  request: AgentRequest;
  progress: ProgressSender;
}

export interface AgentTool {
  definition(): AgentToolDefinition;
  execute(argumentsJson: string, context: AgentToolContext): Promise<string>;
  componentName(): string;
}

// 移植自 apps/api-rs/src/agent/tools/registry.rs
import type { AgentToolCall, AgentToolDefinition } from '../model.ts';
import type { AgentTool, AgentToolContext, ToolExecution } from './types.ts';

export class AgentToolRegistry {
  private readonly tools: Map<string, AgentTool>;

  constructor(tools: AgentTool[]) {
    const byName = new Map<string, AgentTool>();
    for (const tool of tools) {
      const name = tool.definition().name;
      if (byName.has(name)) {
        throw new Error(`duplicate agent tool registration: ${name}`);
      }
      byName.set(name, tool);
    }
    this.tools = byName;
  }

  definitions(): AgentToolDefinition[] {
    return [...this.tools.values()]
      .map((tool) => tool.definition())
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  }

  async execute(call: AgentToolCall, context: AgentToolContext): Promise<ToolExecution> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      throw new Error(`model requested unavailable tool: ${call.name}`);
    }
    return tool.execute(call, context);
  }

  componentName(name: string): string | null {
    const tool = this.tools.get(name);
    return tool ? tool.componentName() : null;
  }
}

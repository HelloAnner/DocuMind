// 移植自 apps/api-rs/src/agent/tools/clarification.rs
import type { AgentToolCall, AgentToolDefinition } from '../model.ts';
import type { AgentTool, AgentToolContext, ToolExecution } from './types.ts';

interface ClarificationArguments {
  question: string;
  reason: string;
}

function parseClarificationArguments(argumentsJson: string): ClarificationArguments {
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson);
  } catch (error) {
    throw new Error(`invalid clarification arguments: ${(error as Error).message}`);
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('invalid clarification arguments: expected an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.question !== 'string') {
    throw new Error('invalid clarification arguments: missing field \`question\`');
  }
  if (typeof record.reason !== 'string') {
    throw new Error('invalid clarification arguments: missing field \`reason\`');
  }
  return { question: record.question, reason: record.reason };
}

export class ClarificationTool implements AgentTool {
  definition(): AgentToolDefinition {
    return {
      name: 'ask_clarification',
      description: 'Pause and ask one precise question when the user\'s intent is genuinely ambiguous. Do not use this for missing evidence or uncertain corpus contents.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: {
            type: 'string',
            description: 'One concise user-facing clarification question.',
          },
          reason: {
            type: 'string',
            description: 'Brief operational reason; do not expose hidden reasoning.',
          },
        },
        required: ['question', 'reason'],
      },
    };
  }

  async execute(call: AgentToolCall, _context: AgentToolContext): Promise<ToolExecution> {
    const arguments_ = parseClarificationArguments(call.arguments_json);
    const question = arguments_.question.trim();
    if (question.length === 0) {
      throw new Error('ask_clarification requires a non-empty question');
    }
    return {
      public_result: {
        question: question,
        reason: arguments_.reason,
        status: 'waiting_for_user',
      },
      model_result: {
        status: 'waiting_for_user',
        question: question,
      },
      effect: {
        type: 'terminal',
        terminal: {
          answer: question,
          mode: 'clarifier',
          confidence: 'low',
          no_answer_reason: 'needs_clarification',
        },
      },
    };
  }

  componentName(): string {
    return 'builtin-ask-clarification-v1';
  }
}

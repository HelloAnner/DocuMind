// 移植自 apps/api-rs/src/conversation_title.rs
import { completePiText, type PiModelSettings } from './agent/pi/model.ts';
import type { ConversationRepository } from './repositories/types.ts';
import type { ConversationMessage } from './models/message.ts';

const MAX_TITLE_CHARS = 10;
const UPDATE_INTERVAL = 4;
const FIRST_RECURRING_UPDATE = 3;
const RECENT_TURNS = 3;
const TITLE_TIMEOUT_MS = 12_000;

const TITLE_SYSTEM_PROMPT = `你是专业的会话标题生成器。请为对话生成简洁的中文标题。

规则：
1. 标题不超过 10 个字
2. 提炼核心主题或用户意图
3. 使用名词短语
4. 不使用标点、引号或书名号
5. 只输出标题，不要解释`;

export function spawnTitleUpdate(
  repository: ConversationRepository,
  settings: PiModelSettings,
  tenantId: string,
  userId: string,
  conversationId: string,
): Promise<string | null> {
  return generateAndUpdateTitle(repository, settings, tenantId, userId, conversationId)
    .catch((error: unknown) => {
      console.warn(`[documind][title] conversation ${conversationId} title generation failed: ${(error as Error).message}`);
      return null;
    });
}

async function generateAndUpdateTitle(
  repository: ConversationRepository,
  settings: PiModelSettings,
  tenantId: string,
  userId: string,
  conversationId: string,
): Promise<string | null> {
  const session = await repository.getSession(tenantId, conversationId);
  if (!session || session.user_id !== userId) return null;
  const messages = await repository.getMessages(tenantId, conversationId);
  const userMessageCount = messages.filter((message) => message.role === 'user').length;
  if (!shouldGenerateTitle(userMessageCount)) return null;
  if (userMessageCount === 1 && session.title.trim() !== '新会话') return null;

  const prompt = userMessageCount === 1
    ? (() => {
        const firstMessage = messages
          .find((message) => message.role === 'user');
        const content = firstMessage ? truncateChars(firstMessage.content, 500) : '';
        return `请为以下用户消息生成一个 10 字以内的中文标题：\n\n用户消息：\n${content}\n\n请直接输出标题：`;
      })()
    : `请根据以下对话生成一个 10 字以内的中文标题：\n\n${recentConversation(messages)}\n\n请直接输出标题：`;

  const fallback = normalizeTitle(
    messages.find((message) => message.role === 'user')?.content ?? '',
  ) ?? '新会话';
  let timer: NodeJS.Timeout | undefined;
  let title = fallback;
  try {
    const response = await Promise.race([
      completePiText(
        { ...settings, temperature: 0.2, maxTokens: 32, thinkingEnabled: false },
        TITLE_SYSTEM_PROMPT,
        prompt,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('title generation timed out')), TITLE_TIMEOUT_MS);
      }),
    ]);
    title = normalizeTitle(response) ?? fallback;
  } catch (error) {
    console.warn(
      `[documind][title] conversation ${conversationId} model generation failed, using fallback: ${(error as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
  const updated = await repository.updateSessionTitle(
    tenantId, userId, conversationId, title, false);
  return updated ? title : null;
}

export function shouldGenerateTitle(userMessageCount: number): boolean {
  return userMessageCount === 1
    || (userMessageCount >= FIRST_RECURRING_UPDATE
      && (userMessageCount - FIRST_RECURRING_UPDATE) % UPDATE_INTERVAL === 0);
}

function recentConversation(messages: ConversationMessage[]): string {
  const recent: ConversationMessage[] = [];
  let userCount = 0;
  const candidates = messages.filter((message) =>
    message.role === 'user'
    || (message.role === 'assistant' && message.status === 'completed'));
  for (const message of candidates.reverse()) {
    recent.push(message);
    if (message.role === 'user') {
      userCount += 1;
      if (userCount === RECENT_TURNS) break;
    }
  }
  recent.reverse();
  return recent
    .map((message) => {
      const role = message.role === 'user' ? '用户' : '助手';
      return `${role}：${truncateChars(message.content, 200)}`;
    })
    .join('\n');
}

export function normalizeTitle(raw: string): string | null {
  const firstLine = raw.split(/\r?\n/)[0];
  if (firstLine === undefined) return null;
  const clean = firstLine.trim()
    .replace(/^["'“”‘’《》。！？、：:；;]+|["'“”‘’《》。！？、：:；;]+$/gu, '')
    .replace(/^(?:标题|会话标题)\s*[:：]\s*/u, '')
    .replace(/^["'“”‘’《》。！？、：:；;]+/u, '')
    .replace(/^(?:请帮我|帮我|请问|请|麻烦)\s*/u, '')
    .replace(/^(?:总结|分析|统计|查询|列出|说明|介绍|查看|对比)\s*/u, '')
    .replace(/["'“”‘’《》。！？、：:；;]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (clean.length === 0) return null;
  return truncateChars(clean, MAX_TITLE_CHARS);
}

function truncateChars(value: string, limit: number): string {
  return [...value].slice(0, limit).join('');
}

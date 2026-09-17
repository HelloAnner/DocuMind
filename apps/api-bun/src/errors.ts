// 移植自 apps/api-rs/src/error.rs —— HTTP 错误契约（状态码 + {code,message} JSON）
import type { StatusCode } from 'hono/utils/http-status';

export type ErrorKind =
  | 'not_found' | 'forbidden' | 'conflict' | 'invalid_state' | 'timeout'
  | 'internal' | 'bad_request' | 'unauthorized';

export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly httpStatus: StatusCode;

  private constructor(kind: ErrorKind, httpStatus: StatusCode, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.code = code;
  }

  static notFound(code: string, message: string): AppError { return new AppError('not_found', 404, code, message); }
  static forbiddenWith(code: string, message: string): AppError { return new AppError('forbidden', 403, code, message); }
  static conflictWith(code: string, message: string): AppError { return new AppError('conflict', 409, code, message); }
  static invalidState(code: string, message: string): AppError { return new AppError('invalid_state', 409, code, message); }
  static timeoutWith(code: string, message: string): AppError { return new AppError('timeout', 504, code, message); }
  static internal(message: string): AppError { return new AppError('internal', 500, 'INTERNAL_ERROR', message); }
  static badRequest(code: string, message: string): AppError { return new AppError('bad_request', 400, code, message); }
  static unauthorizedWith(code: string, message: string): AppError { return new AppError('unauthorized', 401, code, message); }

  static conversationNotFound(): AppError {
    return AppError.notFound('CONVERSATION_NOT_FOUND', '会话不存在或无权限');
  }
  static messageNotFound(): AppError {
    return AppError.notFound('MESSAGE_NOT_FOUND', '消息不存在或无权限');
  }
  static kbScopeDenied(): AppError {
    return AppError.forbiddenWith('KB_SCOPE_DENIED', '请求知识库超出用户权限');
  }
  static clientRequestConflict(): AppError {
    return AppError.conflictWith('CLIENT_REQUEST_CONFLICT', '幂等 ID 冲突');
  }
  static invalidMessageState(): AppError {
    return AppError.invalidState('INVALID_MESSAGE_STATE', '当前状态不允许该操作');
  }
  static pipelineTimeout(): AppError {
    return AppError.timeoutWith('PIPELINE_TIMEOUT', 'RAG 管线超时');
  }
  static llmTimeout(): AppError {
    return AppError.timeoutWith('LLM_TIMEOUT', 'LLM 生成超时');
  }
  static forbidden(): AppError {
    return AppError.forbiddenWith('FORBIDDEN', '当前身份无权执行该操作');
  }
  static unauthorized(): AppError {
    return AppError.unauthorizedWith('UNAUTHORIZED', '请先登录');
  }

  toBody(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

/** 将任意未知错误收敛为 AppError；已知 AppError 原样返回。 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) return AppError.internal(error.message);
  return AppError.internal(String(error));
}

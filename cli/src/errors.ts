export class CliError extends Error {
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(message: string, exitCode = 1, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class ApiError extends CliError {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly body: unknown;

  constructor(method: string, url: string, status: number, body: unknown) {
    const detail = apiErrorMessage(body);
    super(`API ${method} ${url} 返回 ${status}${detail ? `: ${detail}` : ""}`, 1, body);
    this.name = "ApiError";
    this.status = status;
    this.method = method;
    this.url = url;
    this.body = body;
  }
}

function apiErrorMessage(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 500);
  if (!body || typeof body !== "object") return "";
  const value = body as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      if (typeof nested.message === "string") return nested.message;
    }
  }
  return "";
}

export function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof ApiError) {
    return {
      type: error.name,
      message: error.message,
      status: error.status,
      method: error.method,
      url: error.url,
      body: error.body,
    };
  }
  if (error instanceof CliError) {
    return { type: error.name, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { type: error.name, message: error.message };
  }
  return { type: "UnknownError", message: String(error) };
}

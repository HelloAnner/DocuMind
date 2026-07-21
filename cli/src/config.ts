import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { CliError } from "./errors.ts";
import type { CliConfig, SessionState } from "./types.ts";

export const DEFAULT_CONFIG: CliConfig = {
  version: 1,
  server: {
    url: "http://123.57.255.204:8089",
    base_path: "",
    timeout_seconds: 300,
  },
  auth: {
    username: "Anner",
    password: "",
    password_env: "DOCUMIND_PASSWORD",
    tenant: "acme",
  },
  chat: {
    kb_ids: [],
    trace: "full",
    stream: true,
  },
  diagnostics: {
    ssh_host: "documind",
    elasticsearch_url: "http://127.0.0.1:8104",
    elasticsearch_index: "chunks",
  },
};

export function configPath(override?: string): string {
  if (override) return resolve(override);
  if (process.env.DOCUMIND_CONFIG) return resolve(process.env.DOCUMIND_CONFIG);
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "documind", "config.toml");
}

export function sessionPath(path: string): string {
  return join(dirname(path), "session.json");
}

export function parseConfig(text: string): CliConfig {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new CliError("TOML 配置无法解析", 2, error);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CliError("TOML 配置根节点必须是对象", 2);
  }
  const value = parsed as Record<string, unknown>;
  const server = objectValue(value.server, "server");
  const auth = objectValue(value.auth, "auth");
  const chat = optionalObjectValue(value.chat);
  const diagnostics = optionalObjectValue(value.diagnostics);
  const trace = stringValue(chat.trace, DEFAULT_CONFIG.chat.trace);
  if (!(["off", "summary", "full"] as string[]).includes(trace)) {
    throw new CliError("chat.trace 只能是 off、summary 或 full", 2);
  }

  const config: CliConfig = {
    version: numberValue(value.version, 1),
    server: {
      url: stringValue(server.url, ""),
      base_path: stringValue(server.base_path, ""),
      timeout_seconds: numberValue(server.timeout_seconds, 300),
    },
    auth: {
      username: stringValue(auth.username, ""),
      password: stringValue(auth.password, ""),
      password_env: stringValue(auth.password_env, "DOCUMIND_PASSWORD"),
      tenant: stringValue(auth.tenant, ""),
    },
    chat: {
      kb_ids: stringArrayValue(chat.kb_ids),
      trace: trace as CliConfig["chat"]["trace"],
      stream: booleanValue(chat.stream, true),
    },
    diagnostics: {
      ssh_host: stringValue(diagnostics.ssh_host, ""),
      elasticsearch_url: stringValue(diagnostics.elasticsearch_url, ""),
      elasticsearch_index: stringValue(diagnostics.elasticsearch_index, "chunks"),
    },
  };
  validateConfig(config);
  return config;
}

export async function loadConfig(path: string): Promise<CliConfig> {
  try {
    return parseConfig(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(`配置不存在: ${path}\n先运行 documind init`, 2);
    }
    throw error;
  }
}

export interface InitConfigOptions {
  url?: string;
  basePath?: string;
  username?: string;
  password?: string;
  passwordEnv?: string;
  tenant?: string;
  sshHost?: string;
  force?: boolean;
}

export async function initializeConfig(
  path: string,
  options: InitConfigOptions,
): Promise<CliConfig> {
  if (!options.force && await Bun.file(path).exists()) {
    throw new CliError(`配置已存在: ${path}（使用 --force 覆盖）`, 2);
  }
  const config: CliConfig = structuredClone(DEFAULT_CONFIG);
  if (options.url !== undefined) config.server.url = options.url;
  if (options.basePath !== undefined) config.server.base_path = options.basePath;
  if (options.username !== undefined) config.auth.username = options.username;
  if (options.password !== undefined) config.auth.password = options.password;
  if (options.passwordEnv !== undefined) config.auth.password_env = options.passwordEnv;
  if (options.tenant !== undefined) config.auth.tenant = options.tenant;
  if (options.sshHost !== undefined) config.diagnostics.ssh_host = options.sshHost;
  validateConfig(config);
  await atomicWrite(path, serializeConfig(config), 0o600);
  return config;
}

export function serializeConfig(config: CliConfig): string {
  return `# DocuMind CLI 配置。此文件权限应保持为 0600。\n` +
    `# 推荐通过 auth.password_env 指定的环境变量提供密码。\n` +
    `version = ${config.version}\n\n` +
    `[server]\n` +
    `url = ${tomlString(config.server.url)}\n` +
    `base_path = ${tomlString(config.server.base_path)}\n` +
    `timeout_seconds = ${config.server.timeout_seconds}\n\n` +
    `[auth]\n` +
    `username = ${tomlString(config.auth.username)}\n` +
    `password = ${tomlString(config.auth.password)}\n` +
    `password_env = ${tomlString(config.auth.password_env)}\n` +
    `tenant = ${tomlString(config.auth.tenant)}\n\n` +
    `[chat]\n` +
    `kb_ids = [${config.chat.kb_ids.map(tomlString).join(", ")}]\n` +
    `trace = ${tomlString(config.chat.trace)}\n` +
    `stream = ${config.chat.stream}\n\n` +
    `[diagnostics]\n` +
    `ssh_host = ${tomlString(config.diagnostics.ssh_host)}\n` +
    `elasticsearch_url = ${tomlString(config.diagnostics.elasticsearch_url)}\n` +
    `elasticsearch_index = ${tomlString(config.diagnostics.elasticsearch_index)}\n`;
}

export async function readSession(path: string): Promise<SessionState> {
  try {
    const text = await readFile(sessionPath(path), "utf8");
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed as SessionState : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new CliError("session.json 已损坏，请执行 auth logout", 2);
    throw error;
  }
}

export async function writeSession(path: string, state: SessionState): Promise<void> {
  await atomicWrite(sessionPath(path), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export async function clearSession(path: string): Promise<void> {
  await rm(sessionPath(path), { force: true });
}

export function configuredPassword(config: CliConfig): string {
  const envName = config.auth.password_env.trim();
  const fromEnvironment = envName ? process.env[envName] : undefined;
  const password = fromEnvironment ?? config.auth.password;
  if (!password) {
    throw new CliError(
      `缺少登录密码：设置环境变量 ${envName || "DOCUMIND_PASSWORD"}，或填写 auth.password`,
      2,
    );
  }
  return password;
}

export function redactedConfig(config: CliConfig): Record<string, unknown> {
  return {
    ...config,
    auth: {
      ...config.auth,
      password: config.auth.password ? "***" : "",
    },
  };
}

function validateConfig(config: CliConfig): void {
  let url: URL;
  try {
    url = new URL(config.server.url);
  } catch {
    throw new CliError("server.url 必须是有效 URL", 2);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError("server.url 只支持 http 或 https", 2);
  }
  if (!config.auth.username.trim()) throw new CliError("auth.username 不能为空", 2);
  if (!config.auth.tenant.trim()) throw new CliError("auth.tenant 不能为空", 2);
  if (!Number.isFinite(config.server.timeout_seconds) || config.server.timeout_seconds < 1) {
    throw new CliError("server.timeout_seconds 必须大于 0", 2);
  }
  if (config.diagnostics.elasticsearch_index &&
      !/^[a-zA-Z0-9_.-]+$/.test(config.diagnostics.elasticsearch_index)) {
    throw new CliError("diagnostics.elasticsearch_index 包含非法字符", 2);
  }
  if (config.diagnostics.ssh_host &&
      !/^[a-zA-Z0-9_.@:-]+$/.test(config.diagnostics.ssh_host)) {
    throw new CliError("diagnostics.ssh_host 包含非法字符", 2);
  }
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`缺少 [${name}] 配置`, 2);
  }
  return value as Record<string, unknown>;
}

function optionalObjectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (value.some((item) => typeof item !== "string")) {
    throw new CliError("chat.kb_ids 必须是字符串数组", 2);
  }
  return value as string[];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
    await chmod(path, mode);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

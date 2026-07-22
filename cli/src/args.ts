import { CliError } from "./errors.ts";

export type OptionValue = string | boolean | string[];

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, OptionValue>;
}

const BOOLEAN_OPTIONS = new Set([
  "accessible",
  "continue",
  "events",
  "force",
  "full",
  "help",
  "include-embedding",
  "interactive",
  "json",
  "ndjson",
  "quiet",
  "raw",
  "stream",
  "traces",
  "version",
  "wait",
]);

const SHORT_OPTIONS: Record<string, string> = {
  c: "conversation",
  e: "events",
  h: "help",
  i: "interactive",
  j: "json",
  k: "kb",
  q: "quiet",
  t: "trace",
  V: "version",
};

const REPEATABLE_OPTIONS = new Set(["doc", "kb", "tag"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, OptionValue> = {};
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (positionalOnly || token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }

    if (token.startsWith("--no-")) {
      options[token.slice(5)] = false;
      continue;
    }

    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = token.slice(2, equals === -1 ? undefined : equals);
      if (!name) throw new CliError(`无效参数: ${token}`, 2);
      if (equals !== -1) {
        assignOption(options, name, token.slice(equals + 1));
        continue;
      }
      if (BOOLEAN_OPTIONS.has(name)) {
        options[name] = true;
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError(`参数 --${name} 需要值`, 2);
      }
      assignOption(options, name, value);
      index += 1;
      continue;
    }

    const short = token.slice(1);
    if (short.length !== 1 || !SHORT_OPTIONS[short]) {
      throw new CliError(`未知短参数: ${token}`, 2);
    }
    const name = SHORT_OPTIONS[short];
    if (name === undefined) throw new CliError(`未知短参数: ${token}`, 2);
    if (BOOLEAN_OPTIONS.has(name)) {
      options[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`参数 ${token} 需要值`, 2);
    }
    assignOption(options, name, value);
    index += 1;
  }

  return { positionals, options };
}

function assignOption(
  options: Record<string, OptionValue>,
  name: string,
  value: string,
): void {
  if (!REPEATABLE_OPTIONS.has(name)) {
    options[name] = value;
    return;
  }
  const previous = options[name];
  if (Array.isArray(previous)) {
    previous.push(value);
  } else if (typeof previous === "string") {
    options[name] = [previous, value];
  } else {
    options[name] = [value];
  }
}

export function stringOption(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.at(-1);
  return undefined;
}

export function booleanOption(
  args: ParsedArgs,
  name: string,
  fallback = false,
): boolean {
  const value = args.options[name];
  return typeof value === "boolean" ? value : fallback;
}

export function numberOption(
  args: ParsedArgs,
  name: string,
  fallback: number,
  bounds?: { min?: number; max?: number },
): number {
  const raw = stringOption(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new CliError(`--${name} 必须是数字`, 2);
  if (bounds?.min !== undefined && value < bounds.min) {
    throw new CliError(`--${name} 不能小于 ${bounds.min}`, 2);
  }
  if (bounds?.max !== undefined && value > bounds.max) {
    throw new CliError(`--${name} 不能大于 ${bounds.max}`, 2);
  }
  return value;
}

export function listOption(args: ParsedArgs, name: string): string[] {
  const value = args.options[name];
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return values.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
}

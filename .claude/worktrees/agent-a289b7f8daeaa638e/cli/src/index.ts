#!/usr/bin/env bun

import { parseArgs } from "./args.ts";
import { dispatch } from "./commands.ts";
import { CliError, errorDetails } from "./errors.ts";

async function main(): Promise<void> {
  let json = process.argv.includes("--json") || process.argv.includes("-j");
  try {
    const args = parseArgs(process.argv.slice(2));
    json = args.options.json === true || json;
    process.exitCode = await dispatch(args);
  } catch (error) {
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    process.exitCode = exitCode;
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: errorDetails(error) }, null, 2)}\n`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`documind: ${message}\n`);
    if (error instanceof CliError && error.details !== undefined && process.env.DOCUMIND_DEBUG) {
      process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    }
  }
}

await main();

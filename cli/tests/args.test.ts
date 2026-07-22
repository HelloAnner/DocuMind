import { describe, expect, test } from "bun:test";
import {
  booleanOption,
  listOption,
  numberOption,
  parseArgs,
  stringOption,
} from "../src/args.ts";

describe("parseArgs", () => {
  test("parses commands, aliases and repeatable KB scopes", () => {
    const args = parseArgs([
      "chat",
      "采购合同的付款条件？",
      "-j",
      "--kb",
      "kb-1,kb-2",
      "-k",
      "kb-3",
      "--trace=full",
    ]);
    expect(args.positionals).toEqual(["chat", "采购合同的付款条件？"]);
    expect(booleanOption(args, "json")).toBe(true);
    expect(listOption(args, "kb")).toEqual(["kb-1", "kb-2", "kb-3"]);
    expect(stringOption(args, "trace")).toBe("full");
  });

  test("supports explicit negative boolean and bounded numbers", () => {
    const args = parseArgs(["vector", "list", "--no-stream", "--limit", "25"]);
    expect(booleanOption(args, "stream", true)).toBe(false);
    expect(numberOption(args, "limit", 10, { min: 1, max: 100 })).toBe(25);
  });

  test("rejects missing option values", () => {
    expect(() => parseArgs(["chat", "--conversation"])).toThrow("需要值");
  });

  test("parses repeatable document and knowledge-base management options", () => {
    const args = parseArgs([
      "documents",
      "retry-batch",
      "--doc",
      "doc-1,doc-2",
      "--doc",
      "doc-3",
      "--wait",
    ]);
    expect(listOption(args, "doc")).toEqual(["doc-1", "doc-2", "doc-3"]);
    expect(booleanOption(args, "wait")).toBe(true);
  });
});

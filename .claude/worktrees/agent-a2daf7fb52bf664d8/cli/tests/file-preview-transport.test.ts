import { describe, expect, test } from "bun:test";
import { assertRangedPreview } from "../src/admin_commands.ts";
import { CliError } from "../src/errors.ts";
import type { FilePreviewTransport } from "../src/types.ts";

function transport(range: Partial<FilePreviewTransport["range"]> = {}): FilePreviewTransport {
  return {
    preview: {},
    manifest: {},
    signed: {},
    range: {
      status: 206,
      content_type: "application/pdf",
      content_range: "bytes 0-63/9915",
      accept_ranges: "bytes",
      byte_length: 64,
      head: "%PDF-",
      ...range,
    },
  };
}

describe("assertRangedPreview", () => {
  test("accepts a full ranged PDF response", () => {
    expect(() => assertRangedPreview(transport())).not.toThrow();
  });

  test("rejects responses that cannot serve byte ranges", () => {
    const broken: Partial<FilePreviewTransport["range"]>[] = [
      { status: 200, content_range: "" },
      { accept_ranges: "" },
      { content_range: "bytes */9915" },
      { byte_length: 0 },
    ];
    for (const range of broken) {
      expect(() => assertRangedPreview(transport(range))).toThrow(CliError);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { SseParser } from "../src/sse.ts";

describe("SseParser", () => {
  test("parses fragmented atom events", () => {
    const parser = new SseParser();
    expect(parser.feed("event: response.delta\nid: evt-1\nda")).toEqual([]);
    expect(parser.feed("ta: {\"payload\":{\"delta\":\"你好\"}}\n\n")).toEqual([
      {
        event: "response.delta",
        id: "evt-1",
        data: { payload: { delta: "你好" } },
      },
    ]);
  });

  test("joins multiline data and flushes an unterminated final frame", () => {
    const parser = new SseParser();
    parser.feed("event: debug\ndata: first\ndata: second");
    expect(parser.finish()).toEqual([{ event: "debug", data: "first\nsecond" }]);
  });

  test("ignores comments", () => {
    const parser = new SseParser();
    expect(parser.feed(": heartbeat\n\n")).toEqual([]);
  });
});

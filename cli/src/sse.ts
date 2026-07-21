import { CliError } from "./errors.ts";
import type { SseFrame } from "./types.ts";

export class SseParser {
  private buffer = "";
  private event = "";
  private id: string | undefined;
  private data: string[] = [];

  feed(chunk: string): SseFrame[] {
    this.buffer += chunk.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const frames: SseFrame[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const frame = this.consumeLine(line);
      if (frame) frames.push(frame);
      newline = this.buffer.indexOf("\n");
    }
    return frames;
  }

  finish(): SseFrame[] {
    const frames: SseFrame[] = [];
    if (this.buffer) {
      const frame = this.consumeLine(this.buffer);
      if (frame) frames.push(frame);
      this.buffer = "";
    }
    const frame = this.dispatch();
    if (frame) frames.push(frame);
    return frames;
  }

  private consumeLine(line: string): SseFrame | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    if (field === "id") this.id = value;
    if (field === "data") this.data.push(value);
    return undefined;
  }

  private dispatch(): SseFrame | undefined {
    if (!this.event && this.data.length === 0) {
      this.id = undefined;
      return undefined;
    }
    const raw = this.data.join("\n");
    let data: unknown = raw;
    if (raw) {
      try {
        data = JSON.parse(raw) as unknown;
      } catch {
        data = raw;
      }
    }
    const frame: SseFrame = {
      event: this.event || "message",
      data,
      ...(this.id ? { id: this.id } : {}),
    };
    this.event = "";
    this.id = undefined;
    this.data = [];
    return frame;
  }
}

export async function* readSse(response: Response): AsyncGenerator<SseFrame> {
  if (!response.body) throw new CliError("SSE 响应不可读");
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.feed(decoder.decode(value, { stream: true }))) yield frame;
    }
    const tail = decoder.decode();
    if (tail) {
      for (const frame of parser.feed(tail)) yield frame;
    }
    for (const frame of parser.finish()) yield frame;
  } finally {
    reader.releaseLock();
  }
}

import type { SSEEvent } from "./types";

export async function* streamSse(
  url: string,
  body: unknown
): AsyncGenerator<SSEEvent, void, unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new Error(`SSE request failed: ${response.status} ${text}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response body is not readable");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let currentData = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (currentData) {
          currentData += "\n" + payload;
        } else {
          currentData = payload;
        }
      } else if (line.trim() === "") {
        if (currentData || currentEvent) {
          let parsed: unknown = currentData;
          if (currentData) {
            try {
              parsed = JSON.parse(currentData);
            } catch {
              // leave as raw string
            }
          }
          yield { event: currentEvent || "message", data: parsed };
          currentEvent = "";
          currentData = "";
        }
      }
    }
  }

  // Flush remaining event
  if (currentData || currentEvent) {
    let parsed: unknown = currentData;
    if (currentData) {
      try {
        parsed = JSON.parse(currentData);
      } catch {
        // leave as raw string
      }
    }
    yield { event: currentEvent || "message", data: parsed };
  }
}

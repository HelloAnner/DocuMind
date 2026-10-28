// CLI A2A 客户端契约测试：AgentCard 读取、message/stream 流式归一化、错误映射。
import { describe, expect, test } from "bun:test";
import { A2AClient, textOfParts } from "../src/a2a.ts";
import { CliError } from "../src/errors.ts";

describe("a2a card", () => {
  test("读取 /.well-known/agent-card.json", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({
        name: "Documind 文档 Agent", description: "企业文档问答系统", url: "http://x/a2a",
        version: "1.0.0", capabilities: { streaming: true },
        skills: [{ id: "document-qa", name: "文档检索问答", description: "", examples: ["差旅报销标准"] }],
      }),
    });
    try {
      const card = await new A2AClient(`http://127.0.0.1:${server.port}`).card();
      expect(card.name).toBe("Documind 文档 Agent");
      expect((card.skills as unknown[]).length).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

describe("a2a ask", () => {
  test("消费 message/stream 并拼接正文/来源", async () => {
    const frames: Array<[string, unknown]> = [
      ["task", { jsonrpc: "2.0", id: "rpc-1", result: { kind: "task", id: "t1", contextId: "ctx-1", status: { state: "submitted" } } }],
      ["status-update", { jsonrpc: "2.0", id: "rpc-1", result: { kind: "status-update", taskId: "t1", contextId: "ctx-1", final: false, status: { state: "working", message: "正在检索文档" } } }],
      ["artifact-update", { jsonrpc: "2.0", id: "rpc-1", result: { kind: "artifact-update", taskId: "t1", contextId: "ctx-1", append: true, artifact: { artifactId: "answer", parts: [{ kind: "text", text: "差旅标准为" }] } } }],
      ["artifact-update", { jsonrpc: "2.0", id: "rpc-1", result: { kind: "artifact-update", taskId: "t1", contextId: "ctx-1", append: true, artifact: { artifactId: "answer", parts: [{ kind: "text", text: "每晚 500 元" }] } } }],
      ["artifact-update", { jsonrpc: "2.0", id: "rpc-1", result: { kind: "artifact-update", taskId: "t1", contextId: "ctx-1", append: true, artifact: { artifactId: "sources", parts: [], metadata: { sources: [{ title: "差旅制度.pdf", section: "第 3 页" }] } } } }],
      ["status-update", { jsonrpc: "2.0", id: "rpc-1", result: { kind: "status-update", taskId: "t1", contextId: "ctx-1", final: true, status: { state: "completed" } } }],
    ];
    let seenAuth: string | null = null;
    let seenBody: Record<string, unknown> | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seenAuth = req.headers.get("authorization");
        seenBody = await req.json() as Record<string, unknown>;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            for (const [event, payload] of frames) {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const client = new A2AClient(`http://127.0.0.1:${server.port}`);
      const statuses: string[] = [];
      const deltas: string[] = [];
      const report = await client.ask({
        ticket: "ticket-1", contextId: "ctx-1", text: "@Documind 差旅标准",
        onStatus: (message) => statuses.push(message),
        onDelta: (chunk) => deltas.push(chunk),
      });
      expect(report.text).toBe("差旅标准为每晚 500 元");
      expect(deltas.join("")).toBe(report.text);
      expect(statuses).toEqual(["正在检索文档"]);
      expect(report.sources).toHaveLength(1);
      expect((report.sources[0] as { title: string }).title).toBe("差旅制度.pdf");
      expect(report.task_id).toBe("t1");
      expect(report.context_id).toBe("ctx-1");
      expect(report.frame_count).toBe(6);
      expect(seenAuth as string | null).toBe("Bearer ticket-1");
      const params = seenBody as unknown as { params: { message: { parts: Array<{ text: string }> } } };
      expect(params.params.message.parts[0]!.text).toBe("@Documind 差旅标准");
    } finally {
      server.stop(true);
    }
  });

  test("HTTP 409 account_not_linked 抛出可读错误", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({
        jsonrpc: "2.0", id: "x",
        error: { code: -32001, message: "门户账号尚未关联",
          data: { reason: "account_not_linked", link_url: "https://portal/api/portal/systems/documind/enter" } },
      }, { status: 409 }),
    });
    try {
      const client = new A2AClient(`http://127.0.0.1:${server.port}`);
      let caught: unknown;
      try {
        await client.ask({ ticket: "t", contextId: "c", text: "q" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CliError);
      expect((caught as CliError).message).toContain("门户账号尚未关联");
      const details = (caught as CliError).details as Record<string, unknown>;
      expect(details.reason).toBe("account_not_linked");
      expect(details.link_url).toContain("/api/portal/systems/documind/enter");
    } finally {
      server.stop(true);
    }
  });

  test("流内 event: error 终止并抛出", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              "event: error\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: "x",
                error: { code: -32000, message: "执行失败", data: { reason: "pipeline_error" } } }) + "\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const client = new A2AClient(`http://127.0.0.1:${server.port}`);
      await expect(client.ask({ ticket: "t", contextId: "c", text: "q" })).rejects.toThrow("执行失败");
    } finally {
      server.stop(true);
    }
  });
});

describe("textOfParts", () => {
  test("只拼接 kind=text 片段", () => {
    expect(textOfParts([{ kind: "text", text: "a" }, { kind: "image" }, { kind: "text", text: "b" }])).toBe("ab");
    expect(textOfParts(undefined)).toBe("");
  });
});
